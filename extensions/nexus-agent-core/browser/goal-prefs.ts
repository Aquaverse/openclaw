// Two page-menu switches of the Goals page, kept per viewer in this browser (a convenience, never state that matters):
// every read and write is guarded, and the page works with defaults when storage is missing or blocked.
export type GoalPrefs = { showSubtitle: boolean; autoSort: boolean };
export const DEFAULT_GOAL_PREFS: GoalPrefs = { showSubtitle: true, autoSort: true };
const KEY = "nexus-agent-core.goals.prefs";

/** Last values written in this page load: used when storage is unavailable, so a switch still applies until a reload. */
let memory: GoalPrefs | undefined;

type ReadStorage = Pick<Storage, "getItem">;
type WriteStorage = Pick<Storage, "setItem">;

function defaultStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function readGoalPrefs(storage: ReadStorage | undefined = defaultStorage()): GoalPrefs {
  try {
    const raw = storage?.getItem(KEY);
    if (!raw) {
      return memory ?? DEFAULT_GOAL_PREFS;
    }
    const parsed = JSON.parse(raw) as Partial<GoalPrefs> | null;
    return {
      showSubtitle:
        typeof parsed?.showSubtitle === "boolean"
          ? parsed.showSubtitle
          : DEFAULT_GOAL_PREFS.showSubtitle,
      autoSort:
        typeof parsed?.autoSort === "boolean" ? parsed.autoSort : DEFAULT_GOAL_PREFS.autoSort,
    };
  } catch {
    return memory ?? DEFAULT_GOAL_PREFS;
  }
}

export function writeGoalPrefs(
  prefs: GoalPrefs,
  storage: WriteStorage | undefined = defaultStorage(),
): void {
  memory = prefs;
  try {
    storage?.setItem(KEY, JSON.stringify(prefs));
  } catch {
    // Blocked or full storage: the switch still applies until the page reloads.
  }
}
