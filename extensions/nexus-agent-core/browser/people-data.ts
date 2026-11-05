// Reads for the People page: the people, the typed names waiting to be confirmed, and the person shown in the detail pane.
// Everything goes through the read-only `nexus.counterpart.*` methods (operator.read), so the page sees exactly what any RPC client
// would. The same people list feeds the "choose a person" field of the commitment dialogs on the Work page.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type {
  CounterpartSummary,
  DismissedName,
  PendingPersonGroup,
  PersonView,
} from "../src/counterpart/types.js";
import { DEFAULT_LANG, tr, type Lang } from "../src/i18n.js";
import {
  personActionModel,
  renderPeoplePage,
  type PeopleCounts,
  type PeopleSeg,
} from "../src/people-ui.js";
import { EMPTY_MODEL } from "./actions.ts";
import type { PersonChoice } from "./commitment-form.ts";
import type { NexusRequest, NexusView } from "./data.ts";
import { NAV_BASE, type NexusRoute } from "./route.ts";

/** At most this many people are read in one answer; the server's limit. */
const PEOPLE_MAX = 200;
/** Rows per page of the list pane; the next page loads when the reader scrolls to the end. */
export const PEOPLE_PAGE_SIZE = 50;

/** What the list pane needs after a mount to keep loading rows. */
export type PeopleListInit = {
  seg: PeopleSeg | undefined;
  q: string;
  total: number;
  loaded: number;
  selected: string | undefined;
  /** The typed names waiting to be confirmed (the full list shows a note about them above the rows). */
  pending: readonly PendingPersonGroup[];
};

type PeoplePage = {
  items: CounterpartSummary[];
  total: number;
  counts: PeopleCounts;
};

/** One page of the live or inactive people, by segment and name search (the server filters and orders). */
export async function readPeoplePage(
  request: NexusRequest,
  list: { seg?: PeopleSeg | undefined; q?: string | undefined },
  offset: number,
  limit: number,
): Promise<PeoplePage> {
  const answer = await request<Partial<PeoplePage>>("nexus.counterpart.list", {
    lifecycle: list.seg === "inactive" ? "inactive" : "live",
    ...(list.seg === "attention" ? { attention: true } : {}),
    ...(list.q ? { keyword: list.q } : {}),
    limit,
    offset,
  });
  const items = answer.items ?? [];
  return {
    items,
    total: answer.total ?? offset + items.length,
    counts: answer.counts ?? {
      all: items.length,
      attention: items.filter((p) => p.overdue > 0 || p.needsConfirmation > 0).length,
    },
  };
}

/** The people a commitment can point at, with every name each answers to (so a typed name can be matched to a record). */
export function personChoices(items: readonly CounterpartSummary[]): PersonChoice[] {
  return items.map((p) => ({
    id: p.id,
    name: p.displayName,
    relation: p.relation?.relation ?? null,
    names: [p.displayName, ...p.aliases],
    kind: p.kind,
  }));
}

/** The live people, or undefined when the people API is not served (people then simply cannot be chosen). */
export async function readPeopleChoices(
  request: NexusRequest,
): Promise<PersonChoice[] | undefined> {
  try {
    const answer = await request<{ items?: CounterpartSummary[] }>("nexus.counterpart.list", {
      lifecycle: "live",
      limit: PEOPLE_MAX,
    });
    return personChoices(answer.items ?? []);
  } catch {
    return undefined;
  }
}

const isNotFound = (error: unknown): boolean => {
  const code = (error as { code?: unknown } | undefined)?.code;
  const text = `${typeof code === "string" ? code : ""} ${error instanceof Error ? error.message : String(error)}`;
  return text.includes("nexus_not_found") || text.includes("not found");
};

export async function loadPeopleView(
  request: NexusRequest,
  route: Extract<NexusRoute, { view: "people" }>,
  options: {
    actions: boolean;
    lang?: Lang;
    /** At least this many rows (a reload keeps the pages already scrolled in). */ rows?: number;
  },
): Promise<NexusView> {
  const lang = options.lang ?? DEFAULT_LANG;
  const q = route.q ?? "";
  const list = { seg: route.seg, q: route.seg === "pending" ? "" : q };
  const want = Math.max(PEOPLE_PAGE_SIZE, options.rows ?? 0);
  const [first, whole, pending, dismissed, choices] = await Promise.all([
    // The rows of the segment shown. The pending segment lists typed names, not people, so it reads no rows (one is read
    // for the counts, and dropped).
    route.seg === "pending"
      ? readPeoplePage(request, {}, 0, 1).then((page) => ({ ...page, items: [], total: 0 }))
      : readPeoplePage(request, list, 0, Math.min(want, PEOPLE_MAX)),
    // The greeting speaks for the whole account, so a search needs its own read of the unsearched counts.
    list.q === "" ? Promise.resolve(undefined) : readPeoplePage(request, {}, 0, 1),
    request<{ groups: PendingPersonGroup[] }>("nexus.counterpart.pending"),
    // The ignored names are listed under "to confirm"; a gateway that does not serve them just shows none.
    route.seg === "pending"
      ? request<{ items: DismissedName[] }>("nexus.counterpart.dismissed").catch(() => ({
          items: [] as DismissedName[],
        }))
      : Promise.resolve({ items: [] as DismissedName[] }),
    // The people the dialogs can choose from do not depend on the page of the list that is open.
    readPeopleChoices(request),
  ]);
  // The segments' numbers follow the search; the greeting does not.
  const counts = first.counts;
  const overall = whole ? whole.counts : counts;
  const shown = [...first.items];
  // A reload that keeps more than one server page of rows reads the rest in turn.
  while (shown.length < want && shown.length < first.total) {
    const more = await readPeoplePage(
      request,
      list,
      shown.length,
      Math.min(want - shown.length, PEOPLE_MAX),
    );
    if (more.items.length === 0) {
      break;
    }
    shown.push(...more.items);
  }
  const groups = pending.groups ?? [];
  const explicit = route.personId !== undefined;
  // With no one named, the first row of the list is shown (as the Work page does); the "to confirm" names have no detail.
  const selectedId = route.personId ?? shown[0]?.id;
  let view: PersonView | undefined;
  let missing = false;
  if (selectedId) {
    try {
      view = (
        await request<{ view: PersonView }>("nexus.counterpart.get", { counterpartId: selectedId })
      ).view;
    } catch (error) {
      if (!isNotFound(error)) {
        throw error;
      }
      missing = explicit;
    }
  }
  const now = Date.now();
  const lines: CommitmentLine[] = view
    ? [...view.responsible, ...view.history].map((commitment) => ({
        commitment,
        role: null,
        linkId: null,
      }))
    : [];
  return {
    title: tr(lang, "pp.title"),
    html: renderPeoplePage(
      {
        items: route.seg === "inactive" ? [] : shown,
        inactive: route.seg === "inactive" ? shown : [],
        counts,
        overall,
        ...(list.q ? { q: list.q } : {}),
        pending: groups,
        dismissed: dismissed.items ?? [],
        ...(route.seg ? { seg: route.seg } : {}),
        tab: route.tab ?? "responsible",
        view: view ?? null,
        missing,
        picked: explicit,
        now,
      },
      { actions: options.actions, lang, basePath: NAV_BASE },
    ),
    ...(route.seg === "pending"
      ? {}
      : {
          peopleList: {
            seg: route.seg,
            q: list.q,
            total: first.total,
            loaded: shown.length,
            selected: selectedId,
            pending: groups,
          },
        }),
    model: {
      ...EMPTY_MODEL,
      people: choices ?? personChoices(shown),
      pending: groups,
      dismissed: dismissed.items ?? [],
      ...(view ? { person: personActionModel(view.counterpart) } : {}),
      commitments: lines,
    },
  };
}
