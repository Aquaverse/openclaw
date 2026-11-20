// Reads of the Dashboard. It observes: four list reads and one count, every one of them optional except the Work count
// (without it there is no page). The store is never reached directly, so the dashboard sees exactly what any RPC client
// would, and nothing here writes.
import type { CounterpartSummary } from "../src/counterpart/types.js";
import { renderDashboard } from "../src/dashboard-ui.js";
import { DEFAULT_LANG, tr, type Lang } from "../src/i18n.js";
import type { DecisionRecord } from "../src/store/decision-types.js";
import type { GoalSummaryRecord } from "../src/store/goal-types.js";
import type { WorkView } from "../src/store/work-facts.js";
import type { WorkCounts } from "../src/work-ui.js";
import { EMPTY_MODEL } from "./actions.ts";
import type { NexusFeatures, NexusRequest, NexusView } from "./data.ts";
import { NAV_BASE } from "./route.ts";

/** How many works the page reads for its attention and "recently updated" blocks. */
const WORKS_READ = 60;

async function optional<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    return undefined;
  }
}

export async function loadDashboardView(
  request: NexusRequest,
  features: NexusFeatures,
  options: { lang?: Lang } = {},
): Promise<NexusView> {
  const lang = options.lang ?? DEFAULT_LANG;
  if (features.works !== true) {
    return {
      title: tr(lang, "title.dashboard"),
      html: `<p class="ea-empty">${tr(lang, "dash.unavailable")}</p>`,
      model: EMPTY_MODEL,
    };
  }
  const now = Date.now();
  const [counts, listed, decisions, goals, people] = await Promise.all([
    request<WorkCounts>("nexus.work.counts", { top: 0 }),
    request<{ works: WorkView[] }>("nexus.work.list", {
      limit: WORKS_READ,
      offset: 0,
      order: "recent",
    }),
    optional(() =>
      request<{ decisions: DecisionRecord[] }>("nexus.decision.list", {
        statuses: ["pending"],
        limit: 50,
      }),
    ),
    features.goals === true
      ? optional(() =>
          request<{ goals: GoalSummaryRecord[] }>("nexus.goal.list", {
            status: "active",
            limit: 4,
            orderBy: "recent",
          }),
        )
      : Promise.resolve(undefined),
    optional(() =>
      request<{ items: CounterpartSummary[] }>("nexus.counterpart.list", {
        limit: 40,
        order: "name",
      }),
    ),
  ]);
  return {
    title: tr(lang, "title.dashboard"),
    html: renderDashboard(
      {
        counts,
        works: listed.works ?? [],
        decisions: decisions?.decisions ?? [],
        goals: goals?.goals ?? [],
        counterparts: people?.items ?? [],
        now,
        goalsEnabled: features.goals === true,
      },
      { lang, basePath: NAV_BASE },
    ),
    model: { ...EMPTY_MODEL, decisions: decisions?.decisions ?? [] },
  };
}
