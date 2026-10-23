import { asText } from "./as-text.js";
// Stage 2 runtime glue (DESIGN section 8): the run-trigger ledger, the decision hook that attaches an OPTIONAL core
// approval card, outbox delivery, and gateway-start reconciliation. Pure dependency injection, so the whole flow is
// testable against the real kernel without a gateway.
import { renderApprovalCard } from "./decision/approval-text.js";
import { parseDecisionRequest } from "./decision/request.js";
import type { EventBridge } from "./events.js";
import { resolveProcessBootId, workerIdFor } from "./process-boot.js";
import type { FakeProvider } from "./provider/fake-provider.js";
import { assertProviderAllowed } from "./provider/provider-guard.js";
import type { OutboxRecord } from "./store/decision-types.js";
import type { TaskStore } from "./store/host.js";
import type { Principal } from "./store/types.js";
import { STALE_EXECUTING_MS } from "./tools/action-tools.js";

export const RUN_TRIGGER_TTL_MS = 3_600_000;
export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;
const OUTBOX_BATCH = 20;
const OUTBOX_MAX_ATTEMPTS = 8;
const OUTBOX_STALE_MS = 120_000;
const INJECTION_TTL_MS = 3_600_000;

type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
  debug?: (message: string) => void;
};

/** Structural copy of the parts of PluginHookBeforeToolCallResult this module returns. */
export type ApprovalHookResult = {
  requireApproval: {
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
    timeoutMs: number;
    allowedDecisions: Array<"allow-once" | "allow-always" | "deny">;
    onResolution: (decision: string) => Promise<void>;
  };
};

export type DecisionRuntimeDeps = {
  getStore: () => Promise<TaskStore>;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string }) => Principal | undefined;
  provider: FakeProvider;
  enqueueInjection?: (injection: {
    sessionKey: string;
    text: string;
    idempotencyKey: string;
    ttlMs: number;
  }) => Promise<unknown>;
  logger: Logger;
  config: {
    coreApprovalEnabled: boolean;
    approvalTimeoutMs: number;
    /** Stage 3: settle also writes the execution-result claim + evidence (needs the ledger). */
    claimsEnabled?: boolean;
  };
  now?: () => number;
  workerId?: string;
  /** `<pid>:<OS start time>` of this process; null = unreadable. Defaults to resolveProcessBootId(). */
  bootId?: string | null;
};

export function createDecisionRuntime(deps: DecisionRuntimeDeps) {
  // Every provider enters the execution path here (DESIGN section 14, T6).
  assertProviderAllowed(deps.provider);
  const now = deps.now ?? Date.now;
  const bootId = deps.bootId !== undefined ? deps.bootId : resolveProcessBootId();
  const workerId = deps.workerId ?? workerIdFor(bootId, Math.random().toString(36).slice(2, 8));
  const recordClaim = deps.config.claimsEnabled === true;
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
  let flushing: Promise<number> | undefined;

  // ---- prompt phase: remember which kind of turn this run is (section 8.8.1) ----
  async function recordTrigger(ctx: {
    runId?: string;
    sessionKey?: string;
    trigger?: string;
    jobId?: string;
    watchId?: string;
    agentId?: string;
  }): Promise<void> {
    if (!ctx.runId || !ctx.sessionKey) {
      // No ledger entry means the tool phase finds nothing and fails closed: no core card, decision page only.
      deps.logger.debug?.("nexus: run trigger not recorded (missing runId or sessionKey)");
      return;
    }
    const principal = deps.resolvePrincipal(ctx);
    if (!principal) {
      return;
    }
    try {
      const store = await deps.getStore();
      const out = await store.recordRunTrigger({
        principal,
        runId: ctx.runId,
        sessionKey: ctx.sessionKey,
        trigger: ctx.trigger ?? "unknown",
        ...(ctx.jobId ? { jobId: ctx.jobId } : {}),
        ...(ctx.watchId ? { watchId: ctx.watchId } : {}),
        ttlMs: RUN_TRIGGER_TTL_MS,
        now: now(),
      });
      if (out.outcome === "conflict") {
        deps.logger.warn(
          `nexus: run trigger for ${ctx.runId} conflicts with the recorded one; tool phase fails closed`,
        );
      }
    } catch (error) {
      deps.logger.warn(`nexus: could not record run trigger: ${message(error)}`);
    }
  }

  // ---- tool phase: nexus_decision_request gets a decision page entry first, a core card second ----
  async function beforeToolCall(
    event: {
      toolName: string;
      params: Record<string, unknown>;
      runId?: string;
      toolCallId?: string;
    },
    ctx: { agentId?: string; sessionKey?: string; runId?: string; toolCallId?: string },
  ): Promise<ApprovalHookResult | undefined> {
    if (event.toolName !== "nexus_decision_request") {
      return undefined;
    }
    const principal = deps.resolvePrincipal(ctx);
    const parsed = parseDecisionRequest(event.params);
    const sessionKey = ctx.sessionKey;
    const runId = event.runId ?? ctx.runId;
    const toolCallId = event.toolCallId ?? ctx.toolCallId;
    // Without all three the idempotency key does not exist: leave it to the tool handler (decision page only).
    if (!principal || typeof parsed === "string" || !sessionKey || !runId || !toolCallId) {
      return undefined;
    }
    try {
      const store = await deps.getStore();
      const created = await store.createDecision({
        principal,
        taskId: parsed.taskId,
        ...(parsed.effectKind ? { effectKind: parsed.effectKind } : {}),
        actionIds: parsed.actionIds,
        sessionKey,
        runId,
        toolCallId,
        now: now(),
      });
      if (created.outcome === "created") {
        deps.events.taskChanged("updated", created.task);
        kickOutbox();
      } else if (created.outcome === "replayed" && created.noticeEnqueued) {
        kickOutbox();
      }
      if (
        created.outcome !== "created" &&
        created.outcome !== "replayed" &&
        created.outcome !== "reused_pending"
      ) {
        return undefined;
      }
      const decision = created.decision;
      if (decision.status !== "pending" || !deps.config.coreApprovalEnabled) {
        return undefined;
      }
      // A card carries no choice: with several candidates only the decision page can pick one.
      if (decision.effectKind !== "acknowledge" && decision.actionIds.length !== 1) {
        return undefined;
      }
      const trigger = await store.readRunTrigger({ principal, runId, sessionKey, now: now() });
      if (trigger?.trigger !== "user") {
        // cron / heartbeat / unknown / no ledger entry: fail closed, no card.
        return undefined;
      }
      const claim = await store.claimCoreApproval({
        principal,
        decisionId: decision.id,
        approvalTimeoutMs: deps.config.approvalTimeoutMs,
        workerId,
        now: now(),
      });
      if (!claim) {
        return undefined;
      }
      const card = renderApprovalCard(decision);
      const attemptId = claim.attemptId;
      return {
        requireApproval: {
          title: card.title,
          description: card.description,
          severity: decision.riskTier === "R3" ? "critical" : "warning",
          timeoutMs: deps.config.approvalTimeoutMs,
          // Without this the user can press "always approve" and the callback would carry a value section 8.9 ignores.
          allowedDecisions: ["allow-once", "deny"],
          onResolution: (value: string) =>
            onApprovalResolution(principal, decision.id, attemptId, value),
        },
      };
    } catch (error) {
      deps.logger.warn(
        `nexus: decision hook failed, falling back to the decision page: ${message(error)}`,
      );
      return undefined;
    }
  }

  async function onApprovalResolution(
    principal: Principal,
    decisionId: string,
    attemptId: string,
    value: string,
  ): Promise<void> {
    // Always logged: what the host passes for "always approve" / timeouts is exactly what Stage 2 acceptance probes.
    deps.logger.info(`nexus: core approval callback decision=${decisionId} value=${value}`);
    try {
      const store = await deps.getStore();
      const out = await store.recordApprovalResolution({
        principal,
        decisionId,
        attemptId,
        value,
        providerCaps: deps.provider.caps(),
        now: now(),
      });
      const inner =
        out.outcome === "resolved" && "outcome" in out.result
          ? ` result=${out.result.outcome}`
          : "";
      deps.logger.info(
        `nexus: core approval recorded decision=${decisionId} outcome=${out.outcome}${inner}`,
      );
      if (out.outcome === "resolved") {
        if (out.late) {
          deps.logger.info(
            `nexus: late core approval click decision=${decisionId} value=${value} revokedExecutions=${out.late.revokedExecutionIds.join(",") || "none"}`,
          );
          if (out.late.task) {
            deps.events.taskChanged("updated", out.late.task);
          }
          kickOutbox();
        }
        const result = out.result;
        if ("task" in result && result.task) {
          deps.events.taskChanged("updated", result.task);
        }
        kickOutbox();
      }
    } catch (error) {
      // Thrown before/inside the transaction: nothing was written, the decision stays pending (section 8.9).
      deps.logger.warn(`nexus: core approval callback failed for ${decisionId}: ${message(error)}`);
    }
  }

  // ---- outbox delivery (at-least-once; consumers dedupe on eventKey) ----
  function kickOutbox(): void {
    void flushOutbox().catch((error: unknown) => {
      deps.logger.warn(`nexus: outbox flush failed: ${message(error)}`);
    });
  }

  async function deliver(
    principal: Principal,
    store: TaskStore,
    record: OutboxRecord,
  ): Promise<void> {
    const payload = (record.payload ?? {}) as Record<string, unknown>;
    const base = {
      ownerId: principal.ownerId,
      kind: record.kind,
      taskId: record.taskId,
      ...(record.decisionId ? { decisionId: record.decisionId } : {}),
    };
    switch (record.kind) {
      case "decision_pending":
      case "decision_resolved":
        deps.events.decisionChanged({
          ...base,
          ...(typeof payload.status === "string" ? { status: payload.status } : {}),
          ...(typeof payload.resolution === "string" ? { resolution: payload.resolution } : {}),
        });
        return;
      case "execution_settled":
        deps.events.executionChanged({
          ...base,
          ...(typeof payload.executionId === "string" ? { executionId: payload.executionId } : {}),
          ...(typeof payload.state === "string" ? { status: payload.state } : {}),
        });
        return;
      case "claim_changed":
      case "claim_verified": {
        const eventPayload = {
          ownerId: principal.ownerId,
          taskId: record.taskId,
          ...(typeof payload.claimId === "string" ? { claimId: payload.claimId } : {}),
          ...(typeof payload.state === "string" ? { state: payload.state } : {}),
          ...(typeof payload.previousState === "string"
            ? { previousState: payload.previousState }
            : {}),
          ...(typeof payload.eventId === "string" ? { eventId: payload.eventId } : {}),
        };
        if (record.kind === "claim_verified") {
          deps.events.claimVerified(eventPayload);
        } else {
          deps.events.claimChanged(eventPayload);
        }
        return;
      }
      case "execution_ready": {
        const executionId =
          typeof payload.executionId === "string" ? payload.executionId : undefined;
        deps.events.executionChanged({
          ...base,
          ...(executionId ? { executionId } : {}),
          status: "prepared",
        });
        // Only a decision resolved on the decision page needs to reach the Agent: a core-card approval happens
        // inside the run that is waiting for it (section 8.13).
        if (!executionId || !record.decisionId || !deps.enqueueInjection) {
          return;
        }
        const detail = await store.getDecision({ principal, decisionId: record.decisionId });
        const sessionKey = detail?.decision.sessionKey;
        if (!sessionKey || detail?.decision.resolutionSource !== "nexus_console") {
          return;
        }
        const injected = await deps.enqueueInjection({
          sessionKey,
          text: `[Nexus] The user approved an action of Task #${record.taskId} on the decision page. You can now call nexus_action_commit with executionId=${executionId}.`,
          idempotencyKey: record.eventKey,
          ttlMs: INJECTION_TTL_MS,
        });
        const injectedInfo = (injected ?? {}) as { enqueued?: unknown; id?: unknown };
        deps.logger.info(
          `nexus: execution_ready injection decision=${record.decisionId} execution=${executionId} enqueued=${asText(injectedInfo.enqueued)} injectionId=${asText(injectedInfo.id)}`,
        );
        break;
      }
      default:
        break;
    }
  }

  async function flushOutbox(): Promise<number> {
    if (!deps.events.attached()) {
      return 0;
    }
    if (flushing) {
      return await flushing;
    }
    flushing = (async () => {
      const principal = deps.resolvePrincipal({});
      if (!principal) {
        return 0;
      }
      const store = await deps.getStore();
      const claimed = await store.claimOutbox({
        principal,
        workerId,
        limit: OUTBOX_BATCH,
        now: now(),
      });
      for (const record of claimed) {
        try {
          await deliver(principal, store, record);
          await store.finishOutbox({
            principal,
            id: record.id,
            workerId,
            ok: true,
            maxAttempts: OUTBOX_MAX_ATTEMPTS,
            now: now(),
          });
        } catch (error) {
          await store.finishOutbox({
            principal,
            id: record.id,
            workerId,
            ok: false,
            error: message(error).slice(0, 300),
            maxAttempts: OUTBOX_MAX_ATTEMPTS,
            now: now(),
          });
        }
      }
      return claimed.length;
    })().finally(() => {
      flushing = undefined;
    });
    return await flushing;
  }

  // ---- reconciliation: read-only lookup at the provider; only a positive answer settles anything ----
  async function reconcileExecution(principal: Principal, executionId: string) {
    const store = await deps.getStore();
    const found = await store.getExecution({ principal, executionId });
    if (!found) {
      return { outcome: "not_found" as const };
    }
    const { execution } = found;
    if (execution.state === "succeeded" || execution.state === "failed") {
      return { outcome: "already_final" as const, execution };
    }
    if (execution.state === "prepared") {
      return { outcome: "not_reconcilable" as const, reason: "prepared", execution };
    }
    if (
      execution.state === "executing" &&
      now() - (execution.startedAt ?? 0) < STALE_EXECUTING_MS
    ) {
      return { outcome: "not_reconcilable" as const, reason: "in_flight", execution };
    }
    const lookup = await deps.provider.lookup(execution.providerIdempotencyKey);
    if (!lookup.found) {
      return { outcome: "not_found_at_provider" as const, execution };
    }
    const settled = await store.settleExecution({
      principal,
      executionId,
      outcome: {
        kind: "succeeded",
        result: lookup.result,
        providerOperationId: lookup.operationId,
      },
      from: ["unknown", "executing"],
      recordClaim,
      now: now(),
    });
    if (settled.outcome === "settled") {
      if (settled.task) {
        deps.events.taskChanged("updated", settled.task);
      }
      kickOutbox();
      return { outcome: "reconciled_succeeded" as const, execution: settled.execution };
    }
    return settled.outcome === "already_settled"
      ? { outcome: "already_final" as const, execution: settled.execution }
      : { outcome: "not_found" as const };
  }

  // ---- operator resolution: a person ends an execution that the provider has no record of (DESIGN 8.4) ----
  // Never settles on the model's say-so. `failed` is refused while the provider still has a record (use reconcile);
  // `succeeded` is an operator assertion and is stored as such. A note is mandatory so the step log says who decided why.
  async function resolveExecutionByOperator(
    principal: Principal,
    input: {
      executionId: string;
      resolution: "succeeded" | "failed";
      note: string;
      confirmation?: string;
      /** Audit string for the step log; the console is the only caller today. */
      actor?: string;
    },
  ) {
    const store = await deps.getStore();
    const found = await store.getExecution({ principal, executionId: input.executionId });
    if (!found) {
      return { outcome: "not_found" as const };
    }
    const { execution } = found;
    if (execution.state === "succeeded" || execution.state === "failed") {
      return { outcome: "already_final" as const, execution };
    }
    if (execution.state === "prepared") {
      return { outcome: "not_resolvable" as const, reason: "prepared", execution };
    }
    if (
      execution.state === "executing" &&
      now() - (execution.startedAt ?? 0) < STALE_EXECUTING_MS
    ) {
      return { outcome: "not_resolvable" as const, reason: "in_flight", execution };
    }
    if (input.resolution === "failed") {
      const lookup = await deps.provider.lookup(execution.providerIdempotencyKey);
      if (lookup.found) {
        return {
          outcome: "provider_has_record" as const,
          execution,
          hint: "The provider already has a record; use nexus.execution.reconcile instead",
        };
      }
    }
    const settled = await store.settleExecution({
      principal,
      executionId: input.executionId,
      outcome:
        input.resolution === "succeeded"
          ? {
              kind: "succeeded",
              result: {
                operatorResolved: true,
                note: input.note,
                ...(input.confirmation ? { confirmation: input.confirmation } : {}),
              },
            }
          : { kind: "failed", error: { code: "operator_resolved_failed", note: input.note } },
      from: ["unknown", "executing"],
      recordClaim,
      operatorResolution: { actor: input.actor ?? "operator:nexus-console", note: input.note },
      now: now(),
    });
    if (settled.outcome === "settled") {
      if (settled.task) {
        deps.events.taskChanged("updated", settled.task);
      }
      kickOutbox();
      return {
        outcome: (input.resolution === "succeeded" ? "resolved_succeeded" : "resolved_failed") as
          | "resolved_succeeded"
          | "resolved_failed",
        execution: settled.execution,
        task: settled.task,
      };
    }
    return settled.outcome === "already_settled"
      ? { outcome: "already_final" as const, execution: settled.execution }
      : { outcome: "not_found" as const };
  }

  async function tick(): Promise<void> {
    const principal = deps.resolvePrincipal({});
    if (!principal) {
      return;
    }
    try {
      const store = await deps.getStore();
      await store.expireDueDecisions({ principal, now: now() });
      const open = await store.listExecutions({
        principal,
        states: ["unknown", "executing"],
        limit: 50,
      });
      for (const execution of open) {
        const due =
          execution.state === "unknown"
            ? (execution.nextReconcileAt ?? 0) <= now()
            : now() - (execution.startedAt ?? 0) >= STALE_EXECUTING_MS;
        if (due) {
          await reconcileExecution(principal, execution.id);
        }
      }
      await store.purgeRunTriggers({ principal, now: now() });
      await flushOutbox();
    } catch (error) {
      deps.logger.warn(`nexus: decision tick failed: ${message(error)}`);
    }
  }

  async function startup() {
    const principal = deps.resolvePrincipal({});
    if (!principal) {
      return undefined;
    }
    const store = await deps.getStore();
    const report = await store.reconcileOnStart({
      principal,
      now: now(),
      outboxStaleMs: OUTBOX_STALE_MS,
      bootId,
    });
    deps.logger.info(
      `nexus: startup reconciliation pendingDecisions=${report.pendingDecisions.length} unfinishedExecutions=${report.unfinishedExecutions.length} expired=${report.expired.length} recoveredOutbox=${report.recoveredOutbox} orphanAttemptsReset=${report.orphanAttemptsReset} bootId=${bootId ?? "unavailable"}`,
    );
    return report;
  }

  return {
    recordTrigger,
    beforeToolCall,
    onApprovalResolution,
    flushOutbox,
    kickOutbox,
    reconcileExecution,
    resolveExecutionByOperator,
    tick,
    startup,
    workerId,
  };
}

export type DecisionRuntime = ReturnType<typeof createDecisionRuntime>;
