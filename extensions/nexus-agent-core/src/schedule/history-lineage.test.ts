// Editing a running plan replaces it with a new plan whose checks are new schedules. The records of a check must not vanish with
// the edit: a check carries on the replaced plan's check of the same purpose, and reads its records as one history.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { dispatchKit } from "../test-support/dispatch-kit.js";
import { A } from "../test-support/goal-kit.js";

async function replaced(newPurposes: string[]) {
  const w = dispatchKit();
  const f = w.follow({ purpose: "查看 Issue" });
  w.advance(10_000);
  await w.dispatcher.tick();
  const old = w.triggers(f.scheduleId)[0]!;
  const planNow = w.k.delegationPlanGet({ principal: A, planId: f.planId }) as {
    plan: { planVersion: number };
  };
  const next = w.draft(w.workWithTask().workId, f.commitmentId, {
    plan: w.body({ schedules: newPurposes.map((purpose) => w.daily({ purpose })) }),
  });
  const done = w.accept(next.id, {
    replaces: { planId: f.planId, planVersion: planNow.plan.planVersion },
  });
  assert.equal(done.outcome, "accepted", JSON.stringify(done));
  const ids = (done as unknown as { schedules: { id: string }[] }).schedules.map((s) => s.id);
  // The order the accepted schedules come back in is not guaranteed: line them up with the purposes asked for.
  const purposeOf = (id: string) =>
    (w.db.prepare("SELECT purpose FROM schedules WHERE id = ?").get(id) as { purpose: string })
      .purpose;
  const created = newPurposes.map((purpose) => ids.find((id) => purposeOf(id) === purpose)!);
  return { w, f, old, created };
}

describe("check history across an edited plan", () => {
  it("a check with the same purpose shows the records of the one it replaced", async () => {
    const { w, old, created } = await replaced(["查看 Issue", "另一个检查"]);
    assert.ok(w.triggers(created[0]!).some((t) => t.id === old.id));
    // The other new check has no predecessor of that purpose: it starts with an empty history.
    assert.equal(w.triggers(created[1]!).length, 0);
  });

  it("a single check replaced by a single check keeps the history even when its words were edited", async () => {
    const { w, old, created } = await replaced(["查看 Issue 是否关闭"]);
    assert.ok(w.triggers(created[0]!).some((t) => t.id === old.id));
  });

  it("the full history list follows the same chain", async () => {
    const { w, old, created } = await replaced(["查看 Issue"]);
    const list = (await w.store.scheduleTriggerList({
      principal: A,
      scheduleId: created[0]!,
    })) as { outcome: string; triggers?: { id: string }[] };
    assert.equal(list.outcome, "ok");
    assert.ok(list.triggers?.some((t) => t.id === old.id));
  });
});
