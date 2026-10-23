// Shared harness for the Stage 2 / Stage 3 acceptance flows: the REAL tools, hook, RPC handlers and outbox on the real
// kernel (in-memory SQLite) with the fake provider. The "host" reproduces the merge rules of src/plugins/hooks.ts (params
// frozen only when an approval was requested, block is sticky) and the facts measured in Stage 0 (onResolution is NOT
// awaited, an unresolved card blocks the tool, a throwing callback does not release it).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { requestFingerprint } from "../canonical.js";
import { createClaimRpcHandlers } from "../claim-rpc.js";
import { createDecisionRpcHandlers } from "../decision-rpc.js";
import {
  createDecisionRuntime,
  DEFAULT_APPROVAL_TIMEOUT_MS,
  type ApprovalHookResult,
} from "../decision-runtime.js";
import { createEventBridge } from "../events.js";
import { createEvidenceRpcHandlers } from "../evidence-rpc.js";
import { createEvidenceService, type EvidenceServiceDeps } from "../evidence/evidence-service.js";
import { createPreferenceRpcHandlers } from "../preference-rpc.js";
import { createFakeProvider, type ProviderMode } from "../provider/fake-provider.js";
import { createPurgeRpcHandlers } from "../purge-rpc.js";
import { createPurgeService } from "../purge/purge-service.js";
import { createTaskRpcHandlers } from "../rpc.js";
import type { TaskStore } from "../store/host.js";
import { applyMigrations } from "../store/kernel.js";
import { createNexusKernel } from "../store/nexus-kernel.js";
import type { Principal } from "../store/types.js";
import { createTokenLedger } from "../tokens.js";
import { createActionTools } from "../tools/action-tools.js";
import { createClaimTools } from "../tools/claim-tools.js";
import { createPreferenceTools } from "../tools/preference-tools.js";
import { createTaskTools } from "../tools/task-tools.js";
import { createWatchTools } from "../tools/watch-tools.js";
import { createWatchRpcHandlers } from "../watch-rpc.js";
import { createWatchRuntime } from "../watch-runtime.js";
import { createFakeBlobWorld } from "./fake-blob-store.js";

export const P: Principal = { ownerId: "local" };
export const T0 = Date.UTC(2026, 9, 12, 8, 0, 0);

export type Details = Record<string, unknown> & { ok: boolean; code?: string; status?: string };
export type HookOut = {
  params?: Record<string, unknown>;
  block?: boolean;
  blockReason?: string;
  requireApproval?: ApprovalHookResult["requireApproval"];
};
export type Approval = "allow-once" | "deny" | "timeout" | "cancelled" | "lost" | "none";
export type HostOpts = {
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
  approval?: Approval;
  callbackDelayMs?: number;
  otherHooks?: Array<
    (event: { toolName: string; params: Record<string, unknown> }) => HookOut | undefined
  >;
};

export function world(
  options: {
    idempotent?: boolean;
    mode?: ProviderMode;
    coreApproval?: boolean;
    /** Stage 3: Claim / Evidence ledger on (completion gating, execution-result claims, claim tools and RPC). */
    claims?: boolean;
    /** Stage 3 slice 2: evidence bytes (fake byte store, evidence service, `nexus.evidence.*` RPC, blob refs on the tool). */
    evidence?: boolean;
    evidenceConfig?: EvidenceServiceDeps["config"];
    /** Wrap the fake byte store, e.g. to model a host that refuses `openBlobStore`. */
    wrapBlobs?: (inner: EvidenceServiceDeps["blobs"]) => EvidenceServiceDeps["blobs"];
    /** Stage 3 slice 3: purge service + `nexus.task.purge*` / `nexus.evidence.delete` RPC (needs `evidence`). */
    purge?: boolean;
    purgeWorkerLeaseMs?: number;
    bootId?: string | null;
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const tx = <T>(run: () => T): T => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  applyMigrations(db, tx);
  const k = createNexusKernel(db, tx);
  const INCARNATION = "inc-test";
  if (options.evidence) {
    k.registerIncarnation({ principal: P, incarnationId: INCARNATION, bootId: "1:1", now: T0 });
  }
  const blobs = createFakeBlobWorld();
  let failNext: string | undefined;
  const store = Object.fromEntries(
    Object.entries(k).map(([name, fn]) => [
      name,
      async (input: unknown) => {
        if (failNext === name) {
          failNext = undefined;
          throw new Error(`injected failure in ${name}`);
        }
        return (fn as (value: unknown) => unknown)(input);
      },
    ]),
  ) as unknown as TaskStore;
  let clock = T0;
  const count = (sql: string, ...params: (string | number)[]): number =>
    (db.prepare(sql).get(...params) as { c: number }).c;
  const row = (sql: string, ...params: (string | number)[]) =>
    db.prepare(sql).get(...params) as Record<string, unknown>;
  const emitted: { event: string; payload: Record<string, unknown> }[] = [];
  const events = createEventBridge();
  events.attach((event, payload) => {
    emitted.push({ event, payload: payload as Record<string, unknown> });
  });
  const provider = createFakeProvider({
    idempotent: options.idempotent ?? true,
    mode: options.mode ?? "ok",
    now: () => clock,
  });
  const injections: { sessionKey: string; text: string; idempotencyKey: string; ttlMs: number }[] =
    [];
  let enqueueMode: "ok" | "throw" | "refused" = "ok";
  const logs: string[] = [];
  const logger = {
    info: (m: string) => logs.push(`info ${m}`),
    warn: (m: string) => logs.push(`warn ${m}`),
    error: (m: string) => logs.push(`error ${m}`),
  };
  const evidence = options.evidence
    ? createEvidenceService({
        getStore: async () => store,
        blobs: options.wrapBlobs ? options.wrapBlobs(blobs) : blobs,
        incarnationId: INCARNATION,
        ...(options.evidenceConfig ? { config: options.evidenceConfig } : {}),
        now: () => clock,
        // Tests never wait in real time: they move the clock explicitly.
        sleep: () =>
          new Promise<void>((resolve) => {
            setImmediate(resolve);
          }),
        onOutboxWritten: () => {},
        onEvidenceRegistered: (payload) => events.evidenceChanged(payload),
        logger,
      })
    : undefined;
  const purge =
    options.purge && evidence
      ? createPurgeService({
          getStore: async () => store,
          evidence,
          leases: evidence.config.leases,
          incarnationGoneEnabled: evidence.config.incarnationGoneEnabled,
          ...(options.purgeWorkerLeaseMs ? { workerLeaseMs: options.purgeWorkerLeaseMs } : {}),
          now: () => clock,
          sleep: () =>
            new Promise<void>((resolve) => {
              setImmediate(resolve);
            }),
          onPurged: (payload) => events.taskPurged(payload),
          logger,
        })
      : undefined;
  const runtime = createDecisionRuntime({
    getStore: async () => store,
    events,
    resolvePrincipal: () => P,
    provider,
    enqueueInjection: async (injection) => {
      injections.push(injection);
      if (enqueueMode === "throw") {
        throw new Error("host: session store unavailable");
      }
      return enqueueMode === "refused"
        ? { enqueued: false, id: "", sessionKey: injection.sessionKey }
        : { enqueued: true };
    },
    logger,
    config: {
      coreApprovalEnabled: options.coreApproval !== false,
      approvalTimeoutMs: DEFAULT_APPROVAL_TIMEOUT_MS,
      claimsEnabled: options.claims === true,
    },
    now: () => clock,
    workerId: "test-worker",
    ...(options.bootId !== undefined ? { bootId: options.bootId } : {}),
  });
  const actionTools = (sessionKey: string) =>
    createActionTools(
      {
        getStore: async () => store,
        events,
        resolvePrincipal: () => P,
        provider,
        now: () => clock,
        cardWaitMs: 400,
        onOutboxWritten: () => runtime.kickOutbox(),
        claimsEnabled: options.claims === true,
      },
      { sessionKey, agentId: "main" },
    );
  const claimTools = (sessionKey: string) =>
    createClaimTools(
      {
        getStore: async () => store,
        resolvePrincipal: () => P,
        now: () => clock,
        onOutboxWritten: () => runtime.kickOutbox(),
        ...(evidence ? { evidence } : {}),
      },
      { sessionKey, agentId: "main" },
    );
  const prefTools = (sessionKey: string, decisionsEnabled = true) =>
    createPreferenceTools(
      {
        getStore: async () => store,
        events,
        resolvePrincipal: () => P,
        now: () => clock,
        decisionsEnabled,
        onOutboxWritten: () => runtime.kickOutbox(),
      },
      { sessionKey, agentId: "main" },
    );
  // Watcher: the real runtime over a recording fake of the host scheduler. `claimWaitMs: 0` and an immediate sleep keep tests fast.
  const schedulerCalls: Array<Record<string, unknown>> = [];
  let jobSeq = 0;
  let scheduleMode: "ok" | "fail" = "ok";
  const watchRuntime = createWatchRuntime({
    getStore: async () => store,
    events,
    resolvePrincipal: () => P,
    scheduler: {
      schedule: async (params) => {
        schedulerCalls.push({ op: "schedule", ...params });
        if (scheduleMode === "fail") {
          return undefined;
        }
        jobSeq += 1;
        return { id: `job-${jobSeq}` };
      },
      unscheduleByTag: async (params) => {
        schedulerCalls.push({ op: "unschedule", ...params });
        return { removed: 1, failed: 0 };
      },
    },
    recordTrigger: (ctx) => runtime.recordTrigger(ctx),
    onOutboxWritten: () => runtime.kickOutbox(),
    logger,
    now: () => clock,
    claimWaitMs: 0,
    sleep: () =>
      new Promise<void>((resolve) => {
        setImmediate(resolve);
      }),
  });
  const watchTools = (sessionKey: string) =>
    createWatchTools(
      {
        getStore: async () => store,
        events,
        resolvePrincipal: () => P,
        now: () => clock,
        after: (principal, change) => watchRuntime.afterChange(principal, change),
      },
      { sessionKey, agentId: "main" },
    );
  const taskTools = (sessionKey: string) =>
    createTaskTools(
      {
        getStore: async () => store,
        ledger: createTokenLedger(() => clock),
        events,
        resolvePrincipal: () => P,
        now: () => clock,
        completionEnabled: options.claims === true,
      },
      { sessionKey, agentId: "main" },
    );
  const rpc = new Map<string, (options: never) => unknown>(
    createDecisionRpcHandlers({
      getStore: async () => store,
      events,
      runtime,
      resolvePrincipal: () => P,
      providerCaps: () => provider.caps(),
      now: () => clock,
    }).map(([method, handler]) => [method, handler]),
  );
  for (const [method, handler] of createClaimRpcHandlers({
    getStore: async () => store,
    events,
    resolvePrincipal: () => P,
    kickOutbox: () => runtime.kickOutbox(),
    now: () => clock,
  })) {
    rpc.set(method, handler as never);
  }
  if (evidence) {
    for (const [method, handler] of createEvidenceRpcHandlers({
      getStore: async () => store,
      evidence,
      events,
      resolvePrincipal: () => P,
      kickOutbox: () => runtime.kickOutbox(),
      now: () => clock,
    })) {
      rpc.set(method, handler as never);
    }
  }
  for (const [method, handler] of createTaskRpcHandlers({
    getStore: async () => store,
    events,
    resolvePrincipal: () => P,
    now: () => clock,
  })) {
    rpc.set(method, handler as never);
  }
  for (const [method, handler] of createPreferenceRpcHandlers({
    getStore: async () => store,
    events,
    resolvePrincipal: () => P,
    now: () => clock,
  })) {
    rpc.set(method, handler as never);
  }
  for (const [method, handler] of createWatchRpcHandlers({
    getStore: async () => store,
    events,
    resolvePrincipal: () => P,
    now: () => clock,
    afterCancel: (principal, watch) =>
      watchRuntime.afterChange(principal, { kind: "cancelled", watch }),
  })) {
    rpc.set(method, handler as never);
  }
  if (purge) {
    for (const [method, handler] of createPurgeRpcHandlers({
      getStore: async () => store,
      purge,
      events,
      resolvePrincipal: () => P,
    })) {
      rpc.set(method, handler as never);
    }
  }
  const call = async (method: string, params: Record<string, unknown> = {}) => {
    let reply:
      | {
          ok: boolean;
          payload?: Record<string, unknown>;
          error?: { code: string; message: string; details?: unknown };
        }
      | undefined;
    const handler = rpc.get(method);
    assert.ok(handler, `rpc ${method}`);
    await handler({
      params,
      respond: (ok: boolean, payload?: unknown, error?: unknown) => {
        reply = { ok, payload: payload as Record<string, unknown>, error: error as never };
      },
    } as never);
    assert.ok(reply, `rpc ${method} replied`);
    return reply;
  };

  let seq = 0;
  let taskSeq = 0;
  const newTask = (title = "订东京酒店", entities: unknown = { city: "tokyo" }) => {
    taskSeq += 1;
    const id = `T${String(taskSeq).padStart(8, "0")}`;
    const goal = { want: title };
    k.create({
      principal: P,
      id,
      kind: "hotel",
      title,
      goal,
      entities,
      idempotencyKey: `op_${id}`,
      fingerprint: requestFingerprint({ kind: "hotel", entities, goal }),
      sessionKey: "s1",
      now: clock,
    });
    return id;
  };

  /** One model turn's prompt phase (where the run trigger is recorded). */
  const prompt = (runId: string, trigger = "user", sessionKey = "s1") =>
    runtime.recordTrigger({
      runId,
      sessionKey,
      trigger,
      agentId: "main",
      ...(trigger === "cron" ? { jobId: "job1" } : {}),
    });

  /** The host: hooks in order, merge rules, approval handling, then the tool handler. */
  const hostCall = async (
    toolName: string,
    params: Record<string, unknown>,
    opts: HostOpts = {},
  ) => {
    seq += 1;
    const sessionKey = opts.sessionKey ?? "s1";
    const runId = opts.runId ?? `run${seq}`;
    const toolCallId = opts.toolCallId ?? `call_${seq}|fc_${seq}`;
    const hooks = [
      (event: { toolName: string; params: Record<string, unknown> }) =>
        runtime.beforeToolCall(
          { ...event, runId, toolCallId },
          { sessionKey, agentId: "main", runId, toolCallId },
        ) as Promise<HookOut | undefined>,
      ...(opts.otherHooks ?? []),
    ];
    let acc: HookOut | undefined;
    for (const hook of hooks) {
      const next = (await hook({ toolName, params: acc?.params ?? params })) ?? {};
      const already = acc?.requireApproval !== undefined;
      let merged = next.params ?? acc?.params;
      if (already) {
        merged = acc?.params;
      }
      acc = {
        params: merged,
        block: acc?.block || next.block,
        blockReason: acc?.blockReason ?? next.blockReason,
        requireApproval: acc?.requireApproval ?? next.requireApproval,
      };
    }
    if (acc?.block) {
      return { blocked: true as const, blockReason: acc.blockReason, approval: undefined };
    }
    const approval = acc?.requireApproval;
    const mode: Approval = opts.approval ?? "none";
    let callback: Promise<void> = Promise.resolve();
    if (approval) {
      const fire = (value: string) => {
        callback = new Promise<void>((resolve) => {
          setTimeout(() => {
            void Promise.resolve(approval.onResolution(value)).finally(resolve);
          }, opts.callbackDelayMs ?? 0);
        });
      };
      if (mode === "deny" || mode === "timeout" || mode === "cancelled") {
        fire(mode);
        await callback;
        return { blocked: true as const, blockReason: `approval ${mode}`, approval };
      }
      if (mode === "allow-once") {
        fire("allow-once");
      }
      // "lost": the host let the call through, the callback never arrives (or arrives broken)
    }
    const tool = actionTools(sessionKey).find((candidate) => candidate.name === toolName);
    assert.ok(tool, `tool ${toolName}`);
    const finalParams = acc?.params ?? params;
    const out = (await tool.execute(toolCallId, finalParams as never)) as unknown as {
      details: Details;
    };
    await callback;
    return { blocked: false as const, result: out.details, approval, finalParams };
  };

  const run = async (name: string, params: Record<string, unknown>, opts?: HostOpts) => {
    const out = await hostCall(name, params, opts);
    assert.ok(!out.blocked, `${name} was blocked: ${out.blockReason ?? ""}`);
    return out.result;
  };
  const prepare = async (
    taskId: string,
    toolName: string,
    toolParams: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) => {
    const out = await run("nexus_action_prepare", {
      taskId,
      toolName,
      params: toolParams,
      ...extra,
    });
    assert.ok(out.ok, JSON.stringify(out));
    return out.actionId as string;
  };
  const booking = (taskId: string, item = "Park Hotel") =>
    prepare(taskId, "fake_booking", { vendor: "Hotelier", item, date: "2026-10-20" });

  return {
    blobs,
    evidence,
    purge,
    setEnqueue: (mode: "ok" | "throw" | "refused") => {
      enqueueMode = mode;
    },
    db,
    k,
    store,
    runtime,
    provider,
    events,
    emitted,
    injections,
    logs,
    rpc: call,
    count,
    row,
    newTask,
    prompt,
    hostCall,
    run,
    prepare,
    booking,
    taskTools,
    claimTools,
    prefTools,
    watchTools,
    watchRuntime,
    schedulerCalls,
    setScheduleMode: (mode: "ok" | "fail") => {
      scheduleMode = mode;
    },
    setClock: (value: number) => {
      clock = value;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
    failNext: (name: string) => {
      failNext = name;
    },
    settle: async () => {
      for (let i = 0; i < 5; i += 1) {
        await runtime.flushOutbox();
        await new Promise((r) => {
          setTimeout(r, 1);
        });
      }
    },
  };
}
