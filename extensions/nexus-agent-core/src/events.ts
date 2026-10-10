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

type Emitter = (
  event: string,
  payload: TaskChangedPayload,
  opts: { scope: "operator.read" },
) => void;

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
