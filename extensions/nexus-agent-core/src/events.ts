// Gateway event bridge. Only a running plugin service holds the emitter (OpenClawPluginServiceContext.gatewayEvents),
// so tools and RPC handlers publish through this bridge; with no service (CLI one-shot runs) events are dropped.
//
// Event name: the host builds `plugin.<pluginId>.<event>` and rejects event names containing '.'
// (`^[a-z][a-z0-9_-]*$` in src/plugins/services.ts), so DESIGN's `task.changed` is published as `task_changed`.
import type { TaskRecord } from "./store/types.js";

export type TaskIdentity = Pick<TaskRecord, "ownerId" | "id" | "status" | "revision" | "updatedAt">;

export const TASK_CHANGED_EVENT = "task_changed";

export type TaskChangeKind = "created" | "updated" | "note" | "aborted" | "deleted";

export type TaskChangedPayload = {
  ownerId: string;
  taskId: string;
  change: TaskChangeKind;
  status: string;
  revision: number;
  updatedAt: number;
};

type Emitter = (event: string, payload: unknown, opts: { scope: "operator.read" }) => void;

export const DECISION_CHANGED_EVENT = "decision_changed";
export const EXECUTION_CHANGED_EVENT = "execution_changed";
export const CLAIM_CHANGED_EVENT = "claim_changed";
export const CLAIM_VERIFIED_EVENT = "claim_verified";

/** Outbox-delivered ledger notices. Ids and a state only: clients re-read through nexus.claim.get. */
export type ClaimChangedPayload = {
  ownerId: string;
  taskId: string;
  claimId?: string;
  state?: string;
  previousState?: string;
  eventId?: string;
};

/** Outbox-delivered notices. Ids and a status only: clients re-read through nexus.decision.get / nexus.execution.list. */
export type DecisionChangedPayload = {
  ownerId: string;
  kind: string;
  taskId: string;
  decisionId?: string;
  status?: string;
  resolution?: string;
  executionId?: string;
};

export type EventBridge = ReturnType<typeof createEventBridge>;

export function createEventBridge(onError: (error: unknown) => void = () => {}) {
  let emitter: Emitter | undefined;
  return {
    attach(next: Emitter | undefined) {
      emitter = next;
    },
    attached() {
      return emitter !== undefined;
    },
    /** decision_pending / decision_resolved notices (section 8.8.3 outbox). */
    decisionChanged(payload: DecisionChangedPayload) {
      if (!emitter) {
        throw new Error("no gateway event emitter attached");
      }
      emitter(DECISION_CHANGED_EVENT, payload, { scope: "operator.read" });
    },
    /** execution_ready / execution_settled notices. */
    executionChanged(payload: DecisionChangedPayload) {
      if (!emitter) {
        throw new Error("no gateway event emitter attached");
      }
      emitter(EXECUTION_CHANGED_EVENT, payload, { scope: "operator.read" });
    },
    /** claim_changed: every ledger event (create / assert / evidence / retract / detach). */
    claimChanged(payload: ClaimChangedPayload) {
      if (!emitter) {
        throw new Error("no gateway event emitter attached");
      }
      emitter(CLAIM_CHANGED_EVENT, payload, { scope: "operator.read" });
    },
    /** claim_verified: the claim just reached VERIFIED (section 12). */
    claimVerified(payload: ClaimChangedPayload) {
      if (!emitter) {
        throw new Error("no gateway event emitter attached");
      }
      emitter(CLAIM_VERIFIED_EVENT, payload, { scope: "operator.read" });
    },
    /** Payload carries ids and a summary only; clients re-read through nexus.task.get. */
    taskChanged(change: TaskChangeKind, task: TaskIdentity) {
      if (!emitter) {
        return;
      }
      try {
        emitter(
          TASK_CHANGED_EVENT,
          {
            ownerId: task.ownerId,
            taskId: task.id,
            change,
            status: task.status,
            revision: task.revision,
            updatedAt: task.updatedAt,
          },
          { scope: "operator.read" },
        );
      } catch (error) {
        onError(error);
      }
    },
  };
}
