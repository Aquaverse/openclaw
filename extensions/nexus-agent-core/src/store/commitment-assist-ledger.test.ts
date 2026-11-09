// Commitment kernel tests for "the people who help" (design 6.8, W3c-1): add and remove helpers with a role, never the responsible
// person (INV-08), the link ends when that person becomes responsible, a helper changes nothing about who answers or what was told
// or accepted, and the person page lists what he helps with. Real SQL on node:sqlite.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, db, now } = kit;

const person = (name: string, owner = A) => {
  const out = k.counterpartCreate({ principal: owner, displayName: name, now: now() });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).counterpart;
};
let n = 0;
const commitment = (responsible: string, owner = A) => {
  n += 1;
  const out = k.commitmentCreate({
    principal: owner,
    spec: {
      requirementText: `报价表 ${n}`,
      responsible: { kind: "counterpart", counterpartId: responsible },
      origin: { kind: "native_record", refId: `ui_assist_${n}` },
    },
    createdBy: "user",
    now: now(),
  });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).commitment;
};
const add = (commitmentId: string, counterpartId: string, role = "participant", owner = A) =>
  k.commitmentAssistAdd({
    principal: owner,
    commitmentId,
    counterpartId,
    role: role as "participant",
    now: now(),
  });
const helpers = (commitmentId: string, owner = A) => {
  const out = k.commitmentGet({ principal: owner, commitmentId, now: now() });
  assert.equal(out.outcome, "ok");
  return (out as Extract<typeof out, { outcome: "ok" }>).helpers;
};

describe("commitment kernel: the people who help", () => {
  it("adds a helper with a role, lists him, and counts him on the commitment", () => {
    const wang = person("王总");
    const li = person("李明");
    const c = commitment(wang.id);
    const out = add(c.id, li.id, "approver");
    assert.equal(out.outcome, "added", JSON.stringify(out));
    const list = helpers(c.id);
    assert.equal(list.length, 1);
    assert.deepEqual(
      { name: list[0]?.displayName, role: list[0]?.role, version: list[0]?.responsibilityVersion },
      { name: "李明", role: "approver", version: 1 },
    );
    const again = k.commitmentGet({ principal: A, commitmentId: c.id, now: now() });
    assert.equal(
      (again as { commitment: { participantCount?: number } }).commitment.participantCount,
      1,
    );
    const row = db
      .prepare(
        "SELECT status, valid_from, basis_text FROM commitment_participant_links WHERE commitment_id = ?",
      )
      .get(c.id) as { status: string; valid_from: number | null; basis_text: string };
    assert.equal(row.status, "confirmed");
    assert.ok(row.valid_from !== null);
    assert.ok(row.basis_text.length > 0);
  });

  it("is idempotent for the same person and role, and one person can hold two roles", () => {
    const wang = person("王总二");
    const li = person("李明二");
    const c = commitment(wang.id);
    const first = add(c.id, li.id, "participant");
    const second = add(c.id, li.id, "participant");
    assert.equal(first.outcome, "added");
    assert.equal(second.outcome, "exists", JSON.stringify(second));
    assert.equal(add(c.id, li.id, "recipient").outcome, "added");
    assert.equal(helpers(c.id).length, 2);
  });

  it("refuses the responsible person, a missing or deleted person, a bad role, a long note and a closed commitment", () => {
    const wang = person("王总三");
    const li = person("李明三");
    const gone = person("已删除三");
    k.counterpartDeactivate({
      principal: A,
      counterpartId: gone.id,
      reason: "不再合作",
      now: now(),
    });
    const c = commitment(wang.id);
    const code = (out: { outcome: string }) =>
      out.outcome === "invalid" ? (out as unknown as { code: string }).code : out.outcome;
    assert.equal(code(add(c.id, wang.id)), "is_responsible");
    assert.equal(code(add(c.id, "cp_nobody")), "counterpart_not_found");
    assert.equal(code(add(c.id, gone.id)), "counterpart_not_found");
    assert.equal(code(add(c.id, li.id, "responsible")), "bad_role");
    assert.equal(
      code(
        k.commitmentAssistAdd({
          principal: A,
          commitmentId: c.id,
          counterpartId: li.id,
          role: "participant",
          purpose: "x".repeat(201),
          now: now(),
        }),
      ),
      "bad_purpose",
    );
    assert.equal(code(add("cm_nope", li.id)), "not_found");
    const cancelled = k.commitmentCancel({
      principal: A,
      commitmentId: c.id,
      reason: "不做了",
      now: now(),
    });
    assert.equal(cancelled.outcome, "cancelled", JSON.stringify(cancelled));
    assert.equal(code(add(c.id, li.id)), "closed");
    assert.equal(helpers(c.id).length, 0);
  });

  it("limits how many people can help with one commitment", () => {
    const wang = person("王总四");
    const c = commitment(wang.id);
    for (let i = 0; i < 20; i += 1) {
      assert.equal(add(c.id, person(`帮手${i}`).id).outcome, "added");
    }
    const over = add(c.id, person("第二十一位").id);
    assert.equal(over.outcome, "invalid");
    assert.equal((over as { code: string }).code, "too_many");
  });

  it("removing keeps the history: the link is revoked with a time, and the person can be added again", () => {
    const wang = person("王总五");
    const li = person("李明五");
    const c = commitment(wang.id);
    const added = add(c.id, li.id) as Extract<ReturnType<typeof add>, { outcome: "added" }>;
    const removed = k.commitmentAssistRemove({
      principal: A,
      commitmentId: c.id,
      linkId: added.helper.id,
      now: now(),
    });
    assert.equal(removed.outcome, "removed", JSON.stringify(removed));
    assert.equal(helpers(c.id).length, 0);
    const row = db
      .prepare("SELECT status, revoked_at, valid_to FROM commitment_participant_links WHERE id = ?")
      .get(added.helper.id) as {
      status: string;
      revoked_at: number | null;
      valid_to: number | null;
    };
    assert.equal(row.status, "revoked");
    assert.ok(row.revoked_at !== null && row.valid_to === row.revoked_at);
    // removing twice, or a link of another commitment, is "not found"
    assert.equal(
      k.commitmentAssistRemove({
        principal: A,
        commitmentId: c.id,
        linkId: added.helper.id,
        now: now(),
      }).outcome,
      "not_found",
    );
    assert.equal(add(c.id, li.id).outcome, "added");
  });

  it("changes nothing about who answers, what was told or accepted, or the responsibility version", () => {
    const wang = person("王总六");
    const li = person("李明六");
    const c = commitment(wang.id);
    const before = db
      .prepare(
        "SELECT responsible_counterpart_id AS r, responsibility_version AS v, communication_state AS cs, acceptance_state AS a, lifecycle AS l, revision FROM commitments WHERE id = ?",
      )
      .get(c.id);
    add(c.id, li.id, "approver");
    add(c.id, person("小张六").id, "recipient");
    const after = db
      .prepare(
        "SELECT responsible_counterpart_id AS r, responsibility_version AS v, communication_state AS cs, acceptance_state AS a, lifecycle AS l, revision FROM commitments WHERE id = ?",
      )
      .get(c.id);
    assert.deepEqual({ ...after }, { ...before });
    const events = (
      db
        .prepare(
          "SELECT kind, payload_json FROM commitment_events WHERE commitment_id = ? ORDER BY seq",
        )
        .all(c.id) as { kind: string; payload_json: string }[]
    ).map(
      (e) =>
        `${e.kind}:${(JSON.parse(e.payload_json) as { changed?: string[] }).changed?.[0] ?? ""}`,
    );
    assert.deepEqual(events, ["created:", "edited:helper_added", "edited:helper_added"]);
  });

  it("when a helper becomes the responsible person, his helper link ends (INV-08); the others stay", () => {
    const wang = person("王总七");
    const li = person("李明七");
    const zhang = person("小张七");
    const c = commitment(wang.id);
    add(c.id, li.id);
    add(c.id, zhang.id, "approver");
    const out = k.commitmentUpdate({
      principal: A,
      commitmentId: c.id,
      changes: { responsible: { kind: "counterpart", counterpartId: li.id } },
      actor: "user",
      now: now(),
    });
    assert.equal(out.outcome, "updated", JSON.stringify(out));
    assert.deepEqual(
      helpers(c.id).map((h) => h.displayName),
      ["小张七"],
    );
    // the earlier link stays in the table as history
    assert.equal(
      Number(
        (
          db
            .prepare(
              "SELECT COUNT(*) AS n FROM commitment_participant_links WHERE commitment_id = ? AND status = 'revoked'",
            )
            .get(c.id) as { n: number }
        ).n,
      ),
      1,
    );
    // the responsibility version moved on, and the remaining helper keeps the version he was added under
    assert.equal(helpers(c.id)[0]?.responsibilityVersion, 1);
    assert.equal(
      (
        k.commitmentGet({ principal: A, commitmentId: c.id, now: now() }) as {
          commitment: { responsibilityVersion: number };
        }
      ).commitment.responsibilityVersion,
      2,
    );
  });

  it("merging two people ends the helper link of the one who is now responsible", () => {
    const wang = person("王总八");
    const li = person("李明八");
    const c = commitment(wang.id);
    add(c.id, li.id);
    const merged = k.counterpartMerge({
      principal: A,
      counterpartId: li.id,
      intoId: wang.id,
      now: now(),
    });
    assert.equal(merged.outcome, "merged", JSON.stringify(merged));
    assert.equal(
      helpers(c.id).length,
      0,
      "wang is responsible for it, so he cannot also be a helper",
    );
  });

  it("the person page lists what he helps with, with his roles, and keeps it apart from what he answers for", () => {
    const wang = person("王总九");
    const li = person("李明九");
    const own = commitment(li.id);
    const c = commitment(wang.id);
    add(c.id, li.id, "approver");
    add(c.id, li.id, "recipient");
    const view = k.counterpartView({ principal: A, counterpartId: li.id, now: now() });
    assert.equal(view.outcome, "ok");
    const v = (view as Extract<typeof view, { outcome: "ok" }>).view;
    assert.deepEqual(
      v.responsible.map((r) => r.id),
      [own.id],
    );
    assert.equal(v.assisting?.length, 1);
    assert.equal(v.assisting?.[0]?.commitment.id, c.id);
    assert.deepEqual(v.assisting?.[0]?.roles, ["approver", "recipient"]);
    assert.equal(v.counts.unresolved, 1, "what he helps with is not counted as his open work");
  });

  it("never reaches another owner's commitments or people", () => {
    const wang = person("王总十");
    const c = commitment(wang.id);
    const theirs = person("乙的人", B);
    assert.equal(add(c.id, theirs.id, "participant", B).outcome, "not_found");
    const mine = person("我的帮手");
    assert.equal(add(c.id, mine.id, "participant", B).outcome, "not_found");
    const intruder = k.commitmentAssistAdd({
      principal: B,
      commitmentId: c.id,
      counterpartId: theirs.id,
      role: "participant",
      now: now(),
    });
    assert.equal(intruder.outcome, "not_found");
    assert.equal(helpers(c.id).length, 0);
  });
});
