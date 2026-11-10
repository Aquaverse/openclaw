// W3c-3 hints: the "may repeat" commitments in a merge preview, and "may be the same person" (same name, shared alias, same contact).
// Hints only: nothing here changes a row. Real SQL on node:sqlite, every migration applied.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, db, now } = kit;

const person = (name: string, over: Record<string, unknown> = {}, owner = A) => {
  const out = k.counterpartCreate({ principal: owner, displayName: name, now: now(), ...over });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as Extract<typeof out, { outcome: "created" }>).counterpart;
};
const owes = (text: string, counterpartId: string) => {
  const out = k.commitmentCreate({
    principal: A,
    spec: {
      requirementText: text,
      responsible: { kind: "counterpart", counterpartId },
      origin: { kind: "native_record", refId: `ui_${text}_${counterpartId}` },
    },
    createdBy: "user",
    now: now(),
  });
  assert.equal(out.outcome, "created", JSON.stringify(out));
  return (out as { commitment: { id: string } }).commitment.id;
};
const view = (id: string, owner = A) => {
  const out = k.counterpartView({ principal: owner, counterpartId: id, now: now() });
  assert.equal(out.outcome, "ok");
  return (out as Extract<typeof out, { outcome: "ok" }>).view;
};
const sameOf = (id: string) => (view(id).possibleSame ?? []).map((s) => [s.displayName, s.reasons]);
const inList = (id: string) =>
  k
    .counterpartList({ principal: A, now: now(), limit: 200, offset: 0 })
    .items.find((p) => p.id === id);

describe("merge preview: possibly repeated commitments", () => {
  it("lists open commitments of the two people that read alike, and changes nothing", () => {
    const keep = person("重复保留甲");
    const gone = person("重复消失甲");
    owes("把季度报价单发给客户", gone.id);
    owes("预订下周的会议室", gone.id);
    owes("把季度报价单发给客户。", keep.id);
    const preview = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.equal(impact.possibleDuplicates.length, 1);
    assert.equal(impact.possibleDuplicates[0]?.sourceText, "把季度报价单发给客户");
    assert.equal(impact.possibleDuplicates[0]?.targetText, "把季度报价单发给客户。");
    assert.equal(impact.openCommitments, 2, "nothing moved by the preview");
  });

  it("finds nothing when the two have no alike open commitment", () => {
    const keep = person("重复保留乙");
    const gone = person("重复消失乙");
    owes("整理差旅报销", gone.id);
    owes("联系供应商确认交期", keep.id);
    const preview = k.counterpartMerge({
      principal: A,
      counterpartId: gone.id,
      intoId: keep.id,
      dryRun: true,
      now: now(),
    });
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.deepEqual(impact.possibleDuplicates, []);
  });
});

describe("may be the same person", () => {
  it("flags two records with the same name, from both sides, and counts them in the list", () => {
    const x = person("提示同名甲");
    const y = person("提示同名甲", { allowSameName: true });
    assert.deepEqual(sameOf(x.id), [["提示同名甲", ["name"]]]);
    assert.deepEqual(sameOf(y.id), [["提示同名甲", ["name"]]]);
    assert.equal(inList(x.id)?.possibleSame, 1);
  });

  it("flags a shared alias, and a name that is another person's alias", () => {
    const a = person("提示别名甲", { aliases: ["小甲"] });
    const b = person("提示别名乙", { aliases: ["小甲"] });
    const c = person("小甲", { allowSameName: true });
    assert.deepEqual(
      sameOf(a.id)
        .map(([n]) => n)
        .toSorted(),
      ["小甲", "提示别名乙"].toSorted(),
    );
    assert.ok(sameOf(b.id).some(([n, r]) => n === "小甲" && (r as string[]).includes("alias")));
    assert.ok(sameOf(c.id).length === 2);
  });

  it("flags the same contact held by two people", () => {
    const a = person("提示联系甲", { contacts: [{ type: "email", value: "dup@example.com" }] });
    const b = person("提示联系乙", { contacts: [{ type: "email", value: "dup@example.com" }] });
    assert.deepEqual(sameOf(a.id), [["提示联系乙", ["contact"]]]);
    assert.deepEqual(sameOf(b.id), [["提示联系甲", ["contact"]]]);
  });

  it("ignores a shared mailbox, other kinds, inactive, merged and other owners' people", () => {
    const a = person("提示忽略甲", { contacts: [{ type: "email", value: "team@example.com" }] });
    person("提示忽略乙", { contacts: [{ type: "email", value: "team@example.com" }] });
    db.prepare(
      "UPDATE counterpart_endpoints SET endpoint_type = 'shared_mailbox' WHERE handle = 'team@example.com' OR provider_subject_id = 'team@example.com'",
    ).run();
    assert.deepEqual(sameOf(a.id), []);
    const org = person("提示组织", { kind: "organization" });
    person("提示组织", { kind: "person", allowSameName: true });
    assert.deepEqual(sameOf(org.id), []);
    const keep = person("提示合并甲");
    const gone = person("提示合并甲", { allowSameName: true });
    const out = k.counterpartDeactivate({
      principal: A,
      counterpartId: gone.id,
      reason: "不用了",
      now: now(),
    });
    assert.equal(out.outcome, "deactivated");
    assert.deepEqual(sameOf(keep.id), []);
    person("提示忽略丙", {}, B);
    person("提示忽略丙", { allowSameName: true }, B);
    assert.deepEqual(sameOf(person("提示单人").id), []);
  });
});

describe("the reason of the last delete", () => {
  const stop = (id: string, reason: string) =>
    k.counterpartDeactivate({ principal: A, counterpartId: id, reason, now: now() });

  it("is kept when the person is brought back, and replaced by the next delete", () => {
    const p = person("原因保留甲");
    assert.equal(view(p.id).counterpart.lastStopReason, null);
    assert.equal(stop(p.id, "项目结束，不再合作").outcome, "deactivated");
    assert.equal(view(p.id).counterpart.lastStopReason, "项目结束，不再合作");
    assert.equal(view(p.id).counterpart.inactiveReason, "项目结束，不再合作");
    assert.equal(
      k.counterpartRestore({ principal: A, counterpartId: p.id, now: now() }).outcome,
      "restored",
    );
    assert.equal(view(p.id).counterpart.inactiveReason, null);
    assert.equal(view(p.id).counterpart.lastStopReason, "项目结束，不再合作");
    assert.equal(stop(p.id, "换了公司").outcome, "deactivated");
    assert.equal(view(p.id).counterpart.lastStopReason, "换了公司");
  });

  it("goes when the person is cleared", () => {
    const p = person("原因清除甲");
    assert.equal(stop(p.id, "不再联系").outcome, "deactivated");
    const out = k.counterpartPurge({ principal: A, counterpartIds: [p.id], now: now() });
    assert.equal(out.outcome, "purged", JSON.stringify(out));
    assert.equal(view(p.id).counterpart.lastStopReason, null);
  });
});

describe("integrity: the same commitment cited twice in one Work", () => {
  it("reports a commitment that is both required and reference, and the role switch clears it", () => {
    const workId = (
      k.workCreate({
        principal: A,
        spec: { title: "重复挂接项目", origin: "user" },
        now: now(),
      }) as {
        workId: string;
      }
    ).workId;
    const who = person("挂接责任人");
    const out = k.commitmentCreate({
      principal: A,
      spec: {
        requirementText: "挂接检查用的承诺",
        responsible: { kind: "counterpart", counterpartId: who.id },
        origin: { kind: "native_record", refId: "dup_link_1" },
      },
      createdBy: "user",
      workId,
      workRole: "required",
      now: now(),
    });
    assert.equal(out.outcome, "created", JSON.stringify(out));
    const id = (out as { commitment: { id: string } }).commitment.id;
    const dups = () =>
      k
        .workIntegrity({ principal: A, now: now() })
        .findings.filter((f) => f.code === "duplicate_link");
    assert.deepEqual(dups(), []);
    db.prepare(
      "INSERT INTO work_links (owner_id, id, work_id, role, target_kind, target_id, created_at) VALUES (?, 'wl_dup_ref', ?, 'reference', 'commitment', ?, 1)",
    ).run(A.ownerId, workId, id);
    const found = dups();
    assert.equal(found.length, 1);
    assert.equal(found[0]?.objectId, workId);
    assert.ok(found[0]?.detail?.includes(`commitment:${id}`));
    assert.ok(found[0]?.detail?.includes("wl_dup_ref"));
    const merged = k.commitmentSetRole({
      principal: A,
      commitmentId: id,
      workId,
      role: "reference",
      acknowledgeGap: true,
      now: now(),
    } as never);
    assert.notEqual((merged as { outcome: string }).outcome, "not_found", JSON.stringify(merged));
    assert.deepEqual(dups(), []);
  });
});

describe("marking two records as not the same person", () => {
  const mark = (id: string, other: string, owner = A) =>
    k.counterpartNotSame({ principal: owner, counterpartId: id, otherId: other, now: now() });
  const unmark = (id: string, other: string) =>
    k.counterpartNotSameRestore({ principal: A, counterpartId: id, otherId: other, now: now() });

  it("silences the hint for that pair from both sides, lists the mark, and the undo brings it back", () => {
    const x = person("标记甲");
    const y = person("标记甲", { allowSameName: true });
    const z = person("标记甲", { allowSameName: true });
    assert.equal(view(x.id).possibleSame?.length, 2);
    assert.equal(mark(x.id, y.id).outcome, "marked");
    assert.deepEqual(
      sameOf(x.id).map(([n]) => n),
      ["标记甲"],
      "only z is left",
    );
    assert.equal(view(x.id).possibleSame?.[0]?.id, z.id);
    assert.equal(
      view(y.id).possibleSame?.some((p) => p.id === x.id),
      false,
      "from y's side too",
    );
    assert.equal(
      view(y.id).possibleSame?.some((p) => p.id === z.id),
      true,
      "other pairs stay",
    );
    assert.deepEqual(view(x.id).notSame, [{ id: y.id, displayName: "标记甲" }]);
    assert.deepEqual(view(y.id).notSame, [{ id: x.id, displayName: "标记甲" }]);
    assert.equal(inList(x.id)?.possibleSame, 1);
    assert.equal(unmark(y.id, x.id).outcome, "restored", "either side can take it back");
    assert.equal(view(x.id).possibleSame?.length, 2);
    assert.deepEqual(view(x.id).notSame, []);
  });

  it("marks once, changes no name or merge rule, and refuses nonsense", () => {
    const x = person("标记乙");
    const y = person("标记乙", { allowSameName: true });
    assert.equal(mark(x.id, y.id).outcome, "marked");
    assert.equal(mark(y.id, x.id).outcome, "exists");
    assert.equal(
      k.counterpartResolveName({ principal: A, name: "标记乙" }).candidates.length,
      2,
      "the name still points at both",
    );
    assert.deepEqual(mark(x.id, x.id), { outcome: "invalid", code: "same_record" });
    assert.equal(mark(x.id, "cp_nobody").outcome, "not_found");
    assert.equal(unmark(x.id, "cp_nobody").outcome, "not_found");
    const stopped = person("标记停用");
    assert.equal(stop(stopped.id).outcome, "deactivated");
    assert.equal(mark(x.id, stopped.id).outcome, "closed");
    const selfRow = db
      .prepare("SELECT self_counterpart_id AS id FROM owner_identity WHERE owner_id = ?")
      .get(A.ownerId) as { id: string } | undefined;
    if (selfRow) {
      assert.equal(mark(x.id, selfRow.id).outcome, "forbidden");
    }
  });

  it("is per owner, and clearing a person removes the marks that name them", () => {
    const x = person("标记丙");
    const y = person("标记丙", { allowSameName: true });
    assert.equal(mark(x.id, y.id).outcome, "marked");
    const theirs = person("标记丙", {}, B);
    assert.equal(mark(x.id, theirs.id, B).outcome, "not_found", "not another owner's person");
    assert.equal(stop(y.id).outcome, "deactivated");
    const out = k.counterpartPurge({ principal: A, counterpartIds: [y.id], now: now() });
    assert.equal(out.outcome, "purged", JSON.stringify(out));
    const left = db
      .prepare(
        "SELECT COUNT(*) AS n FROM counterpart_not_same WHERE owner_id = ? AND (low_id = ? OR high_id = ?)",
      )
      .get(A.ownerId, y.id, y.id) as { n: number };
    assert.equal(left.n, 0);
  });

  function stop(id: string) {
    return k.counterpartDeactivate({ principal: A, counterpartId: id, reason: "测试", now: now() });
  }
});
