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
export const EVIDENCE_CHANGED_EVENT = "evidence_changed";
export const TASK_PURGED_EVENT = "task_purged";
export const PREFERENCE_CHANGED_EVENT = "preference_changed";
export const WATCH_CHANGED_EVENT = "watch_changed";
export const VAULT_CHANGED_EVENT = "vault_changed";

/** Ids, a collection and what happened. Never a file name or content: clients re-read through nexus.vault.get. */
export type VaultChangedPayload = {
  ownerId: string;
  fileId: string;
  action:
    | "imported"
    | "kept"
    | "discarded"
    | "renamed"
    | "moved"
    | "pinned"
    | "sensitivity"
    | "trashed"
    | "restored"
    | "purged"
    | "damaged"
    | "extracted";
  collection?: string;
};

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
    /** evidence_changed: material was registered on a Task without a claim link. Ids only; re-read via nexus.evidence.list. */
    evidenceChanged(payload: {
      ownerId: string;
      taskId: string;
      evidenceId: string;
      /** Absent = registered / linked; `deleted` = the stored bytes were removed by the operator. */
      change?: "deleted";
    }) {
      if (!emitter) {
        return;
      }
      try {
        emitter(EVIDENCE_CHANGED_EVENT, payload, { scope: "operator.read" });
      } catch (error) {
        onError(error);
      }
    },
    /** task_purged: the Task's ledger no longer exists; only the receipt remains. Ids and a timestamp only. */
    taskPurged(payload: {
      ownerId: string;
      taskId: string;
      receiptId: string;
      executedAt: number;
    }) {
      if (!emitter) {
        return;
      }
      try {
        emitter(TASK_PURGED_EVENT, payload, { scope: "operator.read" });
      } catch (error) {
        onError(error);
      }
    },
    /** preference_changed: a preference was set, deleted or purged. Ids, scope and key only (no value); re-read via nexus.preference.get. */
    preferenceChanged(payload: {
      ownerId: string;
      scope: string;
      key: string;
      preferenceId?: string;
      origin?: string;
      change: "set" | "deleted" | "purged";
    }) {
      if (!emitter) {
        return;
      }
      try {
        emitter(PREFERENCE_CHANGED_EVENT, payload, { scope: "operator.read" });
      } catch (error) {
        onError(error);
      }
    },
    /** watch_changed: a watch was created, scheduled, fired, reported on or closed. Ids and a status only; re-read via nexus.watch.get. */
    watchChanged(payload: {
      ownerId: string;
      watchId: string;
      taskId: string;
      status: string;
      change: string;
      attempts?: number;
    }) {
      if (!emitter) {
        return;
      }
      try {
        emitter(WATCH_CHANGED_EVENT, payload, { scope: "operator.read" });
      } catch (error) {
        onError(error);
      }
    },
    /** vault_changed: a file entered, moved, or left the vault. Ids only; re-read via nexus.vault.get / nexus.vault.list. */
    vaultChanged(payload: VaultChangedPayload) {
      if (!emitter) {
        return;
      }
      try {
        emitter(VAULT_CHANGED_EVENT, payload, { scope: "operator.read" });
      } catch (error) {
        onError(error);
      }
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
