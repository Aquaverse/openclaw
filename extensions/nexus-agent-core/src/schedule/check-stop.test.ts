// The per-check "stop at first change" (`ScheduleSpec.stop`): only the one known stop is accepted when a plan is drafted, and
// each check keeps its own stop when the plan is accepted, so one check of a plan can stop while another keeps following.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A } from "../test-support/goal-kit.js";
import { scheduleKit } from "../test-support/schedule-kit.js";
import { STOP_AT_FIRST_CHANGE, stopsAtFirstChange } from "./types.js";

describe("per-check stop at first change", () => {
  it("recognises only the one stop it knows", () => {
    assert.equal(stopsAtFirstChange(STOP_AT_FIRST_CHANGE), true);
    assert.equal(stopsAtFirstChange({ kind: "first_change" }), true);
    for (const other of [undefined, null, "first_change", {}, { kind: "until" }, 1]) {
      assert.equal(stopsAtFirstChange(other), false);
    }
  });

  it("refuses a plan whose check carries an unknown stop", () => {
    const w = scheduleKit();
    const work = w.workWithTask();
    const out = w.k.delegationPlanCreate({
      principal: A,
      workId: work.workId,
      planOwnerType: "commitment",
      planOwnerId: w.commitment(),
      purpose: "跟进",
      plan: w.body({ schedules: [w.daily({ stop: { kind: "whenever" } })] }),
      createdBy: "user",
      now: w.now(),
    });
    assert.notEqual(out.outcome, "created");
    assert.match(JSON.stringify(out), /bad_stop/);
  });

  it("each check of an accepted plan keeps its own stop", () => {
    const w = scheduleKit();
    const work = w.workWithTask();
    const plan = w.draft(work.workId, w.commitment(), {
      plan: w.body({
        schedules: [
          w.daily({ purpose: "等 Issue 关闭", stop: STOP_AT_FIRST_CHANGE }),
          w.daily({ purpose: "每天看一眼进展" }),
        ],
      }),
    });
    const done = w.accept(plan.id);
    assert.equal(done.outcome, "accepted", JSON.stringify(done));
    const ids = (done as { schedules: { id: string }[] }).schedules.map((s) => s.id);
    // Looked up by the check's purpose: the order the accepted schedules come back in is not part of what is tested.
    const stopOf = (purpose: string): unknown => {
      const rows = ids.map(
        (id) =>
          w.db.prepare("SELECT purpose, stop_json FROM schedules WHERE id = ?").get(id) as {
            purpose: string;
            stop_json: string | null;
          },
      );
      const row = rows.find((r) => r.purpose === purpose);
      return row?.stop_json === null || row === undefined ? null : JSON.parse(row.stop_json);
    };
    assert.deepEqual(stopOf("等 Issue 关闭"), STOP_AT_FIRST_CHANGE);
    assert.equal(stopOf("每天看一眼进展"), null);
  });
});
