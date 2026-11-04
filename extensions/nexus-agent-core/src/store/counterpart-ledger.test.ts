// Counterpart kernel tests (design 7, 9, slice W3a): real SQL on node:sqlite, every migration applied. Covers creation and the
// Agent's limits, name matching (same name is never one person), contact methods as reference data, the attention-ordered list,
// deactivation with its impact preview, and the claim of typed-name Commitments with and without a new responsibility version.
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
const commit = (
  text: string,
  responsible: CommitmentSpec["responsible"],
  over: { due?: number } = {},
) => {
  const out = k.commitmentCreate({
    principal: A,
    spec: {
      requirementText: text,
      responsible,
      ...(over.due ? { due: { kind: "known", at: over.due, tz: "Asia/Shanghai" } } : {}),
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
const list = (owner = A) => {
  const out = k.counterpartList({ principal: owner, now: now(), limit: 50, offset: 0 });
  return out.items;
};

describe("counterpart kernel: create, ensure and matching", () => {
  it("creates a confirmed person with aliases and a relation, and matches by name or alias", () => {
    const p = person("王小明", {
      aliases: ["小王", " 小王 ", "Xiao Wang"],
      relation: { relation: "direct_report", scopeLabel: "市场部" },
    });
    assert.equal(p.confirmation, "confirmed");
    assert.equal(p.origin, "user");
    assert.deepEqual(p.aliases, ["小王", "xiao wang"]);
    assert.deepEqual(p.relation, { relation: "direct_report", scopeLabel: "市场部" });
    const byAlias = k.counterpartResolveName({ principal: A, name: "  小王 " });
    assert.equal(byAlias.match, "one");
    assert.equal(byAlias.candidates[0]?.id, p.id);
    assert.equal(k.counterpartResolveName({ principal: A, name: "XIAO  WANG" }).match, "one");
    assert.equal(k.counterpartResolveName({ principal: B, name: "小王" }).match, "none");
  });

  it("refuses a second person with a taken name unless the user says so, then reports both as many", () => {
    const first = person("陈老师");
    const taken = k.counterpartCreate({ principal: A, displayName: "陈老师", now: now() });
    assert.equal(taken.outcome, "name_taken");
    assert.equal((taken as { candidates: unknown[] }).candidates.length, 1);
    const second = person("陈老师", { allowSameName: true });
    assert.notEqual(second.id, first.id);
    const found = k.counterpartResolveName({ principal: A, name: "陈老师" });
    assert.equal(found.match, "many");
    assert.equal(found.candidates.length, 2);
  });

  it("validates names, kind, relation and contacts", () => {
    const bad = (over: Record<string, unknown>) =>
      k.counterpartCreate({ principal: A, displayName: "校验", now: now(), ...over });
    assert.deepEqual(bad({ displayName: "  " }), { outcome: "invalid", code: "bad_name" });
    assert.deepEqual(bad({ kind: "robot" }), { outcome: "invalid", code: "bad_kind" });
    assert.deepEqual(bad({ relation: { relation: "boss" } }), {
      outcome: "invalid",
      code: "bad_relation",
    });
    assert.deepEqual(bad({ contacts: [{ type: "fax", value: "1" }] }), {
      outcome: "invalid",
      code: "bad_contact_type",
    });
    assert.deepEqual(bad({ aliases: Array.from({ length: 9 }, (_, i) => `别名${i}`) }), {
      outcome: "invalid",
      code: "too_many_aliases",
    });
  });

  it("lets an Agent reuse one match, hand back many, and create only a stated record tied to what the user said", () => {
    const ensure = (name: string, ref = "msg_1") =>
      k.counterpartEnsure({ principal: A, name, userStatementRef: ref, now: now() });
    assert.deepEqual(ensure("某某", ""), { outcome: "invalid", code: "statement_ref_required" });
    const created = ensure("林芳");
    assert.equal(created.outcome, "created");
    const record = (created as Extract<typeof created, { outcome: "created" }>).counterpart;
    assert.equal(record.confirmation, "stated");
    assert.equal(record.origin, "agent");
    const again = ensure("林芳", "msg_2");
    assert.equal(again.outcome, "existing");
    assert.equal((again as { counterpart: { id: string } }).counterpart.id, record.id);
    person("林芳", { allowSameName: true });
    const many = ensure("林芳", "msg_3");
    assert.equal(many.outcome, "ambiguous");
    assert.equal((many as { candidates: unknown[] }).candidates.length, 2);
    // The database refuses the one thing the ledger never does: an Agent-made record marked confirmed.
    assert.throws(() =>
      db
        .prepare("UPDATE counterparts SET confirmation = 'confirmed' WHERE owner_id = ? AND id = ?")
        .run(A.ownerId, record.id),
    );
    // Only the user can confirm it, which also makes the user the origin.
    const confirmed = k.counterpartUpdate({
      principal: A,
      counterpartId: record.id,
      changes: { confirm: true },
      now: now(),
    });
    assert.equal(confirmed.outcome, "updated");
    const after = (confirmed as { counterpart: { confirmation: string; origin: string } })
      .counterpart;
    assert.deepEqual([after.confirmation, after.origin], ["confirmed", "user"]);
  });

  it("an Agent recording a Commitment links a unique person and keeps a typed name when several answer to it", () => {
    const only = person("赵工");
    let n = 0;
    const viaAgent = (name: string) => {
      n += 1;
      const out = k.commitmentCreate({
        principal: A,
        spec: {
          requirementText: `${name}交报告`,
          responsible: { kind: "name", name },
          origin: { kind: "native_record", refId: "x" },
        },
        createdBy: "agent",
        userStatementRef: `said_${name}_${n}`,
        now: now(),
      });
      assert.equal(out.outcome, "created", JSON.stringify(out));
      return get((out as { commitment: { id: string } }).commitment.id).commitment;
    };
    const linked = viaAgent("赵工");
    assert.equal(linked.responsibleCounterpartId, only.id);
    assert.equal(linked.responsibleRaw, null);
    person("赵工", { allowSameName: true });
    const kept = viaAgent("赵工");
    assert.equal(kept.responsibleCounterpartId, null);
    assert.equal(kept.responsibleRaw, "赵工");
    assert.equal(viaAgent("无此人").responsibleRaw, "无此人");
  });
});

describe("counterpart kernel: edit and contact methods", () => {
  it("renames while the old name stays an alias, checks revisions and protects the self identity", () => {
    const p = person("张三", { aliases: ["老张"] });
    const stale = k.counterpartUpdate({
      principal: A,
      counterpartId: p.id,
      changes: { displayName: "张三丰" },
      expectedRevision: p.revision + 5,
      now: now(),
    });
    assert.equal(stale.outcome, "revision_conflict");
    const out = k.counterpartUpdate({
      principal: A,
      counterpartId: p.id,
      changes: { displayName: "张三丰", removeAliases: ["老张"], addAliases: ["三丰"] },
      expectedRevision: p.revision,
      now: now(),
    });
    assert.equal(out.outcome, "updated");
    const next = (
      out as { counterpart: { displayName: string; aliases: string[]; revision: number } }
    ).counterpart;
    assert.equal(next.displayName, "张三丰");
    assert.deepEqual(next.aliases.toSorted(), ["三丰", "张三"]);
    assert.equal(next.revision, p.revision + 1);
    assert.equal(k.counterpartResolveName({ principal: A, name: "老张" }).match, "none");
    assert.equal(k.counterpartResolveName({ principal: A, name: "张三" }).candidates[0]?.id, p.id);
    const same = k.counterpartUpdate({
      principal: A,
      counterpartId: p.id,
      changes: { displayName: "张三丰" },
      now: now(),
    });
    assert.equal(same.outcome, "unchanged");
    const clash = person("李四");
    const taken = k.counterpartUpdate({
      principal: A,
      counterpartId: clash.id,
      changes: { displayName: "张三丰" },
      now: now(),
    });
    assert.equal(taken.outcome, "name_taken");
    // The owner's own identity row exists once a Commitment names "self"; it cannot change kind or be deactivated.
    const mine = commit("我自己的事", { kind: "self" });
    const self = get(mine).commitment.responsibleCounterpartId as string;
    assert.deepEqual(
      k.counterpartUpdate({
        principal: A,
        counterpartId: self,
        changes: { kind: "team" },
        now: now(),
      }),
      { outcome: "forbidden", code: "self_identity" },
    );
    assert.deepEqual(
      k.counterpartDeactivate({ principal: A, counterpartId: self, reason: "x", now: now() }),
      { outcome: "forbidden", code: "self_identity" },
    );
    assert.ok(
      !list().some((entry) => entry.id === self),
      "the owner is not in their own people list",
    );
  });

  it("stores contact methods as weak reference data that authorize nothing, without duplicates", () => {
    const p = person("联系人", { contacts: [{ type: "email", value: "a@example.com" }] });
    assert.equal(p.contacts.length, 1);
    const added = k.counterpartContactAdd({
      principal: A,
      counterpartId: p.id,
      contact: { type: "im", value: "wx_abc", label: "微信" },
      now: now(),
    });
    assert.equal(added.outcome, "added");
    const dup = k.counterpartContactAdd({
      principal: A,
      counterpartId: p.id,
      contact: { type: "email", value: "A@Example.com" },
      now: now(),
    });
    assert.equal(dup.outcome, "unchanged");
    const contacts = (
      added as { counterpart: { contacts: Array<{ id: string; label: string; value: string }> } }
    ).counterpart.contacts;
    assert.deepEqual(
      contacts.map((entry) => [entry.label, entry.value]),
      [
        ["email", "a@example.com"],
        ["微信", "wx_abc"],
      ],
    );
    const row = db
      .prepare(
        "SELECT e.id_strength, l.status, l.basis_kind, l.basis_json FROM counterpart_endpoints e JOIN identity_links l ON l.owner_id = e.owner_id AND l.endpoint_id = e.id WHERE e.owner_id = ? AND e.handle = 'wx_abc'",
      )
      .get(A.ownerId) as {
      id_strength: string;
      status: string;
      basis_kind: string;
      basis_json: string;
    };
    assert.deepEqual(
      [row.id_strength, row.status, row.basis_kind],
      ["weak", "confirmed", "user_confirmed"],
    );
    assert.equal(JSON.parse(row.basis_json).authorizes, "nothing");
    const removed = k.counterpartContactRemove({
      principal: A,
      counterpartId: p.id,
      endpointId: contacts[1]?.id ?? "",
      now: now(),
    });
    assert.equal(removed.outcome, "removed");
    assert.equal(
      (removed as { counterpart: { contacts: unknown[] } }).counterpart.contacts.length,
      1,
    );
    assert.equal(
      k.counterpartContactRemove({
        principal: A,
        counterpartId: p.id,
        endpointId: "nope",
        now: now(),
      }).outcome,
      "contact_not_found",
    );
    assert.equal(
      k.counterpartContactAdd({
        principal: B,
        counterpartId: p.id,
        contact: { type: "phone", value: "1" },
        now: now(),
      }).outcome,
      "not_found",
    );
  });
});

describe("counterpart kernel: list, deactivate and claim", () => {
  it("orders the list by attention and counts each open Commitment once", () => {
    const calm = person("清闲甲");
    const late = person("逾期乙");
    const soon = person("将到丙");
    const now0 = now();
    commit("无期限事项", { kind: "counterpart", counterpartId: calm.id });
    const lateA = commit("已逾期", { kind: "counterpart", counterpartId: late.id }, { due: 500 });
    commit("快到期", { kind: "counterpart", counterpartId: soon.id }, { due: now0 + 3_600_000 });
    accept(lateA);
    const w1 = k.workCreate({
      principal: A,
      spec: { title: "工作一", origin: "user" },
      now: now(),
    }) as { workId: string };
    const w2 = k.workCreate({
      principal: A,
      spec: { title: "工作二", origin: "user" },
      now: now(),
    }) as { workId: string };
    for (const w of [w1, w2]) {
      k.workLinkAdd({
        principal: A,
        workId: w.workId,
        role: "required",
        targetKind: "commitment",
        targetId: lateA,
        actor: "user",
        now: now(),
      });
    }
    const rows = list().filter((entry) =>
      ["清闲甲", "逾期乙", "将到丙"].includes(entry.displayName),
    );
    assert.deepEqual(
      rows.map((entry) => entry.displayName),
      ["逾期乙", "将到丙", "清闲甲"],
    );
    const lateRow = rows[0];
    assert.equal(lateRow?.unresolved, 1);
    assert.equal(lateRow?.overdue, 1);
    assert.equal(lateRow?.needsConfirmation, 0, "an accepted Commitment needs no confirmation");
    assert.equal(rows[1]?.needsConfirmation, 1);
    const view = k.counterpartView({ principal: A, counterpartId: late.id, now: now() });
    assert.equal(view.outcome, "ok");
    const v = (view as Extract<typeof view, { outcome: "ok" }>).view;
    assert.equal(v.responsible.length, 1);
    assert.deepEqual(v.related.map((entry) => entry.title).toSorted(), ["工作一", "工作二"]);
    assert.equal(
      k.counterpartView({ principal: B, counterpartId: late.id, now: now() }).outcome,
      "not_found",
    );
    assert.equal(list(B).length, 0);
    const found = k.counterpartList({
      principal: A,
      now: now(),
      keyword: "逾期",
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(
      found.items.map((entry) => entry.displayName),
      ["逾期乙"],
    );
  });

  it("lists what a person owes most recently changed first, whatever the due dates", () => {
    const p = person("排序人");
    const first = commit(
      "先建的",
      { kind: "counterpart", counterpartId: p.id },
      { due: now() + 1000 },
    );
    const second = commit(
      "后建的",
      { kind: "counterpart", counterpartId: p.id },
      { due: now() + 9_000_000 },
    );
    const order = () => {
      const out = k.counterpartView({ principal: A, counterpartId: p.id, now: now() });
      return (out as Extract<typeof out, { outcome: "ok" }>).view.responsible.map(
        (entry) => entry.requirementText,
      );
    };
    assert.deepEqual(order(), ["后建的", "先建的"]);
    const edited = k.commitmentUpdate({
      principal: A,
      commitmentId: first,
      changes: { nextStep: "下周再问" },
      actor: "user",
      now: now(),
    });
    assert.equal(edited.outcome, "updated");
    assert.deepEqual(order(), ["先建的", "后建的"], "the one edited last comes first");
    assert.notEqual(first, second);
  });

  it("previews a deactivation without changing anything, then moves open Commitments to a typed name with a new version", () => {
    const p = person("离职人", { aliases: ["老离"], contacts: [{ type: "phone", value: "100" }] });
    const open = commit("未完成交付", { kind: "counterpart", counterpartId: p.id });
    accept(open);
    const done = commit("已完成交付", { kind: "counterpart", counterpartId: p.id });
    k.commitmentResolve({
      principal: A,
      commitmentId: done,
      reason: "收到了",
      now: now(),
    });
    const wk = k.workCreate({
      principal: A,
      spec: { title: "依赖交付", origin: "user" },
      now: now(),
    }) as { workId: string };
    k.workLinkAdd({
      principal: A,
      workId: wk.workId,
      role: "required",
      targetKind: "commitment",
      targetId: open,
      actor: "user",
      now: now(),
    });
    const before = get(open).commitment;
    const preview = k.counterpartDeactivate({
      principal: A,
      counterpartId: p.id,
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    const impact = (preview as Extract<typeof preview, { outcome: "preview" }>).impact;
    assert.deepEqual(
      [
        impact.contacts,
        impact.openCommitments,
        impact.resolvedCommitments,
        impact.works.map((w) => w.title),
      ],
      [1, 1, 1, ["依赖交付"]],
    );
    assert.equal(get(open).commitment.revision, before.revision, "a preview writes nothing");
    assert.equal(
      k.counterpartDeactivate({ principal: A, counterpartId: p.id, now: now() }).outcome,
      "reason_required",
    );
    const out = k.counterpartDeactivate({
      principal: A,
      counterpartId: p.id,
      reason: "已离职",
      now: now(),
    });
    assert.equal(out.outcome, "deactivated");
    const moved = get(open);
    assert.equal(moved.commitment.responsibleCounterpartId, null);
    assert.equal(moved.commitment.responsibleRaw, "离职人");
    assert.equal(moved.commitment.responsibilityVersion, before.responsibilityVersion + 1);
    assert.equal(
      moved.commitment.acceptanceState,
      "unknown",
      "the old acceptance is not reused for nobody",
    );
    assert.equal(moved.versions.length, 1);
    assert.ok(moved.events.some((e) => e.kind === "responsible_changed"));
    const history = get(done).commitment;
    assert.equal(
      history.responsibleCounterpartId,
      p.id,
      "resolved history keeps the person it was made with",
    );
    assert.equal(k.counterpartResolveName({ principal: A, name: "离职人" }).match, "none");
    assert.equal(k.counterpartResolveName({ principal: A, name: "老离" }).match, "none");
    assert.equal(
      k.counterpartList({ principal: A, now: now(), lifecycle: "inactive", limit: 10, offset: 0 })
        .items[0]?.id,
      p.id,
    );
    assert.equal(
      k.counterpartDeactivate({ principal: A, counterpartId: p.id, reason: "again", now: now() })
        .outcome,
      "closed",
    );
    const restored = k.counterpartRestore({ principal: A, counterpartId: p.id, now: now() });
    assert.equal(restored.outcome, "restored");
    assert.equal(k.counterpartResolveName({ principal: A, name: "老离" }).match, "one");
    assert.equal(
      get(open).commitment.responsibleCounterpartId,
      null,
      "restoring does not take work back by itself",
    );
    assert.equal(
      k.counterpartRestore({ principal: A, counterpartId: p.id, now: now() }).outcome,
      "not_inactive",
    );
  });

  it("groups typed-name Commitments and claims them: a known name resolves in place, another person takes over with a version", () => {
    const wang = person("王小明乙", { aliases: ["阿旺"] });
    const l1 = commit("甲", { kind: "name", name: "阿旺" });
    const l2 = commit("乙", { kind: "name", name: " 阿旺 " });
    const l3 = commit("丙", { kind: "name", name: "小李子" }, { due: now() - 1000 });
    accept(l1);
    const groups = k.counterpartPending({ principal: A, now: now() }).groups;
    const g = groups.find((entry) => entry.key === "阿旺");
    assert.equal(g?.open, 2);
    assert.equal(g?.suggestions[0]?.id, wang.id);
    assert.equal(groups[0]?.raw, "小李子", "overdue groups come first");
    const before = get(l1).commitment;
    const claim = k.counterpartClaim({
      principal: A,
      counterpartId: wang.id,
      raw: "阿旺",
      now: now(),
    });
    assert.equal(claim.outcome, "claimed");
    assert.deepEqual(
      [(claim as { resolved: number }).resolved, (claim as { versioned: number }).versioned],
      [2, 0],
    );
    const after = get(l1);
    assert.equal(after.commitment.responsibleCounterpartId, wang.id);
    assert.equal(after.commitment.responsibleRaw, null);
    assert.equal(after.commitment.responsibilityVersion, before.responsibilityVersion);
    assert.equal(
      after.commitment.acceptanceState,
      "accepted",
      "identifying the same person keeps what was agreed",
    );
    assert.ok(after.events.some((e) => e.kind === "responsible_resolved"));
    assert.equal(get(l2).commitment.responsibleCounterpartId, wang.id);
    assert.equal(
      k.counterpartClaim({ principal: A, counterpartId: wang.id, raw: "阿旺", now: now() }).outcome,
      "nothing_to_claim",
    );
    // "小李子" is not one of 王小明's names: handing it to him is a change of person.
    const other = k.counterpartClaim({
      principal: A,
      counterpartId: wang.id,
      raw: "小李子",
      now: now(),
    });
    assert.equal((other as { versioned: number }).versioned, 1);
    assert.equal(get(l3).commitment.responsibilityVersion, 2);
    assert.equal(k.counterpartResolveName({ principal: A, name: "小李子" }).match, "none");
  });

  it("remembers the typed name as an alias on request, skips closed Commitments when a person changes, and stays inside the owner", () => {
    const li = person("李明");
    const open = commit("丁", { kind: "name", name: "阿明" });
    const closed = commit("戊", { kind: "name", name: "阿明" });
    k.commitmentResolve({
      principal: A,
      commitmentId: closed,
      reason: "好了",
      now: now(),
    });
    const plain = k.counterpartClaim({
      principal: A,
      counterpartId: li.id,
      commitmentIds: [closed],
      now: now(),
    });
    assert.equal(
      plain.outcome,
      "nothing_to_claim",
      "a closed Commitment is not handed to a new person",
    );
    const remembered = k.counterpartClaim({
      principal: A,
      counterpartId: li.id,
      raw: "阿明",
      rememberAlias: true,
      now: now(),
    });
    assert.deepEqual(
      [
        (remembered as { resolved: number }).resolved,
        (remembered as { versioned: number }).versioned,
      ],
      [2, 0],
    );
    assert.equal(get(open).commitment.responsibleCounterpartId, li.id);
    assert.equal(k.counterpartResolveName({ principal: A, name: "阿明" }).candidates[0]?.id, li.id);
    assert.equal(
      k.counterpartClaim({ principal: B, counterpartId: li.id, raw: "阿明", now: now() }).outcome,
      "not_found",
    );
    assert.deepEqual(k.counterpartClaim({ principal: A, counterpartId: li.id, now: now() }), {
      outcome: "invalid",
      code: "nothing_selected",
    });
  });
});
