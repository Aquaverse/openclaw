import { DEFAULT_LANG, tr, type Lang } from "../src/i18n.js";
import type { EvidenceBlobView } from "../src/store/blob-types.js";
import type { ClaimRecord } from "../src/store/claim-types.js";
// Reads for the Nexus Control UI module. Everything goes through the plugin's existing read-only gateway methods
// (operator.read); the store is never reached directly, so the page sees exactly what any RPC client would.
import type { DecisionRecord, ExecutionRecord } from "../src/store/decision-types.js";
import type { PreferenceReceiptRow, PreferenceRecord } from "../src/store/preference-types.js";
import type { PurgeReceiptRow } from "../src/store/purge-types.js";
import type { TaskDetail, TaskRecord } from "../src/store/types.js";
import type { VaultExtractionStatus } from "../src/store/vault-text-types.js";
import type {
  VaultFileRecord,
  VaultListResult,
  VaultStatsResult,
} from "../src/store/vault-types.js";
import type { WatchRecord } from "../src/store/watch-types.js";
import { filterToRpc, pageInfo, type TaskFilter } from "../src/task-query.js";
import {
  renderFiles,
  renderPreferences,
  renderReceipts,
  renderTaskDetail,
  renderTaskList,
} from "../src/ui-render.js";
import { fileListParams } from "../src/vault-ui.js";
import { EMPTY_MODEL, type NexusModel } from "./actions.ts";
import { NAV_BASE, type NexusRoute } from "./route.ts";

export type NexusRequest = <T = unknown>(
  method: string,
  params?: Record<string, unknown>,
) => Promise<T>;

export type NexusFeatures = { preferences: boolean; files?: boolean };

/** A method the gateway does not serve (feature switched off) or any read failure reads as "not available". */
async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

export async function probeFeatures(request: NexusRequest): Promise<NexusFeatures> {
  const [listed, vault] = await Promise.all([
    optional(() => request("nexus.preference.list", { limit: 1 })),
    optional(() => request("nexus.vault.stats")),
  ]);
  return { preferences: listed !== undefined, files: vault !== undefined };
}

/** `model` keeps the records the page rendered; action dialogs are built from it, never from the markup. */
export type NexusView = { title: string; html: string; model: NexusModel };

export type LoadOptions = {
  /** Render action buttons. Off when the connection cannot write. */
  actions?: boolean;
  /** Page text language; follows the host's locale. */
  lang?: Lang;
};

export async function loadView(
  request: NexusRequest,
  route: NexusRoute,
  features: NexusFeatures,
  options: LoadOptions = {},
): Promise<NexusView> {
  const actions = options.actions === true;
  const lang = options.lang ?? DEFAULT_LANG;
  switch (route.view) {
    case "tasks": {
      let filter = route.filter;
      const fetchList = (next: TaskFilter) =>
        request<{ tasks: TaskRecord[]; total?: number }>("nexus.task.list", filterToRpc(next));
      const [first, pending] = await Promise.all([
        fetchList(filter),
        optional(() =>
          request<{ decisions: DecisionRecord[] }>("nexus.decision.list", {
            statuses: ["pending"],
            limit: 200,
          }),
        ),
      ]);
      let list = first;
      let total = list.total ?? list.tasks.length;
      if (list.tasks.length === 0 && total > 0 && filter.page > 1) {
        // A stale page number (rows were removed since the link was made): show the last page instead.
        filter = { ...filter, page: pageInfo(filter, total).pages };
        list = await fetchList(filter);
        total = list.total ?? total;
      }
      const counts = new Map<string, number>();
      for (const decision of pending?.decisions ?? []) {
        counts.set(decision.taskId, (counts.get(decision.taskId) ?? 0) + 1);
      }
      return {
        title: tr(lang, "title.tasks"),
        html: renderTaskList(list.tasks, counts, NAV_BASE, { filter, total, lang }),
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
        title: tr(lang, "title.task", { id: taskId }),
        html: renderTaskDetail(
          {
            detail,
            decisions: decisions?.decisions ?? [],
            executions: executions?.executions ?? [],
            claims: claims?.claims,
            evidence: evidence?.evidence,
            watches: watches?.watches,
            actions,
            preview: true,
          },
          NAV_BASE,
          lang,
        ),
        model: {
          decisions: decisions?.decisions ?? [],
          watches: watches?.watches ?? [],
          preferences: [],
          evidence: evidence?.evidence ?? [],
        },
      };
    }
    case "preferences": {
      const out = await request<{ preferences: PreferenceRecord[] }>("nexus.preference.list", {
        limit: 200,
      });
      return {
        title: tr(lang, "title.preferences"),
        html: renderPreferences(out.preferences, { actions, lang }),
        model: { decisions: [], watches: [], preferences: out.preferences, evidence: [] },
      };
    }
    case "files": {
      const [list, stats] = await Promise.all([
        request<VaultListResult & { extraction?: Record<string, VaultExtractionStatus> }>(
          "nexus.vault.list",
          fileListParams(route.tab),
        ),
        request<VaultStatsResult>("nexus.vault.stats"),
      ]);
      const files: VaultFileRecord[] = list.items;
      return {
        title: tr(lang, "title.files"),
        html: renderFiles(
          {
            files,
            total: list.total,
            tab: route.tab,
            stats,
            ...(list.extraction ? { extraction: list.extraction } : {}),
          },
          { actions, lang, basePath: NAV_BASE },
        ),
        model: {
          decisions: [],
          watches: [],
          preferences: [],
          evidence: [],
          files,
          ...(list.extraction ? { extraction: list.extraction } : {}),
        },
      };
    }
    default: {
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
        title: tr(lang, "title.receipts"),
        html: renderReceipts(tasks.receipts, preferences?.receipts, lang),
        model: EMPTY_MODEL,
      };
    }
  }
}
