// Work list ordering and paging (the Work page reads 50 rows a page, grouped by state): real SQL on node:sqlite.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { requestFingerprint } from "../canonical.js";
import { A, setup } from "../test-support/goal-kit.js";
import type { WorkSpec } from "../work/types.js";

const kit = setup();
const { k, db, now } = kit;

let seq = 0;
function makeTask(work: WorkSpec) {
  seq += 1;
  const id = `L${seq}`;
  const key = `op_${id}`;
  return k.create({
    principal: A,
    id,
    kind: "errand",
    title: `task ${seq}`,
    goal: { text: `goal ${seq}` },
    entities: null,
    idempotencyKey: key,
    fingerprint: requestFingerprint({ kind: "errand", entities: null, goal: { key } }),
    sessionKey: "agent:main:main",
    now: now(),
    work,
  });
}
const setStatus = (taskId: string, status: string) =>
  db
    .prepare("UPDATE nexus_tasks SET status = ? WHERE owner_id = ? AND id = ?")
    .run(status, A.ownerId, taskId);
const created = (out: ReturnType<typeof makeTask>) => {
  assert.equal(out.outcome, "created");
  assert.ok("workId" in out && out.workId);
  return { task: out.task, workId: out.workId as string };
};

describe("work list order", () => {
  it("list can be ordered by state and paged: what needs the reader first, then the rest, newest first within a state", () => {
    const done = created(makeTask({ title: "order done", origin: "agent" }));
    setStatus(done.task.id, "succeeded");
    k.workEvaluate({ principal: A, workId: done.workId, now: now() });
    const running = created(makeTask({ title: "order running", origin: "agent" }));
    setStatus(running.task.id, "executing");
    const all = k.workList({ principal: A, now: now(), order: "state", limit: 500, offset: 0 });
    const rank: Record<string, number> = {
      needs_you: 0,
      blocked: 1,
      in_progress: 2,
      done: 3,
      ended_incomplete: 4,
    };
    const ranks = all.works.map((x) => rank[x.state.primary] ?? 9);
    assert.deepEqual(
      ranks,
      ranks.toSorted((a, b) => a - b),
      "grouped by state",
    );
    assert.ok(
      all.works.findIndex((x) => x.work.id === running.workId) <
        all.works.findIndex((x) => x.work.id === done.workId),
    );
    // Pages of the same order tile the whole list with no gap and no repeat.
    const pages = [0, 1, 2, 3].flatMap(
      (i) =>
        k.workList({ principal: A, now: now(), order: "state", limit: 2, offset: i * 2 }).works,
    );
    assert.deepEqual(
      pages.map((x) => x.work.id),
      all.works.slice(0, 8).map((x) => x.work.id),
    );
    assert.equal(
      k.workList({ principal: A, now: now(), order: "state", limit: 2, offset: 0 }).total,
      all.total,
    );
  });

  it("keyword search reads words, not the JSON arguments an agent stored as the request", () => {
    const json = created(
      makeTask({
        title: "book the train",
        origin: "agent",
        requestText: '{"passenger_relationship":"user and wife"}',
        outcomeText: '{"action":"book"}',
      }),
    );
    const spoken = created(
      makeTask({
        title: "plan the trip",
        origin: "user",
        requestText: "say hi to the hotel",
      }),
    );
    const ids = (keyword: string) =>
      k
        .workList({ principal: A, now: now(), keyword, limit: 50, offset: 0 })
        .works.map((x) => x.work.id);
    assert.deepEqual(ids("hi"), [spoken.workId]);
    assert.deepEqual(ids("train"), [json.workId]);
    assert.deepEqual(ids("passenger"), []);
  });
});
