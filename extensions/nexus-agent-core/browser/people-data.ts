// Reads for the People page: the people, the typed names waiting to be confirmed, and the person shown in the detail pane.
// Everything goes through the read-only `nexus.counterpart.*` methods (operator.read), so the page sees exactly what any RPC client
// would. The same people list feeds the "choose a person" field of the commitment dialogs on the Work page.
import type { CommitmentLine } from "../src/commitment-ui.js";
import type {
  CounterpartSummary,
  PendingPersonGroup,
  PersonView,
} from "../src/counterpart/types.js";
import { DEFAULT_LANG, tr, type Lang } from "../src/i18n.js";
import { personActionModel, renderPeoplePage } from "../src/people-ui.js";
import { EMPTY_MODEL } from "./actions.ts";
import type { PersonChoice } from "./commitment-form.ts";
import type { NexusRequest, NexusView } from "./data.ts";
import { NAV_BASE, type NexusRoute } from "./route.ts";

/** At most this many people are read; the server's limit. */
const PEOPLE_MAX = 200;

/** The people a commitment can point at, with every name each answers to (so a typed name can be matched to a record). */
export function personChoices(items: readonly CounterpartSummary[]): PersonChoice[] {
  return items.map((p) => ({
    id: p.id,
    name: p.displayName,
    relation: p.relation?.relation ?? null,
    names: [p.displayName, ...p.aliases],
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
  options: { actions: boolean; lang?: Lang },
): Promise<NexusView> {
  const lang = options.lang ?? DEFAULT_LANG;
  const [live, pending, inactive] = await Promise.all([
    request<{ items: CounterpartSummary[] }>("nexus.counterpart.list", {
      lifecycle: "live",
      limit: PEOPLE_MAX,
    }),
    request<{ groups: PendingPersonGroup[] }>("nexus.counterpart.pending"),
    route.seg === "inactive"
      ? request<{ items: CounterpartSummary[] }>("nexus.counterpart.list", {
          lifecycle: "inactive",
          limit: PEOPLE_MAX,
        })
      : Promise.resolve({ items: [] as CounterpartSummary[] }),
  ]);
  const items = live.items ?? [];
  const groups = pending.groups ?? [];
  const shown =
    route.seg === "inactive"
      ? (inactive.items ?? [])
      : route.seg === "attention"
        ? items.filter((p) => p.overdue > 0 || p.needsConfirmation > 0)
        : route.seg === "pending"
          ? []
          : items;
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
        items,
        inactive: inactive.items ?? [],
        pending: groups,
        ...(route.seg ? { seg: route.seg } : {}),
        tab: route.tab ?? "responsible",
        view: view ?? null,
        missing,
        picked: explicit,
        now,
      },
      { actions: options.actions, lang, basePath: NAV_BASE },
    ),
    model: {
      ...EMPTY_MODEL,
      people: personChoices(items),
      pending: groups,
      ...(view ? { person: personActionModel(view.counterpart) } : {}),
      commitments: lines,
    },
  };
}
