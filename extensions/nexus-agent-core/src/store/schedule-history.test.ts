// The full check history of one schedule (W4c follow-up): newest first, a page at a time, no record twice or lost between pages,
// and nothing readable by another owner.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";

const kit = scheduleKit();
const { k, now, acceptedPlan } = kit;

type Page = {
  outcome: string;
  code?: string;
  triggers: { id: string; plannedAt: number }[];
  next?: string;
};
const page = (scheduleId: string, over: Record<string, unknown> = {}, owner = A) =>
  k.scheduleTriggerList({ principal: owner, scheduleId, ...over } as Parameters<
    typeof k.scheduleTriggerList
  >[0]) as unknown as Page;

describe("schedule check history", () => {
  const seed = (scheduleId: string, count: number) => {
    for (let i = 0; i < count; i++) {
      const out = k.scheduleRecordTrigger({
        principal: A,
        scheduleId,
        occurrenceKey: `h${i}`,
        // Two records share a time on purpose: paging must not drop or repeat either of them.
        plannedAt: 6_000_000 + Math.floor(i / 2) * 1000,
        source: i % 3 === 0 ? "manual" : "scheduled",
        outcome: "skipped",
        skipReason: "previous_check_open",
        now: now(),
      } as Parameters<typeof k.scheduleRecordTrigger>[0]);
      assert.equal(out.outcome, "recorded", JSON.stringify(out));
    }
  };

  it("pages through every record, newest first, each exactly once", () => {
    const a = acceptedPlan();
    seed(a.scheduleId, 7);
    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const got = page(a.scheduleId, { limit: 3, ...(cursor ? { before: cursor } : {}) });
      assert.equal(got.outcome, "ok");
      assert.ok(got.triggers.length <= 3);
      seen.push(...got.triggers.map((t) => t.id));
      cursor = got.next;
      pages++;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.equal(seen.length, 7);
    assert.equal(new Set(seen).size, 7, "no record repeated");
    const times = page(a.scheduleId, { limit: 50 }).triggers.map((t) => t.plannedAt);
    assert.deepEqual(
      times,
      times.toSorted((x, y) => y - x),
      "newest first",
    );
    assert.equal(page(a.scheduleId, { limit: 50 }).next, undefined, "the last page has no cursor");
  });

  it("an empty history is an empty list; a bad cursor and a foreign owner are refused", () => {
    const a = acceptedPlan();
    assert.deepEqual(page(a.scheduleId).triggers, []);
    assert.equal(page(a.scheduleId, { before: "nonsense" }).outcome, "invalid");
    assert.equal(page(a.scheduleId, {}, B).outcome, "not_found");
    assert.equal(page("no-such-schedule").outcome, "not_found");
  });
});
