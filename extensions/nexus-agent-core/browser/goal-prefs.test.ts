import { describe, expect, it } from "vitest";
import { DEFAULT_GOAL_PREFS, readGoalPrefs, writeGoalPrefs } from "./goal-prefs.ts";

const store = (initial?: string) => {
  const data = new Map<string, string>();
  if (initial !== undefined) {
    data.set("nexus-agent-core.goals.prefs", initial);
  }
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
};

describe("goal prefs", () => {
  it("round-trips through storage and ignores junk", () => {
    const s = store();
    writeGoalPrefs({ showSubtitle: false, autoSort: false }, s);
    expect(readGoalPrefs(s)).toEqual({ showSubtitle: false, autoSort: false });
    expect(readGoalPrefs(store("not json"))).toEqual(
      expect.objectContaining({ showSubtitle: expect.any(Boolean) }),
    );
    expect(readGoalPrefs(store('{"showSubtitle":"yes","autoSort":false}'))).toEqual({
      showSubtitle: DEFAULT_GOAL_PREFS.showSubtitle,
      autoSort: false,
    });
  });

  it("still applies a switch when storage throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    writeGoalPrefs({ showSubtitle: false, autoSort: true }, broken);
    expect(readGoalPrefs(broken)).toEqual({ showSubtitle: false, autoSort: true });
    writeGoalPrefs(DEFAULT_GOAL_PREFS, broken);
  });
});
