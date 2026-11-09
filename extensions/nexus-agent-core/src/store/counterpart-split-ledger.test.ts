// Counterpart kernel tests for the corrections that pull things apart (design 4.3.4, 7.5, 7.6 b and c, slice W3b-2): splitting
// one record that holds two people, and moving a contact method that was attached to the wrong person. Real SQL on node:sqlite.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import type { CommitmentSpec } from "../commitment/types.js";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, db, now } = kit;

const person = (name: string, over: Record<string, unknown> = {}, owner = A) => {
  const out = k.counterpartCreate({ principal: owner, displayName: name, now: now(), ...over });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).counterpart;
};
const commit = (text: string, responsible: CommitmentSpec["responsible"]) => {
  const out = k.commitmentCreate({
    principal: A,
    spec: {
      requirementText: text,
      responsible,
      origin: { kind: "native_record", refId: `ui_${text}` },
    },
    createdBy: "user",
    now: now(),
  });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as { commitment: { id: string } }).commitment.id;
};
const get = (id: string) => {
  const out = k.commitmentGet({ principal: A, commitmentId: id, now: now() });
  assert.equal(out.outcome, "ok");
  return out as Extract<typeof out, { outcome: "ok" }>;
};
const accept = (id: string) =>
  k.commitmentAcceptance({
    principal: A,
    commitmentId: id,
    state: "accepted",
    basis: "他口头答应了",
    actor: "user",
    now: now(),
  });
const view = (id: string) => {
  const out = k.counterpartView({ principal: A, counterpartId: id, now: now() });
  return (out as Extract<typeof out, { outcome: "ok" }>).view;
};
const links = (endpointId: string) =>
  db
    .prepare(
      "SELECT counterpart_id, status, valid_from, valid_to, version, supersedes_id FROM identity_links WHERE endpoint_id = ? ORDER BY version, rowid",
    )
    .all(endpointId) as Array<Record<string, unknown>>;

describe("counterpart kernel: split one record into two people", () => {
  let n = 0;
  const holdsTwo = () => {
    n += 1;
    const one = person(`王总${n}`, {
      aliases: ["老王", "王经理"],
      relation: { relation: "client" },
      contacts: [
        { type: "email", value: "wang.a@example.com" },
        { type: "phone", value: "13900002222" },
      ],
    });
    const open = commit(`王总${n}：周五前回电话`, { kind: "counterpart", counterpartId: one.id });
    accept(open);
    const stays = commit(`王总${n}：报价单`, { kind: "counterpart", counterpartId: one.id });
    const done = commit(`王总${n}：已寄样品`, { kind: "counterpart", counterpartId: one.id });
    k.commitmentResolve({
      principal: A,
      commitmentId: done,
      basis: "manual",
      reason: "确认完成",
      now: now(),
    } as never);
    return { one, open, stays, done };
  };

  it("previews what moves and what stays, changing nothing", () => {
    const { one, open, done } = holdsTwo();
    const preview = k.counterpartSplit({
      principal: A,
      counterpartId: one.id,
      displayName: "王经理（采购）",
      aliases: ["王经理"],
      contactIds: [one.contacts[1]!.id],
      commitmentIds: [open, done],
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview", JSON.stringify(preview));
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.deepEqual(
      [
        impact.movedContacts,
        impact.keptContacts,
        impact.movedAliases,
        impact.keptAliases,
        impact.movedOpenCommitments,
        impact.movedResolvedCommitments,
        impact.keptOpenCommitments,
      ],
      [1, 1, 1, 1, 1, 1, 1],
    );
    assert.equal(view(one.id).counterpart.contacts.length, 2);
    assert.equal(
      k.counterpartList({ principal: A, now: now(), keyword: "采购", limit: 10, offset: 0 }).total,
      0,
      "a preview creates nobody",
    );
  });

  it("moves the picked contacts, names and commitments to a new person, and gives the open ones a new responsibility version", () => {
    const { one, open, stays, done } = holdsTwo();
    const versionBefore = get(open).commitment.responsibilityVersion;
    const out = k.counterpartSplit({
      principal: A,
      counterpartId: one.id,
      displayName: "拆分出来的王",
      aliases: ["王经理"],
      contactIds: [one.contacts[1]!.id],
      commitmentIds: [open, done],
      relation: { relation: "supplier" },
      now: now(),
    });
    assert.equal(out.outcome, "split", JSON.stringify(out));
    const made = (out as Extract<typeof out, { outcome: "split" }>).created;
    assert.equal(made.displayName, "拆分出来的王");
    assert.equal(made.relation?.relation, "supplier");
    assert.deepEqual(
      made.contacts.map((c) => c.value),
      ["13900002222"],
    );
    assert.deepEqual(made.aliases, ["王经理"]);
    const rest = view(one.id).counterpart;
    assert.deepEqual(
      rest.contacts.map((c) => c.value),
      ["wang.a@example.com"],
    );
    assert.deepEqual(rest.aliases, ["老王"]);
    assert.equal(rest.relation?.relation, "client", "the record that is split keeps its relation");
    // Commitments: the open one is a different person's now (new version, states reset); the closed one keeps its result.
    const moved = get(open).commitment;
    assert.equal(moved.responsibleCounterpartId, made.id);
    assert.equal(moved.responsibilityVersion, versionBefore + 1);
    assert.equal(moved.acceptanceState, "unknown");
    const closed = get(done).commitment;
    assert.equal(closed.lifecycle, "resolved");
    assert.equal(closed.responsibleCounterpartId, made.id);
    // The one that was not picked stays.
    const kept = get(stays).commitment;
    assert.equal(kept.responsibleCounterpartId, one.id);
    // The contact link: the old row is kept as history and a new version points at the new person.
    const rows = links(one.contacts[1]!.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, "revoked");
    assert.equal(rows[1]?.counterpart_id, made.id);
    assert.equal(rows[1]?.version, 2);
    assert.equal(rows[1]?.supersedes_id !== null, true);
  });

  it("asks before it creates a second person who answers to a name that is taken, and refuses what is not the record's own", () => {
    const { one, open } = holdsTwo();
    const taken = k.counterpartSplit({
      principal: A,
      counterpartId: one.id,
      displayName: one.displayName,
      now: now(),
    });
    assert.equal(taken.outcome, "name_taken");
    const again = k.counterpartSplit({
      principal: A,
      counterpartId: one.id,
      displayName: one.displayName,
      allowSameName: true,
      now: now(),
    });
    assert.equal(again.outcome, "split", "an empty split is allowed when the user says so");
    // Somebody else's commitment, contact or name is not this record's to move.
    const other = person("别人");
    const theirs = commit("别人的承诺", { kind: "counterpart", counterpartId: other.id });
    for (const pick of [
      { commitmentIds: [theirs] },
      { contactIds: ["ep_nope"] },
      { aliases: ["不是别名"] },
    ]) {
      const out = k.counterpartSplit({
        principal: A,
        counterpartId: one.id,
        displayName: "另一位",
        allowSameName: true,
        now: now(),
        ...pick,
      });
      assert.equal(out.outcome, "invalid", JSON.stringify(pick));
      assert.equal((out as { code?: string }).code, "bad_selection");
    }
    assert.equal(get(open).commitment.responsibleCounterpartId, one.id);
  });

  it("will not split yourself, an organization into a colleague, or another owner's record", () => {
    const { one } = holdsTwo();
    const org = person("某机构", { kind: "organization" });
    assert.equal(
      k.counterpartSplit({
        principal: A,
        counterpartId: org.id,
        displayName: "分部同事",
        kind: "organization",
        relation: { relation: "colleague" },
        now: now(),
      }).outcome,
      "relation_conflict",
    );
    assert.equal(
      k.counterpartSplit({ principal: B, counterpartId: one.id, displayName: "X", now: now() })
        .outcome,
      "not_found",
    );
    assert.equal(
      k.counterpartSplit({
        principal: A,
        counterpartId: one.id,
        displayName: "过期",
        expectedRevision: 999,
        now: now(),
      }).outcome,
      "revision_conflict",
    );
  });
});

describe("counterpart kernel: a contact attached to the wrong person", () => {
  it("moves the contact to the right person from now on, keeping the old link as history", () => {
    const wrong = person("挂错的人", { contacts: [{ type: "email", value: "x@example.com" }] });
    const right = person("该挂的人");
    const endpoint = wrong.contacts[0]!.id;
    const preview = k.counterpartContactMove({
      principal: A,
      counterpartId: wrong.id,
      endpointId: endpoint,
      toId: right.id,
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.equal(impact.to?.displayName, "该挂的人");
    assert.equal(impact.duplicate, false);
    assert.equal(view(wrong.id).counterpart.contacts.length, 1, "a preview changes nothing");
    const out = k.counterpartContactMove({
      principal: A,
      counterpartId: wrong.id,
      endpointId: endpoint,
      toId: right.id,
      now: now(),
    });
    assert.equal(out.outcome, "moved", JSON.stringify(out));
    assert.equal(view(wrong.id).counterpart.contacts.length, 0);
    assert.deepEqual(
      view(right.id).counterpart.contacts.map((c) => c.value),
      ["x@example.com"],
    );
    const rows = links(endpoint);
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.status, "revoked");
    assert.ok(Number(rows[0]?.valid_to) > Number(rows[0]?.valid_from), "it counted until now");
    assert.equal(rows[1]?.counterpart_id, right.id);
    assert.equal(rows[1]?.valid_from, rows[0]?.valid_to, "and the new link starts where it ended");
  });

  it("'from the start' makes the old link never count, and sets aside the evidence read through the contact", () => {
    const wrong = person("一开始就错", {
      contacts: [{ type: "email", value: "start@example.com" }],
    });
    const right = person("一开始就对");
    const endpoint = wrong.contacts[0]!.id;
    const cm = commit("一开始就错的承诺", { kind: "counterpart", counterpartId: wrong.id });
    db.prepare(
      "INSERT INTO evidence_attributions (owner_id, id, commitment_id, evidence_kind, evidence_ref, endpoint_id, actor_role, event_at, identity_verdict, relevance_verdict, assessed_at) " +
        "VALUES (?, 'ea_1', ?, 'external_record', 'mail_1', ?, 'submitter', ?, 'matched', 'relevant', ?)",
    ).run(A.ownerId, cm, endpoint, now(), now());
    const preview = k.counterpartContactMove({
      principal: A,
      counterpartId: wrong.id,
      endpointId: endpoint,
      toId: right.id,
      fromStart: true,
      dryRun: true,
      now: now(),
    });
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.deepEqual([impact.attributions, impact.attributedCommitments], [1, 1]);
    const out = k.counterpartContactMove({
      principal: A,
      counterpartId: wrong.id,
      endpointId: endpoint,
      toId: right.id,
      fromStart: true,
      now: now(),
    });
    assert.equal(out.outcome, "moved", JSON.stringify(out));
    assert.deepEqual((out as { commitmentIds: string[] }).commitmentIds, [cm]);
    const rows = links(endpoint);
    assert.equal(rows[0]?.valid_to, rows[0]?.valid_from, "the old link never counted");
    assert.equal(rows[1]?.valid_from, rows[0]?.valid_from);
    const left = db
      .prepare("SELECT superseded_at FROM evidence_attributions WHERE id = 'ea_1'")
      .get() as { superseded_at: number | null };
    assert.ok(left.superseded_at !== null, "that evidence is judged again");
  });

  it("can say the contact belongs to nobody we know, and merges into a contact the other person already has", () => {
    const wrong = person("无主联系方式", {
      contacts: [
        { type: "phone", value: "13700003333" },
        { type: "email", value: "dup@example.com" },
      ],
    });
    const right = person("已有同样联系方式", {
      contacts: [{ type: "email", value: "DUP@example.com" }],
    });
    const nobody = k.counterpartContactMove({
      principal: A,
      counterpartId: wrong.id,
      endpointId: wrong.contacts[0]!.id,
      now: now(),
    });
    assert.equal(nobody.outcome, "moved", JSON.stringify(nobody));
    assert.equal(view(wrong.id).counterpart.contacts.length, 1);
    const dup = k.counterpartContactMove({
      principal: A,
      counterpartId: wrong.id,
      endpointId: wrong.contacts[1]!.id,
      toId: right.id,
      now: now(),
    });
    assert.equal(dup.outcome, "moved");
    assert.equal((dup as Extract<typeof dup, { outcome: "moved" }>).impact.duplicate, true);
    assert.equal(view(right.id).counterpart.contacts.length, 1, "still one contact, not two");
    assert.equal(view(wrong.id).counterpart.contacts.length, 0);
  });

  it("refuses the same record, yourself, a stopped person, someone else's contact and a stale revision", () => {
    const wrong = person("守卫", { contacts: [{ type: "email", value: "guard@example.com" }] });
    const right = person("守卫右");
    const endpoint = wrong.contacts[0]!.id;
    const call = (over: Record<string, unknown>) =>
      k.counterpartContactMove({
        principal: A,
        counterpartId: wrong.id,
        endpointId: endpoint,
        now: now(),
        ...over,
      });
    assert.equal(call({ toId: wrong.id }).outcome, "invalid");
    assert.equal(call({ endpointId: "ep_other" }).outcome, "contact_not_found");
    assert.equal(call({ toId: "cp_nobody" }).outcome, "not_found");
    assert.equal(call({ expectedRevision: 999, toId: right.id }).outcome, "revision_conflict");
    const stopped = person("已停用的右");
    assert.equal(
      k.counterpartDeactivate({
        principal: A,
        counterpartId: stopped.id,
        reason: "x",
        now: now(),
      }).outcome,
      "deactivated",
    );
    assert.equal(call({ toId: stopped.id }).outcome, "closed");
    assert.equal(
      k.counterpartContactMove({
        principal: B,
        counterpartId: wrong.id,
        endpointId: endpoint,
        now: now(),
      }).outcome,
      "not_found",
    );
    assert.equal(view(wrong.id).counterpart.contacts.length, 1, "nothing above changed it");
  });
});
