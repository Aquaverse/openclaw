// Counterpart kernel tests for clearing a deleted person (PRD R-32, FG; slice "清理人员"): only deleted people can be cleared; the
// contact methods, other names and relations go for good while the name and the Commitment history stay; one receipt per person
// with counts and a hash. Real SQL on node:sqlite.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { sha256Hex } from "../canonical.js";
import { A, B, setup } from "../test-support/goal-kit.js";
import { normalizeName } from "./counterpart-common.js";

const kit = setup();
const { k, db, now } = kit;

const person = (name: string, over: Record<string, unknown> = {}, owner = A) => {
  const out = k.counterpartCreate({ principal: owner, displayName: name, now: now(), ...over });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).counterpart;
};
const remove = (id: string, owner = A) => {
  const out = k.counterpartDeactivate({
    principal: owner,
    counterpartId: id,
    reason: "不再合作",
    now: now(),
  });
  assert.equal(out.outcome, "deactivated", JSON.stringify(out));
};
const count = (sql: string, ...args: string[]) =>
  Number((db.prepare(sql).get(...args) as { n: number }).n);
const lifecycleOf = (id: string) =>
  (db.prepare("SELECT lifecycle FROM counterparts WHERE id = ?").get(id) as { lifecycle: string })
    .lifecycle;

const rich = (name: string) =>
  person(name, {
    aliases: [`${name}别名`, `${name}小名`],
    relation: { relation: "client" },
    contacts: [
      { type: "email", value: `${name}@example.com` },
      { type: "phone", value: "13900001111" },
    ],
  });

describe("counterpart kernel: clear a deleted person", () => {
  it("only clears people who are deleted, and says why it skipped the others", () => {
    const live = person("还在合作的人");
    const gone = person("已删除的人");
    remove(gone.id);
    // the owner's own identity row exists once a Commitment names "self"
    const mine = k.commitmentCreate({
      principal: A,
      spec: {
        requirementText: "我自己的事",
        responsible: { kind: "self" },
        origin: { kind: "native_record", refId: "ui_purge_self" },
      },
      createdBy: "user",
      now: now(),
    });
    assert.equal(mine.outcome, "created", JSON.stringify(mine));
    const self = (
      db
        .prepare("SELECT self_counterpart_id AS id FROM owner_identity WHERE owner_id = ?")
        .get(A.ownerId) as {
        id: string;
      }
    ).id;
    const out = k.counterpartPurge({
      principal: A,
      counterpartIds: [live.id, gone.id, self, "cp_nobody"],
      now: now(),
    });
    assert.equal(out.outcome, "purged", JSON.stringify(out));
    const done = out as Extract<typeof out, { outcome: "purged" }>;
    assert.deepEqual(
      done.purged.map((p) => p.id),
      [gone.id],
    );
    assert.deepEqual(
      done.skipped.toSorted((a, b) => a.id.localeCompare(b.id)),
      [
        { id: "cp_nobody", reason: "not_found" },
        { id: self, reason: "self" },
        { id: live.id, reason: "not_deleted" },
      ].toSorted((a, b) => a.id.localeCompare(b.id)),
    );
    assert.equal(lifecycleOf(live.id), "live");
    const nothing = k.counterpartPurge({ principal: A, counterpartIds: [live.id], now: now() });
    assert.equal(nothing.outcome, "nothing_to_purge");
    assert.equal(
      k.counterpartPurge({ principal: A, counterpartIds: [], now: now() }).outcome,
      "invalid",
    );
  });

  it("previews exactly what would go and changes nothing", () => {
    const p = rich("预览");
    remove(p.id);
    const out = k.counterpartPurge({
      principal: A,
      counterpartIds: [p.id],
      dryRun: true,
      now: now(),
    });
    assert.equal(out.outcome, "preview", JSON.stringify(out));
    const preview = out as Extract<typeof out, { outcome: "preview" }>;
    assert.deepEqual(preview.items[0]?.impact, {
      contacts: 2,
      links: 2,
      sharedContacts: 0,
      aliases: 2,
      relations: 1,
      commitmentsKept: 0,
      participantLinksKept: 0,
    });
    assert.deepEqual(preview.total, preview.items[0]?.impact);
    assert.equal(lifecycleOf(p.id), "inactive");
    assert.equal(
      count("SELECT COUNT(*) AS n FROM counterpart_names WHERE counterpart_id = ?", p.id),
      3,
    );
    assert.equal(
      count("SELECT COUNT(*) AS n FROM counterpart_purge_receipts WHERE counterpart_id = ?", p.id),
      0,
    );
  });

  it("removes contacts, other names and relations, keeps the name and the Commitment history, and writes a receipt", () => {
    const p = rich("清除对象");
    const commitment = k.commitmentCreate({
      principal: A,
      spec: {
        requirementText: "清除对象：寄合同",
        responsible: { kind: "counterpart", counterpartId: p.id },
        origin: { kind: "native_record", refId: "ui_purge_1" },
      },
      createdBy: "user",
      now: now(),
    });
    assert.equal(commitment.outcome, "created", JSON.stringify(commitment));
    // a finished Commitment keeps pointing at him when he is deleted (an open one goes back to the typed name)
    k.commitmentResolve({
      principal: A,
      commitmentId: (commitment as { commitment: { id: string } }).commitment.id,
      basis: "manual",
      reason: "确认完成",
      now: now(),
    } as never);
    remove(p.id);
    const endpointIds = (
      db.prepare("SELECT endpoint_id FROM identity_links WHERE counterpart_id = ?").all(p.id) as {
        endpoint_id: string;
      }[]
    ).map((r) => r.endpoint_id);
    assert.equal(endpointIds.length, 2);
    const out = k.counterpartPurge({ principal: A, counterpartIds: [p.id], now: now() });
    assert.equal(out.outcome, "purged", JSON.stringify(out));
    const done = out as Extract<typeof out, { outcome: "purged" }>;
    assert.equal(done.purged[0]?.impact.contacts, 2);
    assert.equal(lifecycleOf(p.id), "deleted");
    assert.equal(
      count("SELECT COUNT(*) AS n FROM identity_links WHERE counterpart_id = ?", p.id),
      0,
    );
    for (const id of endpointIds) {
      assert.equal(count("SELECT COUNT(*) AS n FROM counterpart_endpoints WHERE id = ?", id), 0);
    }
    assert.equal(
      count("SELECT COUNT(*) AS n FROM counterpart_relations WHERE counterpart_id = ?", p.id),
      0,
    );
    // the name stays, as the one display name, and nothing else
    const names = db
      .prepare("SELECT name, name_kind FROM counterpart_names WHERE counterpart_id = ?")
      .all(p.id) as { name: string; name_kind: string }[];
    assert.deepEqual(
      names.map((n) => [n.name, n.name_kind]),
      [["清除对象", "display"]],
    );
    const row = db
      .prepare("SELECT display_name, inactive_reason, inactive_at FROM counterparts WHERE id = ?")
      .get(p.id) as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      { display_name: "清除对象", inactive_reason: null, inactive_at: null },
    );
    // the Commitment still points at him
    assert.equal(
      count("SELECT COUNT(*) AS n FROM commitments WHERE responsible_counterpart_id = ?", p.id),
      1,
    );
    // the receipt: counts and a hash, never a contact or an alias
    const receipt = db
      .prepare("SELECT * FROM counterpart_purge_receipts WHERE counterpart_id = ?")
      .get(p.id) as Record<string, unknown>;
    assert.equal(receipt.name_hash, sha256Hex(normalizeName("清除对象")));
    assert.deepEqual(
      [receipt.contact_count, receipt.link_count, receipt.alias_count, receipt.relation_count],
      [2, 2, 2, 1],
    );
    const text = JSON.stringify(receipt);
    assert.doesNotMatch(text, /example\.com|13900001111|别名|小名/);
    // cleared people cannot be restored or cleared again
    assert.equal(
      k.counterpartRestore({ principal: A, counterpartId: p.id, now: now() }).outcome,
      "not_inactive",
    );
    assert.equal(
      k.counterpartPurge({ principal: A, counterpartIds: [p.id], now: now() }).outcome,
      "nothing_to_purge",
    );
  });

  it("keeps a contact method that another person also holds, and removes only this person's attachment", () => {
    const p = rich("共用联系方式");
    const other = person("另一个人");
    const shared = (
      db
        .prepare("SELECT endpoint_id FROM identity_links WHERE counterpart_id = ? ORDER BY rowid")
        .get(p.id) as {
        endpoint_id: string;
      }
    ).endpoint_id;
    db.prepare(
      "INSERT INTO identity_links (owner_id, id, counterpart_id, endpoint_id, status, basis_kind, basis_json, scope_kind, confirmed_by, confirmed_at, valid_from, version, created_at, updated_at) " +
        "VALUES (?, 'il_shared', ?, ?, 'confirmed', 'user_confirmed', '{}', 'account', 'user', 1, 1, 1, 1, 1)",
    ).run(A.ownerId, other.id, shared);
    remove(p.id);
    const out = k.counterpartPurge({ principal: A, counterpartIds: [p.id], now: now() });
    const done = out as Extract<typeof out, { outcome: "purged" }>;
    assert.equal(done.purged[0]?.impact.contacts, 1);
    assert.equal(done.purged[0]?.impact.sharedContacts, 1);
    assert.equal(done.purged[0]?.impact.links, 2);
    assert.equal(count("SELECT COUNT(*) AS n FROM counterpart_endpoints WHERE id = ?", shared), 1);
    assert.equal(
      count(
        "SELECT COUNT(*) AS n FROM identity_links WHERE endpoint_id = ? AND counterpart_id = ?",
        shared,
        other.id,
      ),
      1,
    );
    assert.equal(
      count("SELECT COUNT(*) AS n FROM identity_links WHERE counterpart_id = ?", p.id),
      0,
    );
  });

  it("clears several people in one go, lists the receipts newest first, and never reaches another owner's people", () => {
    const a1 = rich("批量甲");
    const a2 = rich("批量乙");
    const b1 = person("别人家的人", {}, B);
    remove(a1.id);
    remove(a2.id);
    remove(b1.id, B);
    const out = k.counterpartPurge({
      principal: A,
      counterpartIds: [a1.id, a2.id, b1.id, a1.id],
      now: now(),
    });
    const done = out as Extract<typeof out, { outcome: "purged" }>;
    assert.deepEqual(
      done.purged.map((p) => p.id),
      [a1.id, a2.id],
    );
    assert.deepEqual(done.skipped, [{ id: b1.id, reason: "not_found" }]);
    assert.equal(done.total.contacts, 4);
    assert.equal(lifecycleOf(b1.id), "inactive");
    const receipts = k.counterpartPurgeReceipts({ principal: A, limit: 50, offset: 0 });
    assert.ok(receipts.total >= 2);
    assert.deepEqual(
      receipts.items
        .slice(0, 2)
        .map((r) => r.displayName)
        .toSorted(),
      ["批量乙", "批量甲"].toSorted(),
    );
    assert.equal(k.counterpartPurgeReceipts({ principal: B, limit: 50, offset: 0 }).total, 0);
  });
});
