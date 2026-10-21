// Watcher runtime (DESIGN section 10). Three jobs, all server-side:
//   1. keep every watch backed by exactly one cron job (idempotent rebuild, DB intent first, cron second);
//   2. authenticate a background turn as ours (section 10.2). The host does not pass `jobId` to `before_prompt_build`
//      (spike 4, 2026-10-14), so the identity comes from the `cron_changed` hook: a `started` event carries the real job id
//      and the session it targets. A turn is ours only when exactly ONE started-and-unclaimed job exists for its session,
//      that job is a watch of ours, and its watch id equals the marker in the prompt. Anything else that carries our marker
//      is treated as a stale or forged Nexus job and gets no tools at all (fail closed);
//   3. turn a miss into an attempt and an exhausted watch into a decision the user can see.
import type { EventBridge } from "./events.js";
import { NEXUS_WATCHER_PROTOCOL, renderWatchBrief } from "./prompt.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import type { WatchRecord } from "./store/watch-types.js";

export const WATCH_MARKER_PREFIX = "[nexus:watch:";
const WATCH_ID_RE = /\[nexus:watch:(W[0-9A-Z]{10})\]/u;
const NEXUS_JOB_PREFIX = "plugin:nexus-agent-core:tag:nexus-watch-";
const PENDING_TTL_MS = 15 * 60_000;
const SESSION_TARGET_PREFIX = "session:";

/** Tools a watcher turn may see: reads, the ledger write path, and the report. Operators may add read-only extras. */
export const WATCHER_BASE_TOOLS = [
  "nexus_task_get",
  "nexus_task_search",
  "nexus_task_note",
  "nexus_claim_verify",
  "nexus_evidence_add",
  "nexus_watch_report",
] as const;
export const DEFAULT_WATCHER_EXTRA_TOOLS = ["web_fetch", "web_search"] as const;

/**
 * The only host tools a watcher turn may ever be given beyond WATCHER_BASE_TOOLS. A watcher turn reads untrusted web
 * content, so this list is owned here and is not extensible through config (DESIGN section 10.2): a config value outside
 * it (exec, browser, channel send, ...) is dropped, not trusted.
 */
export const WATCHER_EXTRA_TOOL_ALLOWLIST: readonly string[] = ["web_fetch", "web_search"];

export function resolveWatcherExtraTools(configured: readonly string[] | undefined): {
  tools: string[];
  rejected: string[];
} {
  const wanted = configured ?? DEFAULT_WATCHER_EXTRA_TOOLS;
  const tools: string[] = [];
  const rejected: string[] = [];
  for (const name of wanted) {
    if (WATCHER_EXTRA_TOOL_ALLOWLIST.includes(name)) {
      if (!tools.includes(name)) {
        tools.push(name);
      }
    } else {
      rejected.push(name);
    }
  }
  return { tools, rejected };
}

export function buildWatchMessage(watch: Pick<WatchRecord, "id" | "taskId">): string {
  return `${WATCH_MARKER_PREFIX}${watch.id}] Nexus re-check: Task ${watch.taskId}. Follow the [Nexus re-check turn] protocol and finish with exactly one call to nexus_watch_report.`;
}

export function readWatchMarker(prompt: unknown): string | undefined {
  return typeof prompt === "string" ? WATCH_ID_RE.exec(prompt)?.[1] : undefined;
}

export function isNexusWatchJobName(name: unknown): boolean {
  return typeof name === "string" && name.startsWith(NEXUS_JOB_PREFIX);
}

export type CronChangedLike = {
  action: string;
  jobId: string;
  sessionTarget?: string;
  job?: { name?: string; sessionTarget?: string } | undefined;
  status?: string;
};

export type PromptCtxLike = {
  runId?: string;
  sessionKey?: string;
  trigger?: string;
  agentId?: string;
};

export type WatchSchedulerPort = {
  schedule(params: {
    sessionKey: string;
    delayMs: number;
    message: string;
    name: string;
    tag: string;
  }): Promise<{ id: string } | undefined>;
  unscheduleByTag(params: {
    sessionKey: string;
    tag: string;
  }): Promise<{ removed: number; failed: number }>;
};

export type WatchRuntimeDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  scheduler: WatchSchedulerPort;
  /** Called with the ctx once a turn is authenticated, so the run's trigger row can carry the watch id. */
  recordTrigger: (ctx: PromptCtxLike & { jobId?: string; watchId?: string }) => Promise<void>;
  onOutboxWritten?: () => void;
  logger: {
    info(message: string): void;
    warn(message: string): void;
    debug?(message: string): void;
  };
  extraTools?: readonly string[];
  now?: () => number;
  /** How long a prompt waits for the host's `started` event before it fails closed. */
  claimWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Process-wide state in production (`getSharedWatchState()`); a fresh one per runtime in tests. */
  state?: WatchSharedState;
};

type Pending = {
  jobId: string;
  sessionKey: string;
  name: string | undefined;
  startedAt: number;
  claimed: boolean;
};

/**
 * In-memory state that must be ONE per process. The host loads the plugin more than once (the gateway log shows a `full` and a
 * `discovery` registration, and the dev run of 2026-10-14 showed `cron_changed` and `before_prompt_build` being delivered to
 * different registrations), so a closure-local Map made the `started` job invisible to the prompt hook. The database is
 * shared by every instance; this part is not, hence the process-wide holder (same pattern as the shared spike recorder).
 */
export type WatchSharedState = {
  pending: Map<string, Pending>;
  syncing: Promise<void> | undefined;
};
const SHARED_WATCH_STATE = Symbol.for("nexus-agent-core.watch-runtime.state");

export function createWatchSharedState(): WatchSharedState {
  return { pending: new Map(), syncing: undefined };
}

export function getSharedWatchState(): WatchSharedState {
  const holder = globalThis as { [SHARED_WATCH_STATE]?: WatchSharedState };
  return (holder[SHARED_WATCH_STATE] ??= createWatchSharedState());
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createWatchRuntime(deps: WatchRuntimeDeps) {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const claimWaitMs = deps.claimWaitMs ?? 2_000;
  const allowedTools = [
    ...WATCHER_BASE_TOOLS,
    ...resolveWatcherExtraTools(deps.extraTools).tools.filter(
      (name) => !(WATCHER_BASE_TOOLS as readonly string[]).includes(name),
    ),
  ];
  const state = deps.state ?? createWatchSharedState();
  const pending = state.pending;

  const gc = () => {
    const cutoff = now() - PENDING_TTL_MS;
    for (const [jobId, entry] of pending) {
      if (entry.startedAt < cutoff) {
        pending.delete(jobId);
      }
    }
  };
  const sessionOf = (event: CronChangedLike): string | undefined => {
    const target = event.sessionTarget ?? event.job?.sessionTarget;
    return typeof target === "string" && target.startsWith(SESSION_TARGET_PREFIX)
      ? target.slice(SESSION_TARGET_PREFIX.length)
      : undefined;
  };

  const emit = (principal: Principal, watch: WatchRecord, change: string) =>
    deps.events.watchChanged({
      ownerId: principal.ownerId,
      watchId: watch.id,
      taskId: watch.taskId,
      status: watch.status,
      change,
      attempts: watch.attempts,
    });

  /** Fail closed: a turn that carries our marker but cannot be proven ours gets no tools and a one-line no-op. */
  const failClosed = (why: string) => {
    deps.logger.warn(`nexus: watcher turn rejected (${why}); no tools offered`);
    return {
      toolsAllow: [] as string[],
      prependContext:
        "[Nexus] This re-check could not be authenticated and was rejected. Do nothing and reply only with OK.",
    };
  };

  // ---- cron_changed: the host's own statement of which job is running ----
  async function onCronChanged(event: CronChangedLike): Promise<void> {
    try {
      if (event.action === "started" || event.action === "finished") {
        deps.logger.debug?.(`nexus: cron_changed ${event.action} job=${event.jobId}`);
      }
      if (event.action === "started") {
        const sessionKey = sessionOf(event);
        deps.logger.info(
          `nexus: cron_changed started (job=${event.jobId} session=${sessionKey ?? "-"} nexus=${isNexusWatchJobName(event.job?.name)} name=${String(event.job?.name ?? "-").slice(0, 60)})`,
        );
        if (sessionKey) {
          gc();
          pending.set(event.jobId, {
            jobId: event.jobId,
            sessionKey,
            name: event.job?.name,
            startedAt: now(),
            claimed: false,
          });
        }
        return;
      }
      if (event.action === "finished" || event.action === "removed") {
        if (pending.delete(event.jobId)) {
          deps.logger.info(
            `nexus: watch cron job ${event.action} (job=${event.jobId} status=${String(event.status ?? "-")})`,
          );
        }
      }
      if (event.action !== "finished") {
        return;
      }
      const principal = deps.resolvePrincipal({});
      if (!principal) {
        return;
      }
      const store = await deps.getStore();
      const out = await store.watchJobFinished({ principal, jobId: event.jobId, now: now() });
      if (out.outcome === "noop") {
        return;
      }
      emit(principal, out.watch, out.outcome === "exhausted" ? "exhausted" : "missed");
      if (out.outcome === "exhausted") {
        await escalate(principal, out.watch);
      }
    } catch (error) {
      deps.logger.warn(`nexus: watch cron handler failed: ${messageOf(error)}`);
    }
  }

  // ---- before_prompt_build: authenticate-as-claim ----
  async function authenticate(
    event: { prompt?: unknown },
    ctx: PromptCtxLike,
  ): Promise<
    { prependSystemContext?: string; prependContext?: string; toolsAllow: string[] } | undefined
  > {
    const markerWatchId = readWatchMarker(event.prompt);
    if (!markerWatchId) {
      // Nothing of ours in the prompt: another plugin's cron job or a heartbeat. Not our business.
      return undefined;
    }
    const sessionKey = ctx.sessionKey;
    const principal = deps.resolvePrincipal(ctx);
    deps.logger.info(
      `nexus: watcher prompt seen (watch=${markerWatchId} session=${sessionKey ?? "?"} run=${ctx.runId ?? "?"} pending=${[...pending.values()].map((entry) => `${entry.jobId}@${entry.sessionKey}${entry.claimed ? "*" : ""}`).join(",") || "-"})`,
    );
    if (!sessionKey || !principal) {
      return failClosed("no session or owner");
    }
    // The host's `started` event is detached from the run: give it a moment before deciding there is no job.
    const deadline = now() + claimWaitMs;
    let candidates: Pending[] = [];
    for (;;) {
      candidates = [...pending.values()].filter(
        (entry) => entry.sessionKey === sessionKey && !entry.claimed,
      );
      if (candidates.length > 0 || now() >= deadline) {
        break;
      }
      await sleep(50);
    }
    if (candidates.length !== 1) {
      return failClosed(
        candidates.length === 0 ? "no started job for this session" : "ambiguous started jobs",
      );
    }
    const entry = candidates[0] as Pending;
    // Take it before any await: one started job authenticates at most one turn.
    entry.claimed = true;
    try {
      const store = await deps.getStore();
      const known = await store.watchGet({ principal, jobId: entry.jobId });
      if (!known) {
        if (isNexusWatchJobName(entry.name)) {
          // A job of ours whose watch is gone (Task purged, watch deleted): remove it and run nothing.
          void cleanupStale(entry);
        }
        return failClosed("job is not a watch of ours");
      }
      if (known.id !== markerWatchId) {
        return failClosed("prompt marker does not match the job's watch");
      }
      const claimed = await store.watchClaim({
        principal,
        jobId: entry.jobId,
        sessionKey,
        now: now(),
      });
      if (claimed.outcome !== "claimed") {
        return failClosed(
          claimed.outcome === "unknown_job" ? "unknown job" : `stale watch (${claimed.reason})`,
        );
      }
      await deps.recordTrigger({ ...ctx, jobId: entry.jobId, watchId: claimed.watch.id });
      emit(principal, claimed.watch, "firing");
      return {
        prependSystemContext: NEXUS_WATCHER_PROTOCOL,
        prependContext: renderWatchBrief({
          watchId: claimed.watch.id,
          taskId: claimed.watch.taskId,
          taskTitle: claimed.task.title,
          claimId: claimed.watch.claimId,
          expect: claimed.watch.expect,
          attempt: claimed.watch.attempts,
          maxAttempts: claimed.watch.maxAttempts,
        }),
        toolsAllow: [...allowedTools],
      };
    } catch (error) {
      return failClosed(`store error: ${messageOf(error)}`);
    }
  }

  async function cleanupStale(entry: Pending): Promise<void> {
    const tag = entry.name?.slice("plugin:nexus-agent-core:tag:".length).split(":")[0];
    if (!tag) {
      return;
    }
    try {
      await deps.scheduler.unscheduleByTag({ sessionKey: entry.sessionKey, tag });
    } catch (error) {
      deps.logger.warn(`nexus: could not remove stale watch job: ${messageOf(error)}`);
    }
  }

  // ---- tool phase: nexus_watch_report is only valid inside a turn that was authenticated as a watcher ----
  async function beforeToolCall(
    event: { toolName: string; params: Record<string, unknown>; runId?: string },
    ctx: { agentId?: string; sessionKey?: string; runId?: string },
  ): Promise<{ block: true; blockReason: string } | undefined> {
    if (event.toolName !== "nexus_watch_report") {
      return undefined;
    }
    const block = (blockReason: string) => ({ block: true as const, blockReason });
    const runId = event.runId ?? ctx.runId;
    const principal = deps.resolvePrincipal(ctx);
    if (!runId || !ctx.sessionKey || !principal) {
      return block("nexus_watch_report is only available inside a Nexus re-check turn.");
    }
    try {
      const store = await deps.getStore();
      const trigger = await store.readRunTrigger({
        principal,
        runId,
        sessionKey: ctx.sessionKey,
        now: now(),
      });
      const wanted = typeof event.params.watchId === "string" ? event.params.watchId.trim() : "";
      if (trigger?.trigger === "cron" && trigger.watchId && trigger.watchId === wanted) {
        return undefined;
      }
    } catch (error) {
      deps.logger.warn(`nexus: watch report gate failed: ${messageOf(error)}`);
    }
    return block(
      "nexus_watch_report is only available inside a Nexus re-check turn for that watch.",
    );
  }

  /** What follows a watch change made through a tool or RPC: schedule, unschedule, escalate. */
  async function afterChange(
    principal: Principal,
    change:
      | { kind: "created"; watch: WatchRecord }
      | { kind: "cancelled"; watch: WatchRecord }
      | {
          kind: "reported";
          watch: WatchRecord;
          outcome: "satisfied" | "rescheduled" | "exhausted";
        },
  ): Promise<void> {
    if (change.kind === "cancelled") {
      await deps.scheduler
        .unscheduleByTag({ sessionKey: change.watch.sessionKey, tag: change.watch.cronTag })
        .catch((error: unknown) =>
          deps.logger.warn(`nexus: could not remove watch job: ${messageOf(error)}`),
        );
    }
    if (change.kind === "reported" && change.outcome === "exhausted") {
      await escalate(principal, change.watch).catch((error: unknown) =>
        deps.logger.warn(`nexus: could not escalate watch ${change.watch.id}: ${messageOf(error)}`),
      );
    }
    void sync();
  }

  // ---- scheduling and maintenance ----
  async function escalate(principal: Principal, watch: WatchRecord): Promise<void> {
    const store = await deps.getStore();
    // One acknowledge decision per exhausted watch: the key is fixed, so replays return the same decision.
    const created = await store.createDecision({
      principal,
      taskId: watch.taskId,
      effectKind: "acknowledge",
      actionIds: [],
      sessionKey: watch.sessionKey,
      runId: `watch:${watch.id}`,
      toolCallId: "exhausted",
      now: now(),
    });
    if (created.outcome === "created") {
      deps.events.taskChanged("updated", created.task);
      deps.onOutboxWritten?.();
    } else if (created.outcome === "replayed" && created.noticeEnqueued) {
      deps.onOutboxWritten?.();
    }
  }

  async function scheduleOne(principal: Principal, watch: WatchRecord): Promise<boolean> {
    const store = await deps.getStore();
    // Remove whatever the previous revision left behind first: scheduling is not idempotent, unscheduling by tag is.
    await deps.scheduler.unscheduleByTag({ sessionKey: watch.sessionKey, tag: watch.cronTag });
    const handle = await deps.scheduler.schedule({
      sessionKey: watch.sessionKey,
      delayMs: Math.max(5_000, watch.nextCheckAt - now()),
      message: buildWatchMessage(watch),
      name: `nexus-watch-${watch.id}-r${watch.revision}`,
      tag: watch.cronTag,
    });
    if (!handle) {
      return false;
    }
    const marked = await store.watchMarkScheduled({
      principal,
      watchId: watch.id,
      revision: watch.revision,
      jobId: handle.id,
      now: now(),
    });
    if (marked.outcome !== "scheduled") {
      // Cancelled or rebuilt while we were scheduling: the job we just made belongs to nobody.
      await deps.scheduler.unscheduleByTag({ sessionKey: watch.sessionKey, tag: watch.cronTag });
      return false;
    }
    emit(principal, marked.watch, "scheduled");
    return true;
  }

  /** One pass: close what must close, count misses, escalate exhausted watches, (re)build missing cron jobs. */
  async function sync(options: { healExhausted?: boolean } = {}): Promise<void> {
    if (state.syncing) {
      return state.syncing;
    }
    state.syncing = (async () => {
      const principal = deps.resolvePrincipal({});
      if (!principal) {
        return;
      }
      const store = await deps.getStore();
      const maintained = await store.watchMaintain({ principal, now: now() });
      for (const watch of maintained.cancelled) {
        emit(principal, watch, "cancelled");
        await deps.scheduler
          .unscheduleByTag({ sessionKey: watch.sessionKey, tag: watch.cronTag })
          .catch((error: unknown) =>
            deps.logger.warn(`nexus: could not remove watch job: ${messageOf(error)}`),
          );
      }
      for (const watch of maintained.rescheduled) {
        emit(principal, watch, "rescheduled");
      }
      for (const watch of maintained.exhausted) {
        emit(principal, watch, "exhausted");
        await escalate(principal, watch).catch((error: unknown) =>
          deps.logger.warn(`nexus: could not escalate watch ${watch.id}: ${messageOf(error)}`),
        );
      }
      // Newly exhausted watches are escalated by whoever exhausted them (report, cron finish) and by the pass below; at
      // service start every exhausted watch of an open Task is replayed too: idempotent, heals a crash between the two.
      const exhausted = options.healExhausted
        ? await store.watchList({
            principal,
            statuses: ["exhausted"],
            openTasksOnly: true,
            limit: 20,
          })
        : [];
      for (const watch of exhausted) {
        await escalate(principal, watch).catch((error: unknown) =>
          deps.logger.warn(`nexus: could not escalate watch ${watch.id}: ${messageOf(error)}`),
        );
      }
      const todo = await store.watchListUnscheduled({ principal, limit: 20 });
      for (const watch of todo) {
        try {
          await scheduleOne(principal, watch);
        } catch (error) {
          deps.logger.warn(`nexus: could not schedule watch ${watch.id}: ${messageOf(error)}`);
        }
      }
    })()
      .catch((error: unknown) => deps.logger.warn(`nexus: watch sync failed: ${messageOf(error)}`))
      .finally(() => {
        state.syncing = undefined;
      });
    return state.syncing;
  }

  return {
    authenticate,
    onCronChanged,
    beforeToolCall,
    afterChange,
    sync,
    escalate,
    /** For tests and diagnostics. */
    pendingCount: () => pending.size,
    allowedTools: () => [...allowedTools],
  };
}

export type WatchRuntime = ReturnType<typeof createWatchRuntime>;
