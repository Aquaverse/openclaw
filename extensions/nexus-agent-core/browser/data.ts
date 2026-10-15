import type { EvidenceBlobView } from "../src/store/blob-types.js";
import type { ClaimRecord } from "../src/store/claim-types.js";
// Reads for the Nexus Control UI module. Everything goes through the plugin's existing read-only gateway methods
// (operator.read); the store is never reached directly, so the page sees exactly what any RPC client would.
import type { DecisionRecord, ExecutionRecord } from "../src/store/decision-types.js";
import type { PreferenceReceiptRow, PreferenceRecord } from "../src/store/preference-types.js";
import type { PurgeReceiptRow } from "../src/store/purge-types.js";
import type { TaskDetail, TaskRecord } from "../src/store/types.js";
import type { WatchRecord } from "../src/store/watch-types.js";
import {
  renderPreferences,
  renderReceipts,
  renderTaskDetail,
  renderTaskList,
} from "../src/ui-render.js";
import { EMPTY_MODEL, type NexusModel } from "./actions.ts";
import { NAV_BASE, type NexusRoute } from "./route.ts";

export type NexusRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

export type NexusFeatures = { preferences: boolean };

/** A method the gateway does not serve (feature switched off) or any read failure reads as "not available". */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

export async function probeFeatures(request: NexusRequest): Promise<NexusFeatures> {
  const listed = await optional(() => request("nexus.preference.list", { limit: 1 }));
  return { preferences: listed !== undefined };
}

/** `model` keeps the records the page rendered; action dialogs are built from it, never from the markup. */
export type NexusView = { title: string; html: string; model: NexusModel };

export type LoadOptions = {
  /** Render action buttons. Off when the connection cannot write. */
  actions?: boolean;
};

export async function loadView(
  request: NexusRequest,
  route: NexusRoute,
  features: NexusFeatures,
  options: LoadOptions = {},
): Promise<NexusView> {
  const actions = options.actions === true;
  switch (route.view) {
    case "tasks": {
      const [tasks, pending] = await Promise.all([
        request<{ tasks: TaskRecord[] }>("nexus.task.list", { includeClosed: true, limit: 100 }),
        optional(() =>
          request<{ decisions: DecisionRecord[] }>("nexus.decision.list", {
            statuses: ["pending"],
            limit: 200,
          }),
        ),
      ]);
      const counts = new Map<string, number>();
      for (const decision of pending?.decisions ?? []) {
        counts.set(decision.taskId, (counts.get(decision.taskId) ?? 0) + 1);
      }
      return {
        title: "事项",
        html: renderTaskList(tasks.tasks, counts, NAV_BASE),
        model: EMPTY_MODEL,
      };
    }
    case "task": {
      const { taskId } = route;
      const detail = await request<TaskDetail>("nexus.task.get", { taskId });
      const [decisions, executions, claims, evidence, watches] = await Promise.all([
        optional(() =>
          request<{ decisions: DecisionRecord[] }>("nexus.decision.list", {
            taskId,
            includeClosedTasks: true,
            limit: 100,
          }),
        ),
        optional(() =>
          request<{ executions: ExecutionRecord[] }>("nexus.execution.list", {
            taskId,
            limit: 100,
          }),
        ),
        optional(() =>
          request<{ claims: ClaimRecord[] }>("nexus.claim.list", { taskId, limit: 100 }),
        ),
        optional(() =>
          request<{ evidence: EvidenceBlobView[] }>("nexus.evidence.list", { taskId, limit: 100 }),
        ),
        optional(() =>
          request<{ watches: WatchRecord[] }>("nexus.watch.list", { taskId, limit: 50 }),
        ),
      ]);
      return {
        title: `事项 ${taskId}`,
        html: renderTaskDetail(
          {
            detail,
            decisions: decisions?.decisions ?? [],
            executions: executions?.executions ?? [],
            claims: claims?.claims,
            evidence: evidence?.evidence,
            watches: watches?.watches,
            actions,
          },
          NAV_BASE,
        ),
        model: {
          decisions: decisions?.decisions ?? [],
          watches: watches?.watches ?? [],
          preferences: [],
        },
      };
    }
    case "preferences": {
      const out = await request<{ preferences: PreferenceRecord[] }>("nexus.preference.list", {
        limit: 200,
      });
      return {
        title: "偏好",
        html: renderPreferences(out.preferences, { actions }),
        model: { decisions: [], watches: [], preferences: out.preferences },
      };
    }
    case "receipts": {
      const [tasks, preferences] = await Promise.all([
        request<{ receipts: PurgeReceiptRow[] }>("nexus.task.purgeReceipts", { limit: 100 }),
        features.preferences
          ? optional(() =>
              request<{ receipts: PreferenceReceiptRow[] }>("nexus.preference.purgeReceipts", {
                limit: 100,
              }),
            )
          : Promise.resolve(undefined),
      ]);
      return {
        title: "清除回执",
        html: renderReceipts(tasks.receipts, preferences?.receipts),
        model: EMPTY_MODEL,
      };
    }
  }
}
