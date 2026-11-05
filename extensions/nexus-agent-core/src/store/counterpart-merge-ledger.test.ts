// Counterpart kernel tests for identity corrections (design 7.5, 7.6, slice W3b): merging two records of one person, a type change
// that would leave a nonsense relation, and a typed name that "is not a person". Real SQL on node:sqlite, every migration applied.
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
const list = (owner = A) =>
  k.counterpartList({ principal: owner, now: now(), limit: 50, offset: 0 }).items;

describe("counterpart kernel: merge, correct the type, and 'not a person'", () => {
  const view = (id: string) => {
    const out = k.counterpartView({ principal: A, counterpartId: id, now: now() });
    return (out as Extract<typeof out, { outcome: "ok" }>).view;
  };

  it("previews a merge, needs the user to pick a relation both sides disagree on, then moves everything without a new version", () => {
    const keep = person("合并保留", {
      relation: { relation: "client", scopeLabel: "华东" },
      contacts: [{ type: "email", value: "same@example.com" }],
    });
    const gone = person("合并消失", {
      allowSameName: true,
      aliases: ["老合"],
      relation: { relation: "supplier", scopeLabel: null },
      contacts: [
        { type: "email", value: "same@example.com" },
        { type: "phone", value: "13800001111" },
      ],
    });
    const open = commit("合并前的承诺", { kind: "counterpart", counterpartId: gone.id });
    accept(open);
    const done = commit("合并前已结案", { kind: "counterpart", counterpartId: gone.id });
    k.commitmentResolve({
      principal: A,
      commitmentId: done,
      basis: "manual",
      reason: "确认完成",
      now: now(),
    } as never);
    const versionBefore = get(open).commitment.responsibilityVersion;
    const preview = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.equal(impact.contacts, 2);
    assert.equal(impact.sharedContacts, 1);
    assert.ok(impact.relations, "the two disagree on the relation");
    assert.equal(impact.openCommitments, 1);
    // A preview changes nothing.
    assert.equal(
      list().some((p) => p.id === gone.id),
      true,
    );
    const needChoice = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      now: now(),
    });
    assert.equal(needChoice.outcome, "choice_required");
    const stale = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      expectedRevision: gone.revision + 5,
      relationChoice: "target",
      now: now(),
    });
    assert.equal(stale.outcome, "revision_conflict");
    const merged = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      expectedRevision: gone.revision,
      relationChoice: "target",
      now: now(),
    });
    assert.equal(merged.outcome, "merged");
    const keeper = (merged as Extract<typeof merged, { outcome: "merged" }>).counterpart;
    assert.deepEqual(keeper.relation, { relation: "client", scopeLabel: "华东" });
    assert.deepEqual(
      keeper.contacts.map((c) => c.value).toSorted(),
      ["13800001111", "same@example.com"],
      "the shared contact became one",
    );
    assert.ok(keeper.aliases.includes("合并消失") && keeper.aliases.includes("老合"));
    assert.equal(
      list().some((p) => p.id === gone.id),
      false,
      "the merged record leaves the list",
    );
    const tomb = k.counterpartView({ principal: A, counterpartId: gone.id, now: now() });
    const record = (tomb as Extract<typeof tomb, { outcome: "ok" }>).view.counterpart;
    assert.equal(record.lifecycle, "merged");
    assert.equal(record.mergedInto, keep.id);
    // Both commitments follow the person who stays; same person, so no new responsibility version and acceptance is kept.
    assert.equal(get(open).commitment.responsibleCounterpartId, keep.id);
    assert.equal(get(open).commitment.responsibilityVersion, versionBefore);
    assert.equal(get(open).commitment.acceptanceState, "accepted");
    assert.equal(
      view(keep.id).history.some((c) => c.id === done),
      true,
    );
    // The old display name now finds the person who stays.
    assert.equal(
      k.counterpartResolveName({ principal: A, name: "老合" }).candidates[0]?.id,
      keep.id,
    );
    // A merged record cannot be merged again.
    assert.equal(
      k.counterpartMerge({ principal: A, counterpartId: gone.id, intoId: keep.id, now: now() })
        .outcome,
      "closed",
    );
  });

  it("refuses to merge a person into themselves, the owner's own record, another kind, or a record of another owner", () => {
    const a = person("拒合并甲");
    const org = person("拒合并乙", { kind: "organization" });
    const other = person("别人的人", {}, B);
    const merge = (counterpartId: string, intoId: string) =>
      k.counterpartMerge({ principal: A, counterpartId, intoId, now: now() });
    assert.deepEqual(merge(a.id, a.id), { outcome: "invalid", code: "same_record" });
    assert.deepEqual(merge(a.id, org.id), { outcome: "invalid", code: "kind_mismatch" });
    assert.equal(merge(a.id, other.id).outcome, "not_found");
    const self = db
      .prepare("SELECT self_counterpart_id AS id FROM owner_identity WHERE owner_id = ?")
      .get(A.ownerId) as { id: string } | undefined;
    if (self) {
      assert.equal(merge(a.id, self.id).outcome, "forbidden");
    }
  });

  it("keeps the relation of the side that has one, and drops a participant link both sides held", () => {
    const keep = person("单边关系保留");
    const gone = person("单边关系消失", { allowSameName: true, relation: { relation: "client" } });
    const out = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      now: now(),
    });
    assert.equal(out.outcome, "merged");
    assert.deepEqual((out as Extract<typeof out, { outcome: "merged" }>).counterpart.relation, {
      relation: "client",
      scopeLabel: null,
    });
  });

  it("refuses a type change to organization while the relation is direct report or colleague, unless the relation changes with it", () => {
    const p = person("类型更正", { relation: { relation: "colleague" } });
    const refused = k.counterpartUpdate({
      principal: A,
      counterpartId: p.id,
      changes: { kind: "organization" },
      now: now(),
    });
    assert.equal(refused.outcome, "relation_conflict");
    assert.equal(view(p.id).counterpart.kind, "person");
    const ok = k.counterpartUpdate({
      principal: A,
      counterpartId: p.id,
      changes: { kind: "organization", relation: { relation: "client" } },
      now: now(),
    });
    assert.equal(ok.outcome, "updated");
    assert.equal(view(p.id).counterpart.kind, "organization");
  });

  it("refuses a relation change that would make an organization or a team somebody's colleague, with the type left alone", () => {
    for (const kind of ["organization", "team"] as const) {
      const p = person(`只改关系${kind}`, { kind, relation: { relation: "client" } });
      for (const relation of ["colleague", "direct_report"] as const) {
        const refused = k.counterpartUpdate({
          principal: A,
          counterpartId: p.id,
          changes: { relation: { relation } },
          now: now(),
        });
        assert.equal(refused.outcome, "relation_conflict", `${kind} ${relation}`);
      }
      assert.equal(view(p.id).counterpart.relation?.relation, "client");
      // Another relation, or no relation, is still fine; and a person can become a colleague.
      assert.equal(
        k.counterpartUpdate({
          principal: A,
          counterpartId: p.id,
          changes: { relation: { relation: "supplier" } },
          now: now(),
        }).outcome,
        "updated",
      );
    }
    const human = person("只改关系个人", { relation: { relation: "client" } });
    assert.equal(
      k.counterpartUpdate({
        principal: A,
        counterpartId: human.id,
        changes: { relation: { relation: "colleague" } },
        now: now(),
      }).outcome,
      "updated",
    );
  });

  it("does not create an organization or a team that is somebody's colleague or direct report", () => {
    for (const kind of ["organization", "team"] as const) {
      for (const relation of ["colleague", "direct_report"] as const) {
        const out = k.counterpartCreate({
          principal: A,
          displayName: `新建${kind}${relation}`,
          kind,
          relation: { relation },
          now: now(),
        });
        assert.equal(out.outcome, "relation_conflict", `${kind} ${relation}`);
      }
    }
    assert.equal(list().filter((entry) => entry.displayName.startsWith("新建")).length, 0);
    // A client organization, and a colleague who is a person, are fine.
    assert.equal(
      person("新建客户机构", { kind: "organization", relation: { relation: "client" } }).kind,
      "organization",
    );
    assert.equal(person("新建同事", { relation: { relation: "colleague" } }).kind, "person");
  });

  it("turns a typed name into an organization without a new version, and the name is found there afterwards", () => {
    const id = commit("市场部交海报", { kind: "name", name: "市场部" });
    const closed = commit("市场部旧事", { kind: "name", name: "市场部" });
    k.commitmentCancel({ principal: A, commitmentId: closed, reason: "不要了", now: now() });
    const versionBefore = get(id).commitment.responsibilityVersion;
    const preview = k.counterpartNotPerson({
      principal: A,
      raw: "市场部",
      destination: "organization",
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    assert.equal((preview as Extract<typeof preview, { outcome: "preview" }>).impact.total, 2);
    const out = k.counterpartNotPerson({
      principal: A,
      raw: "市场部",
      destination: "organization",
      now: now(),
    });
    assert.equal(out.outcome, "moved");
    const org = k.counterpartResolveName({ principal: A, name: "市场部" }).candidates[0];
    assert.equal(org?.kind, "organization");
    assert.equal(get(id).commitment.responsibleCounterpartId, org?.id);
    assert.equal(get(id).commitment.responsibilityVersion, versionBefore);
    assert.equal(
      k.counterpartPending({ principal: A, now: now() }).groups.some((g) => g.raw === "市场部"),
      false,
    );
  });

  it("asks before creating an organization whose name somebody already has", () => {
    person("销售部");
    commit("销售部报数", { kind: "name", name: "销售部门" });
    const taken = k.counterpartNotPerson({
      principal: A,
      raw: "销售部门",
      destination: "team",
      displayName: "销售部",
      now: now(),
    });
    assert.equal(taken.outcome, "name_taken");
    const allowed = k.counterpartNotPerson({
      principal: A,
      raw: "销售部门",
      destination: "team",
      displayName: "销售部",
      allowSameName: true,
      now: now(),
    });
    assert.equal(allowed.outcome, "moved");
  });

  it("makes the open ones the owner's own with a new version, and leaves closed ones as typed", () => {
    const open = commit("会务自己做", { kind: "name", name: "我这边" });
    accept(open);
    const closed = commit("会务旧的", { kind: "name", name: "我这边" });
    k.commitmentCancel({ principal: A, commitmentId: closed, reason: "取消", now: now() });
    const versionBefore = get(open).commitment.responsibilityVersion;
    const out = k.counterpartNotPerson({
      principal: A,
      raw: "我这边",
      destination: "self",
      now: now(),
    });
    assert.equal(out.outcome, "moved");
    assert.equal((out as { versioned: number }).versioned, 1);
    const after = get(open).commitment;
    assert.equal(after.responsibleSelf, true);
    assert.equal(after.responsibilityVersion, versionBefore + 1);
    assert.notEqual(after.acceptanceState, "accepted", "a different party: acceptance resets");
    assert.equal(get(closed).commitment.responsibleCounterpartId, null);
  });

  it("remembers a name that points at nobody, hides its group, and shows it again when restored", () => {
    const id = commit("场地订好", { kind: "name", name: "会场" });
    const groups = () => k.counterpartPending({ principal: A, now: now() }).groups;
    assert.equal(
      groups().some((g) => g.raw === "会场"),
      true,
    );
    const out = k.counterpartNotPerson({
      principal: A,
      raw: "会场",
      destination: "dismiss",
      now: now(),
    });
    assert.equal(out.outcome, "dismissed");
    assert.equal(
      groups().some((g) => g.raw === "会场"),
      false,
    );
    assert.equal(
      get(id).commitment.responsibleCounterpartId,
      null,
      "the commitment keeps its typed name",
    );
    const dismissed = k.counterpartDismissed({ principal: A }).items;
    const entry = dismissed.find((d) => d.raw === "会场");
    assert.ok(entry);
    assert.equal(k.counterpartDismissed({ principal: B }).items.length, 0);
    assert.equal(
      k.counterpartDismissalRestore({ principal: B, dismissalId: entry!.id, now: now() }).outcome,
      "not_found",
    );
    assert.equal(
      k.counterpartDismissalRestore({ principal: A, dismissalId: entry!.id, now: now() }).outcome,
      "restored",
    );
    assert.equal(
      groups().some((g) => g.raw === "会场"),
      true,
    );
  });

  it("says nothing_to_claim for a name nobody typed, and is isolated per owner", () => {
    assert.equal(
      k.counterpartNotPerson({ principal: A, raw: "没人写过", destination: "dismiss", now: now() })
        .outcome,
      "nothing_to_claim",
    );
    commit("别人的名字", { kind: "name", name: "共享名" });
    assert.equal(
      k.counterpartNotPerson({ principal: B, raw: "共享名", destination: "dismiss", now: now() })
        .outcome,
      "nothing_to_claim",
    );
  });
});
