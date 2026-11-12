// Reads for the Work page: the counts, the filtered list and the Work shown in the detail pane. Everything goes through the
// read-only `nexus.work.*` methods (operator.read), so the page sees exactly what any RPC client would.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type { FollowUpData } from "../src/follow-ui.js";
import { DEFAULT_LANG, tr, type Lang } from "../src/i18n.js";
import type { DecisionRecord } from "../src/store/decision-types.js";
import type { WorkView } from "../src/store/work-facts.js";
import {
  renderWorksPage,
  workActionModel,
  type WorkCounts,
  type WorkDetail,
} from "../src/work-ui.js";
import type { WorkPrimaryState } from "../src/work/types.js";
import { EMPTY_MODEL } from "./actions.ts";
import type { NexusRequest, NexusView } from "./data.ts";
import { readPeopleChoices } from "./people-data.ts";
import { NAV_BASE, type NexusRoute, type WorkFilter } from "./route.ts";

/** Rows per page of the list pane; the next page loads when the reader scrolls to the end. */
export const WORK_PAGE_SIZE = 50;
/** The most rows the server returns in one answer. */
const SERVER_PAGE_MAX = 200;

/** What the list pane needs after a mount to keep loading rows (the pager picks up where the page stopped). */
export type WorkListInit = {
  /** Beside the segments: what the search finds. */
  counts: WorkCounts;
  /** The whole account's, for the greeting. */
  overall: WorkCounts;
  filter: WorkFilter;
  total: number;
  loaded: number;
  /** The state of the final row loaded. */
  last: WorkPrimaryState | undefined;
  selected: string | undefined;
  decisions: readonly DecisionRecord[];
  now: number;
};

/** One page of the list, in the order the reader should see it: what needs them first, then the rest. */
export function readWorkPage(
  request: NexusRequest,
  filter: WorkFilter,
  offset: number,
  limit: number,
): Promise<{ works: WorkView[]; total?: number }> {
  return request<{ works: WorkView[]; total?: number }>("nexus.work.list", {
    limit,
    offset,
    order: "state",
    ...(filter.state ? { states: [filter.state] } : {}),
    ...(filter.q ? { keyword: filter.q } : {}),
  });
}

/** The five classes over what a search finds (the numbers beside the segments of a searched list). */
export const readWorkCounts = (request: NexusRequest, keyword?: string): Promise<WorkCounts> =>
  request<WorkCounts>("nexus.work.counts", { top: 0, ...(keyword ? { keyword } : {}) });

const isNotFound = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | undefined)?.code;
  const text = `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : String(error)}`;
  return text.includes("nexus_not_found") || text.includes("not found");
};

/** How many Works wait for the user right now (the badge on the Work entry). Any failure reads as "none". */
export async function workAttentionCount(request: NexusRequest): Promise<number> {
  try {
    const answer = await request<{ counts?: { needs_you?: unknown } }>("nexus.work.counts", {
      top: 0,
    });
    const n = answer.counts?.needs_you;
    return typeof n === "number" && n > 0 ? Math.floor(n) : 0;
  } catch {
    return 0;
  }
}

export async function loadWorksView(
  request: NexusRequest,
  route: Extract<NexusRoute, { view: "works" | "work" }>,
  options: {
    actions: boolean;
    lang?: Lang;
    /** At least this many rows (a reload keeps the pages already scrolled in). */ rows?: number;
  },
): Promise<NexusView> {
  const lang = options.lang ?? DEFAULT_LANG;
  const filter: WorkFilter = {
    ...(route.state ? { state: route.state } : {}),
    ...(route.q ? { q: route.q } : {}),
  };
  const want = Math.max(WORK_PAGE_SIZE, options.rows ?? 0);
  const [overall, first, pending, people] = await Promise.all([
    request<WorkCounts>("nexus.work.counts", { top: 0 }),
    readWorkPage(request, filter, 0, Math.min(want, SERVER_PAGE_MAX)),
    // Waiting decisions feed the rows and the ask card; a failure only means those show no decision.
    request<{ decisions: DecisionRecord[] }>("nexus.decision.list", {
      statuses: ["pending"],
      limit: 200,
    }).catch(() => ({ decisions: [] as DecisionRecord[] })),
    // The people a commitment can point at; without them the dialogs only offer a typed name.
    readPeopleChoices(request),
  ]);
  // The segments describe the search: with one, the numbers are counted over what it finds.
  const counts = route.q ? await readWorkCounts(request, route.q) : overall;
  const decisions = pending.decisions ?? [];
  const listed = [...first.works];
  const total = first.total ?? listed.length;
  // A reload that keeps more than one server page of rows reads the rest in turn.
  while (listed.length < want && listed.length < total) {
    const more = await readWorkPage(
      request,
      filter,
      listed.length,
      Math.min(want - listed.length, SERVER_PAGE_MAX),
    );
    if (more.works.length === 0) {
      break;
    }
    listed.push(...more.works);
  }
  const list = { works: listed };
  const now = Date.now();
  const explicit = route.view === "work";
  // With no Work named, the first row of the list is shown (the page's "ensure selection").
  const selectedId = route.view === "work" ? route.workId : list.works[0]?.work.id;
  let detail: WorkDetail | null = null;
  let missing = false;
  if (selectedId) {
    try {
      const [got, cited, followed] = await Promise.all([
        request<WorkDetail>("nexus.work.get", { workId: selectedId }),
        // The Commitments block only exists when commitments are switched on: a refusal means "not available", not an error.
        request<{ items: CommitmentLine[] }>("nexus.commitment.list", {
          workId: selectedId,
          limit: 100,
        }).catch(() => undefined),
        // Plans are optional too: a refusal means the follow-up block is not offered, not that the page failed.
        request<FollowUpData>("nexus.work.followUp", { workId: selectedId }).catch(() => undefined),
      ]);
      detail = {
        ...got,
        ...(cited ? { commitments: cited.items } : {}),
        ...(followed ? { followUp: followed } : {}),
      };
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      missing = explicit;
    }
  }
  return {
    title: tr(lang, "title.works"),
    html: renderWorksPage(
      {
        counts,
        overall,
        works: list.works,
        decisions,
        ...(route.state ? { state: route.state } : {}),
        ...(route.q ? { q: route.q } : {}),
        detail,
        missing,
        picked: explicit,
        now,
      },
      { actions: options.actions, lang, basePath: NAV_BASE },
    ),
    workList: {
      counts,
      overall,
      filter,
      total,
      loaded: listed.length,
      last: listed.at(-1)?.state.primary,
      selected: selectedId,
      decisions,
      now,
    },
    model: {
      ...EMPTY_MODEL,
      decisions,
      ...(detail ? { work: workActionModel(detail) } : {}),
      ...(detail?.commitments ? { commitments: detail.commitments } : {}),
      ...(detail?.followUp ? { followUp: detail.followUp } : {}),
      ...(people ? { people } : {}),
    },
  };
}
