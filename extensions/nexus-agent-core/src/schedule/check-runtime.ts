// Check-turn runtime (design 4.5.3, W4b): the part that makes a background turn "ours". Same idea as the watcher runtime
// (watch-runtime.ts): the host does not pass a job id to `before_prompt_build`, so identity comes from the `cron_changed`
// `started` event (the real job id and the session it targets). A turn is ours only when
//   * it carries `[nexus:check:<triggerId>]`,
//   * exactly ONE started-and-unclaimed check job of ours exists for its session, and
//   * the store says that job is the one recorded for exactly that trigger (still `scheduled`, schedule still active).
// Anything else that carries our marker gets no tools at all (fail closed). The report tool is gated to the claimed run.
import { NEXUS_CHECK_PROTOCOL, renderCheckBrief } from "../prompt.js";
import type { TaskStore } from "../store/host.js";
import type { Principal } from "../store/types.js";
import { resolveWatcherExtraTools } from "../watch-runtime.js";
import { CHECK_MARKER_PREFIX } from "./dispatcher.js";

const CHECK_ID_RE = /\[nexus:check:([A-Za-z0-9_]{1,64})\]/u;
const CHECK_JOB_PREFIX = "plugin:nexus-agent-core:tag:nexus-check-";
const PENDING_TTL_MS = 15 * 60_000;
const SESSION_TARGET_PREFIX = "session:";

/** Tools a check turn may see: read the Task, add a note to it, the report, and the same read-only web tools a watcher gets. */
export const CHECK_BASE_TOOLS = [
  "nexus_task_get",
  "nexus_task_note",
  "nexus_schedule_check_report",
] as const;

export type CheckCronEvent = {
  action: string;
  jobId: string;
  sessionTarget?: string;
  job?: { name?: string; sessionTarget?: string } | undefined;
  status?: string;
  error?: string;
};

export type CheckPromptCtx = {
  runId?: string;
  sessionKey?: string;
  trigger?: string;
  agentId?: string;
};

type CheckTurnGrant = {
  prependSystemContext: string;
  prependContext: string;
  toolsAllow: string[];
};
/** `grant` is what the one authenticated run was given: the same run asking again (a retry) gets it again. */
type Pending = {
  jobId: string;
  sessionKey: string;
  startedAt: number;
  claimed: boolean;
  grant?: { runId: string; triggerId: string; result: CheckTurnGrant };
};

/** One per process: the host loads the plugin more than once and routes hooks to different registrations. */
export type CheckSharedState = { pending: Map<string, Pending> };
const SHARED = Symbol.for("nexus-agent-core.schedule.check-runtime.state");
export function getSharedCheckState(): CheckSharedState {
  const root = globalThis as { [SHARED]?: CheckSharedState };
  return (root[SHARED] ??= { pending: new Map() });
}

export type CheckRuntimeDeps = {
  getStore: () => Promise<TaskStore>;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  /** Binds the run to its trigger kind for the tool phase of the decision runtime (same as a watcher turn). */
  recordTrigger?: (ctx: CheckPromptCtx & { jobId?: string }) => Promise<void>;
  logger: { info(message: string): void; warn(message: string): void };
  extraTools?: readonly string[];
  now?: () => number;
  claimWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  state?: CheckSharedState;
  onChanged?: (taskId: string | null) => void;
};

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function readCheckMarker(prompt: unknown): string | undefined {
  return typeof prompt === "string" ? CHECK_ID_RE.exec(prompt)?.[1] : undefined;
}

export function createCheckRuntime(deps: CheckRuntimeDeps) {
  const now = deps.now ?? Date.now;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const claimWaitMs = deps.claimWaitMs ?? 2_000;
  const state = deps.state ?? { pending: new Map<string, Pending>() };
  const pending = state.pending;
  const allowedTools = [...CHECK_BASE_TOOLS, ...resolveWatcherExtraTools(deps.extraTools).tools];

  const gc = () => {
    const cutoff = now() - PENDING_TTL_MS;
    for (const [jobId, entry] of pending) {
      if (entry.startedAt < cutoff) {
        pending.delete(jobId);
      }
    }
  };
  const sessionOf = (event: CheckCronEvent): string | undefined => {
    const target = event.sessionTarget ?? event.job?.sessionTarget;
    return typeof target === "string" && target.startsWith(SESSION_TARGET_PREFIX)
      ? target.slice(SESSION_TARGET_PREFIX.length)
      : undefined;
  };
  /** What the host says about how the job ended: kept with the failure so a missing report can be explained. */
  const detailOf = (event: CheckCronEvent): string => {
    const parts = [
      event.status ? `status=${event.status}` : "",
      event.error ? `error=${String(event.error).replace(/\s+/g, " ").slice(0, 160)}` : "",
    ].filter(Boolean);
    return parts.join("; ");
  };
  const failClosed = (why: string) => {
    deps.logger.warn(`nexus: follow-up check turn rejected (${why}); no tools offered`);
    return {
      toolsAllow: [] as string[],
      prependContext:
        "[Nexus] This follow-up check could not be authenticated and was rejected. Do nothing and reply only with OK.",
    };
  };

  /** The host's own statement of which job is running (cron_changed). Only our check jobs are remembered. */
  async function onCronChanged(event: CheckCronEvent): Promise<void> {
    try {
      const name = event.job?.name;
      const ours = typeof name === "string" && name.startsWith(CHECK_JOB_PREFIX);
      if (event.action === "started") {
        const sessionKey = sessionOf(event);
        deps.logger.info(
          `nexus: check cron_changed started (job=${event.jobId} session=${sessionKey ?? "-"} ours=${ours} name=${(name ?? "-").slice(0, 60)})`,
        );
        if (ours && sessionKey) {
          gc();
          pending.set(event.jobId, {
            jobId: event.jobId,
            sessionKey,
            startedAt: now(),
            claimed: false,
          });
        }
        return;
      }
      if (event.action !== "finished" && event.action !== "removed") {
        return;
      }
      if (pending.delete(event.jobId)) {
        deps.logger.info(
          `nexus: check cron job ${event.action} (job=${event.jobId} ${detailOf(event) || "status=-"})`,
        );
      }
      // Only `finished` says the turn is over, as in the watcher. A one-shot job may be removed by the host while its turn
      // is still running (deleteAfterRun); failing the check then would close it before the model could report. A job that
      // never finishes is closed by the grace-time expiry instead.
      if (event.action !== "finished") {
        return;
      }
      // Whether the job is a check's is the store's call (by job id): this registration may never have seen it start.
      const principal = deps.resolvePrincipal({});
      if (!principal) {
        return;
      }
      const store = await deps.getStore();
      const detail = detailOf(event);
      const out = await store.scheduleCheckJobEnded({
        principal,
        jobId: event.jobId,
        ...(detail ? { detail } : {}),
        now: now(),
      });
      if (out.outcome === "failed") {
        deps.logger.warn(
          `nexus: follow-up check ${out.trigger.id} ended without a report (job=${event.jobId} ${detail || "status=-"})`,
        );
        deps.onChanged?.(out.trigger.taskId);
      }
    } catch (error) {
      deps.logger.warn(`nexus: check cron handler failed: ${messageOf(error)}`);
    }
  }

  /** before_prompt_build, background turns only: ours (tools + brief), forged (nothing), or not a check (undefined). */
  async function authenticate(
    event: { prompt?: unknown },
    ctx: CheckPromptCtx,
  ): Promise<
    { prependSystemContext?: string; prependContext?: string; toolsAllow: string[] } | undefined
  > {
    const triggerId = readCheckMarker(event.prompt);
    if (!triggerId) {
      return undefined;
    }
    const sessionKey = ctx.sessionKey;
    const principal = deps.resolvePrincipal(ctx);
    if (!sessionKey || !principal || !ctx.runId) {
      return failClosed("no session, run or owner");
    }
    // The host retries a failed model call (same model again, or the next fallback model) as a new prompt build of the SAME run:
    // that run has already proven it is this job's turn, so it gets the same grant. Another run never does.
    const sameRun = [...pending.values()].find(
      (entry) =>
        entry.claimed &&
        entry.sessionKey.toLowerCase() === sessionKey.toLowerCase() &&
        entry.grant?.runId === ctx.runId &&
        entry.grant.triggerId === triggerId,
    );
    if (sameRun?.grant) {
      deps.logger.info(
        `nexus: check turn re-authenticated for a retry of the same run (job=${sameRun.jobId} trigger=${triggerId})`,
      );
      return { ...sameRun.grant.result, toolsAllow: [...allowedTools] };
    }
    // The host's `started` event is detached from the run: give it a moment before deciding there is no job.
    const deadline = now() + claimWaitMs;
    let candidates: Pending[] = [];
    for (;;) {
      candidates = [...pending.values()].filter(
        (entry) => entry.sessionKey.toLowerCase() === sessionKey.toLowerCase() && !entry.claimed,
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
      const claimed = await store.scheduleCheckClaim({
        principal,
        jobId: entry.jobId,
        sessionKey,
        markerTriggerId: triggerId,
        runId: ctx.runId,
        now: now(),
      });
      if (claimed.outcome !== "claimed") {
        return failClosed(
          claimed.outcome === "refused"
            ? `check refused (${claimed.reason})`
            : `not claimable (${claimed.outcome})`,
        );
      }
      await deps.recordTrigger?.({ ...ctx, jobId: entry.jobId });
      deps.onChanged?.(claimed.brief.taskId);
      const result: CheckTurnGrant = {
        prependSystemContext: NEXUS_CHECK_PROTOCOL,
        prependContext: renderCheckBrief({
          triggerId: claimed.brief.triggerId,
          taskId: claimed.brief.taskId,
          purpose: claimed.brief.purpose,
          ownerType: claimed.brief.ownerType,
          ownerText: claimed.brief.ownerText,
          expectedEvidence: claimed.brief.expectedEvidence,
          sources: claimed.brief.sources,
          wontDo: claimed.brief.wontDo,
          limits: claimed.brief.limits,
          plannedAt: claimed.brief.plannedAt,
        }),
        toolsAllow: [...allowedTools],
      };
      entry.grant = { runId: ctx.runId, triggerId, result };
      return result;
    } catch (error) {
      return failClosed(`store error: ${messageOf(error)}`);
    }
  }

  /** nexus_schedule_check_report counts only inside the turn that was authenticated as that trigger's check. */
  async function beforeToolCall(
    event: { toolName: string; params: Record<string, unknown>; runId?: string },
    ctx: { agentId?: string; sessionKey?: string; runId?: string },
  ): Promise<{ block: true; blockReason: string } | undefined> {
    if (event.toolName !== "nexus_schedule_check_report") {
      return undefined;
    }
    const block = (blockReason: string) => {
      // A refused report is why a check can end "without a report": say so in the log, with ids only (never the content).
      deps.logger.warn(
        `nexus: check report blocked before it ran (trigger=${String(event.params.triggerId ?? "-").slice(0, 40)} session=${ctx.sessionKey ?? "-"})`,
      );
      return { block: true as const, blockReason };
    };
    const runId = event.runId ?? ctx.runId;
    const principal = deps.resolvePrincipal(ctx);
    const triggerId =
      typeof event.params.triggerId === "string" ? event.params.triggerId.trim() : "";
    if (!runId || !ctx.sessionKey || !principal || !triggerId) {
      return block("nexus_schedule_check_report is only available inside a Nexus follow-up check.");
    }
    try {
      const store = await deps.getStore();
      const gate = await store.scheduleCheckGate({
        principal,
        triggerId,
        runId,
        sessionKey: ctx.sessionKey,
      });
      if (gate.ok) {
        return undefined;
      }
    } catch (error) {
      deps.logger.warn(`nexus: check report gate failed: ${messageOf(error)}`);
    }
    return block(
      "nexus_schedule_check_report is only available inside the Nexus follow-up check it belongs to.",
    );
  }

  return {
    onCronChanged,
    authenticate,
    beforeToolCall,
    allowedTools: () => [...allowedTools],
    pendingCount: () => pending.size,
    marker: CHECK_MARKER_PREFIX,
  };
}

export type CheckRuntime = ReturnType<typeof createCheckRuntime>;
