// Marking old joint-worded Commitments (design 6.8a item 2, W3c-5): Commitments made before W3c-2 kept several typed names with no
// mark; the backfill marks the open ones, previews without writing, leaves "either one" and closed ones alone, and is repeatable.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, db, now } = kit;

let n = 0;
/** A Commitment as it was stored before W3c-2: the typed words kept, nobody responsible, no mark. */
const legacy = (name: string, over: { owner?: typeof A; text?: string } = {}) => {
  n += 1;
  const out = k.commitmentCreate({
    principal: over.owner ?? A,
    spec: {
      requirementText: over.text ?? `旧承诺 ${n}`,
      responsible: { kind: "name", name },
      origin: { kind: "native_record", refId: `bf_${n}` },
    },
    createdBy: "user",
    now: now(),
  });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  const id = (out as Extract<typeof out, { outcome: "created" }>).commitment.id;
  db.prepare("UPDATE commitments SET ambiguity_json = NULL WHERE id = ?").run(id);
  return id;
};
const mark = (id: string) =>
  (
    db.prepare("SELECT ambiguity_json AS a FROM commitments WHERE id = ?").get(id) as {
      a: string | null;
    }
  ).a;
const run = (dryRun: boolean, owner = A) =>
  k.commitmentJointBackfill({ principal: owner, dryRun, now: now() });

describe("commitment kernel: backfill of old joint wordings", () => {
  it("previews without writing, then marks and records an event", () => {
    const id = legacy("小王和小李一起");
    const single = legacy("小赵");
    const preview = run(true);
    assert.equal(preview.dryRun, true);
    assert.deepEqual(
      preview.marked.map((m) => [m.id, m.names]),
      [[id, ["小王", "小李"]]],
    );
    assert.equal(mark(id), null);

    const done = run(false);
    assert.deepEqual(
      done.marked.map((m) => m.id),
      [id],
    );
    assert.deepEqual(JSON.parse(mark(id) as string), { kind: "joint", names: ["小王", "小李"] });
    assert.equal(mark(single), null);
    const event = db
      .prepare(
        "SELECT payload_json FROM commitment_events WHERE commitment_id = ? AND kind = 'edited'",
      )
      .get(id) as { payload_json: string };
    assert.equal(JSON.parse(event.payload_json).reason, "backfill_joint");
  });

  it("is repeatable: a marked Commitment is not a candidate again", () => {
    legacy("阿甲、阿乙");
    assert.equal(run(false).marked.length, 1);
    const again = run(false);
    assert.equal(again.marked.length, 0);
    assert.equal(again.truncated, false);
  });

  it("only reports an 'either one is enough' wording and never changes it", () => {
    const id = legacy("小钱和小孙");
    // The create path refuses this wording today; an old row could still carry it.
    db.prepare("UPDATE commitments SET requirement_text = ? WHERE id = ?").run(
      "小钱和小孙谁有空谁做都行，任一人完成即可",
      id,
    );
    const out = run(false);
    assert.deepEqual(
      out.skippedEither.map((s) => s.id),
      [id],
    );
    assert.equal(
      out.marked.some((m) => m.id === id),
      false,
    );
    assert.equal(mark(id), null);
  });

  it("leaves closed Commitments and a name the user already has alone, and keeps owners apart", () => {
    const closed = legacy("丁和戊一起");
    k.commitmentCancel({ principal: A, commitmentId: closed, reason: "不做了", now: now() });
    k.counterpartCreate({ principal: A, displayName: "刘和平", now: now() });
    const known = legacy("刘和平");
    const other = legacy("己二和庚二一起", { owner: B });
    const out = run(false);
    assert.equal(
      out.marked.some((m) => [closed, known, other].includes(m.id)),
      false,
    );
    assert.equal(mark(other), null);
    const mine = run(false, B);
    assert.deepEqual(
      mine.marked.map((m) => m.id),
      [other],
      JSON.stringify(mine),
    );
  });

  it("lets the user choose afterwards, like any waiting Commitment", () => {
    const lead = k.counterpartCreate({ principal: A, displayName: "辛一", now: now() });
    assert.equal(lead.outcome, "created");
    const id = legacy("辛一和壬二一起");
    run(false);
    const leadId = (lead as Extract<typeof lead, { outcome: "created" }>).counterpart.id;
    const chosen = k.commitmentResolveJoint({
      principal: A,
      commitmentId: id,
      choice: { kind: "lead", leadId },
      now: now(),
    });
    assert.equal(chosen.outcome, "resolved", JSON.stringify(chosen));
    assert.equal(mark(id), null);
  });
});
