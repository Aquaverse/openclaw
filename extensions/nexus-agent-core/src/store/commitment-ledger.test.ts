// Commitment kernel tests (design 4.4, 6): real SQL on node:sqlite, every migration applied. Covers creation and the Agent's limits,
// responsibility versions, the four state lines, manual resolve / cancel / restore / reopen with their impact preview, the effect
// on the Works that cite a Commitment, the engine's atomic verification commit and the period generator.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { requestFingerprint } from "../canonical.js";
import type { CommitmentSpec } from "../commitment/types.js";
import { A, B, setup } from "../test-support/goal-kit.js";

const kit = setup();
const { k, db, now } = kit;

const spec = (text: string, over: Partial<CommitmentSpec> = {}): CommitmentSpec => ({
  requirementText: text,
  responsible: { kind: "name", name: "小王" },
  origin: { kind: "native_record", refId: `ui_${text}` },
  ...over,
});
const make = (text: string, over: Partial<CommitmentSpec> = {}, owner = A) => {
  const out = k.commitmentCreate({
    principal: owner,
    spec: spec(text, over),
    createdBy: "user",
    now: now(),
  });
  assert.ok(out.outcome === "created" || out.outcome === "exists", JSON.stringify(out));
  return (out as { commitment: { id: string } }).commitment;
};
const get = (id: string, owner = A) => {
  const out = k.commitmentGet({ principal: owner, commitmentId: id, now: now() });
  assert.equal(out.outcome, "ok");
  return out as Extract<typeof out, { outcome: "ok" }>;
};
const newWork = (title: string, owner = A) => {
  const w = k.workCreate({ principal: owner, spec: { title, origin: "user" }, now: now() });
  assert.equal(w.outcome, "created");
  return (w as { workId: string }).workId;
};
const workState = (workId: string, owner = A) => {
  const got = k.workGet({ principal: owner, workId, now: now(), eventLimit: 20 });
  assert.ok(got);
  return got.state;
};
const link = (workId: string, commitmentId: string, role = "required") =>
  k.workLinkAdd({
    principal: A,
    workId,
    role,
    targetKind: "commitment",
    targetId: commitmentId,
    actor: "user",
    now: now(),
  });
const verify = (id: string, overall: "met" | "not_met" | "conflicting_evidence", version: number) =>
  k.commitmentCommitVerification({
    principal: A,
    commitmentId: id,
    expectedCommitVersion: version,
    overall,
    evidenceSetHash: `h${version}`,
    now: now(),
  });

describe("commitment kernel", () => {
  it("applies stage7-0002 and stage7-0003 and creates their tables", () => {
    const names = new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String((row as { name: string }).name)),
    );
    for (const table of [
      "counterparts",
      "owner_identity",
      "counterpart_names",
      "counterpart_relations",
      "work_participant_links",
      "commitment_participant_links",
      "counterpart_endpoints",
      "identity_links",
      "unresolved_mentions",
      "commitments",
      "commitment_responsibility_versions",
      "commitment_events",
      "outcome_contract_versions",
      "commitment_assessments",
      "criterion_assessments",
      "evidence_attributions",
    ]) {
      assert.ok(names.has(table), `${table} should exist`);
    }
  });

  it("creates an open commitment with honest defaults and one created event", () => {
    const made = make("交周报");
    const got = get(made.id);
    const c = got.commitment;
    assert.equal(c.lifecycle, "open");
    assert.equal(c.communicationState, "draft");
    assert.equal(c.acceptanceState, "unknown");
    assert.equal(c.verification, "unverified");
    assert.equal(c.dueState, "pending");
    assert.equal(c.responsibleRaw, "小王");
    assert.equal(c.responsibleCounterpartId, null);
    assert.equal(c.responsibilityVersion, 1);
    assert.equal(c.overdue, false);
    assert.deepEqual(
      got.events.map((e) => e.kind),
      ["created"],
    );
    assert.ok(made.id.startsWith("cm_"));
  });

  it("'self' resolves to the owner's one identity row, created once", () => {
    const first = make("我来订票", { responsible: { kind: "self" } });
    const second = make("我来改签", { responsible: { kind: "self" } });
    const a = get(first.id).commitment;
    const b = get(second.id).commitment;
    assert.equal(a.responsibleSelf, true);
    assert.equal(a.responsibleCounterpartId, b.responsibleCounterpartId);
    const rows = db
      .prepare("SELECT COUNT(*) AS c FROM owner_identity WHERE owner_id = ?")
      .get(A.ownerId) as { c: number };
    assert.equal(rows.c, 1);
  });

  it("rejects bad input and keeps the person's own words", () => {
    const bad = (over: Partial<CommitmentSpec>) =>
      k.commitmentCreate({ principal: A, spec: spec("x", over), createdBy: "user", now: now() });
    assert.deepEqual(bad({ requirementText: "   " }), {
      outcome: "invalid",
      code: "bad_requirement",
    });
    assert.deepEqual(bad({ requirementText: "a".repeat(501) }), {
      outcome: "invalid",
      code: "bad_requirement",
    });
    assert.equal(
      (bad({ due: { kind: "known", at: 5, tz: "Not/AZone" } }) as { code: string }).code,
      "bad_due",
    );
    assert.equal(
      (bad({ responsible: { kind: "name", name: " " } }) as { code: string }).code,
      "responsible_required",
    );
    assert.equal(
      (bad({ responsible: { kind: "counterpart", counterpartId: "nope" } }) as { code: string })
        .code,
      "counterpart_not_found",
    );
    assert.equal(
      (bad({ origin: { kind: "task_run", refId: "T-missing" } }) as { code: string }).code,
      "origin_not_found",
    );
  });

  it("an Agent record needs the user's statement, is a native record, and cannot name a proposed person", () => {
    const noRef = k.commitmentCreate({
      principal: A,
      spec: spec("agent a"),
      createdBy: "agent",
      now: now(),
    });
    assert.deepEqual(noRef, { outcome: "invalid", code: "statement_ref_required" });
    const ok = k.commitmentCreate({
      principal: A,
      spec: { ...spec("agent b"), origin: { kind: "task_run", refId: "ignored" } },
      createdBy: "agent",
      userStatementRef: "msg:42",
      now: now(),
    });
    assert.equal(ok.outcome, "created");
    const record = (
      ok as { commitment: { originKind: string; originRefId: string; createdBy: string } }
    ).commitment;
    assert.equal(record.originKind, "native_record");
    assert.equal(record.originRefId, "msg:42");
    assert.equal(record.createdBy, "agent");
    // a retried tool call returns the same obligation
    const again = k.commitmentCreate({
      principal: A,
      spec: spec("agent b"),
      createdBy: "agent",
      userStatementRef: "msg:42",
      now: now(),
    });
    assert.equal(again.outcome, "exists");
    // a proposed counterpart is not enough for the Agent, but the user may name it
    const ts = now();
    db.prepare(
      "INSERT INTO counterparts (owner_id, id, kind, display_name, confirmation, origin, lifecycle, revision, created_at, updated_at) VALUES (?, 'cp_prop', 'person', 'P', 'proposed', 'agent', 'live', 1, ?, ?)",
    ).run(A.ownerId, ts, ts);
    const viaAgent = k.commitmentCreate({
      principal: A,
      spec: spec("agent c", { responsible: { kind: "counterpart", counterpartId: "cp_prop" } }),
      createdBy: "agent",
      userStatementRef: "msg:43",
      now: now(),
    });
    assert.deepEqual(viaAgent, { outcome: "invalid", code: "counterpart_not_confirmed" });
    const viaUser = k.commitmentCreate({
      principal: A,
      spec: spec("user c", { responsible: { kind: "counterpart", counterpartId: "cp_prop" } }),
      createdBy: "user",
      now: now(),
    });
    assert.equal(viaUser.outcome, "created");
  });

  it("a material edit snapshots the old version and resets communication and acceptance", () => {
    const made = make("交报价");
    const id = made.id;
    k.commitmentCommunication({
      principal: A,
      commitmentId: id,
      state: "submitted",
      actor: "user",
      now: now(),
    });
    k.commitmentAcceptance({
      principal: A,
      commitmentId: id,
      state: "accepted",
      basis: "他口头答应了",
      actor: "user",
      now: now(),
    });
    assert.equal(get(id).commitment.lifecycle, "waiting");
    const out = k.commitmentUpdate({
      principal: A,
      commitmentId: id,
      changes: { responsible: { kind: "name", name: "小李" } },
      actor: "user",
      now: now(),
    });
    assert.equal(out.outcome, "updated");
    const after = get(id);
    assert.equal(after.commitment.responsibilityVersion, 2);
    assert.equal(after.commitment.communicationState, "draft");
    assert.equal(after.commitment.acceptanceState, "unknown");
    assert.equal(after.commitment.acceptanceBasis, null);
    assert.equal(after.commitment.lifecycle, "open");
    assert.equal(after.versions.length, 1);
    const old = after.versions[0] as {
      responsibilityVersion: number;
      responsibleRaw: string | null;
      acceptanceState: string;
    };
    assert.equal(old.responsibilityVersion, 1);
    assert.equal(old.responsibleRaw, "小王");
    assert.equal(old.acceptanceState, "accepted");
    const kinds = new Set(after.events.map((e) => e.kind));
    for (const kind of ["edited", "responsible_changed", "responsibility_versioned"]) {
      assert.ok(kinds.has(kind as never), kind);
    }
  });

  it("a due-date or wording change is material; a next-step note is not", () => {
    const id = make("交方案").id;
    k.commitmentUpdate({
      principal: A,
      commitmentId: id,
      changes: { nextStep: "周三催一下" },
      actor: "user",
      now: now(),
    });
    assert.equal(get(id).commitment.responsibilityVersion, 1);
    assert.equal(get(id).commitment.nextStep, "周三催一下");
    const due = k.commitmentUpdate({
      principal: A,
      commitmentId: id,
      changes: { due: { kind: "known", at: now() + 86_400_000, tz: "Asia/Shanghai" } },
      actor: "user",
      now: now(),
    });
    assert.equal((due as { versioned: boolean }).versioned, true);
    assert.equal(get(id).commitment.responsibilityVersion, 2);
    const same = k.commitmentUpdate({
      principal: A,
      commitmentId: id,
      changes: { requirementText: "交方案" },
      actor: "user",
      now: now(),
    });
    assert.equal(same.outcome, "unchanged");
    // A note on its own is saved: it is a new edit event, and neither a new responsibility version nor a reset.
    const versionBefore = get(id).commitment.responsibilityVersion;
    const note = k.commitmentUpdate({
      principal: A,
      commitmentId: id,
      changes: {},
      reason: "补充说明",
      actor: "user",
      now: now(),
    });
    assert.equal(note.outcome, "updated");
    assert.equal((note as { versioned: boolean }).versioned, false);
    assert.equal(get(id).commitment.responsibilityVersion, versionBefore);
    const words = k.commitmentUpdate({
      principal: A,
      commitmentId: id,
      changes: { requirementText: "交终版方案" },
      actor: "user",
      now: now(),
    });
    assert.equal(words.outcome, "updated");
    assert.equal(get(id).commitment.responsibilityVersion, 3);
  });

  it("edits respect revision checks, the Agent's statement rule, and closed commitments", () => {
    const id = make("交合同").id;
    const rev = get(id).commitment.revision;
    assert.equal(
      k.commitmentUpdate({
        principal: A,
        commitmentId: id,
        changes: { nextStep: "x" },
        expectedRevision: rev + 5,
        actor: "user",
        now: now(),
      }).outcome,
      "revision_conflict",
    );
    assert.deepEqual(
      k.commitmentUpdate({
        principal: A,
        commitmentId: id,
        changes: { nextStep: "x" },
        actor: "agent",
        now: now(),
      }),
      { outcome: "invalid", code: "statement_ref_required" },
    );
    k.commitmentCancel({ principal: A, commitmentId: id, reason: "不做了", now: now() });
    assert.equal(
      k.commitmentUpdate({
        principal: A,
        commitmentId: id,
        changes: { nextStep: "x" },
        actor: "user",
        now: now(),
      }).outcome,
      "closed",
    );
  });

  it("communication: the user's report moves open to waiting; the Agent needs a receipt", () => {
    const id = make("发通知").id;
    const noReceipt = k.commitmentCommunication({
      principal: A,
      commitmentId: id,
      state: "submitted",
      actor: "agent",
      now: now(),
    });
    assert.deepEqual(noReceipt, { outcome: "invalid", code: "receipt_required" });
    const withReceipt = k.commitmentCommunication({
      principal: A,
      commitmentId: id,
      state: "confirmed",
      actionRef: "act_1",
      receiptLevel: "provider_accepted",
      actor: "agent",
      now: now(),
    });
    assert.equal(withReceipt.outcome, "updated");
    const c = get(id).commitment;
    assert.equal(c.communicationState, "confirmed");
    assert.equal(c.communicationActionRef, "act_1");
    assert.equal(c.lifecycle, "waiting");
    // a failed delivery does not pull it back to open and never pretends the person was told
    k.commitmentCommunication({
      principal: A,
      commitmentId: id,
      state: "failed",
      actionRef: "act_2",
      actor: "system",
      now: now(),
    });
    assert.equal(get(id).commitment.communicationState, "failed");
    assert.equal(
      k.commitmentCommunication({
        principal: A,
        commitmentId: id,
        state: "draft" as never,
        actor: "user",
        now: now(),
      }).outcome,
      "invalid",
    );
  });

  it("acceptance needs a basis, is never written by the Agent, and a user report is labelled as one", () => {
    const id = make("接受测试").id;
    const base = { principal: A, commitmentId: id, now: now() };
    assert.deepEqual(k.commitmentAcceptance({ ...base, state: "accepted", actor: "user" }), {
      outcome: "invalid",
      code: "basis_required",
    });
    assert.deepEqual(
      k.commitmentAcceptance({ ...base, state: "accepted", basis: "ok", actor: "agent" }),
      { outcome: "forbidden", code: "agent_cannot_accept" },
    );
    assert.deepEqual(
      k.commitmentAcceptance({
        ...base,
        state: "accepted",
        basis: "ok",
        basisKind: "counterpart_source",
        actor: "user",
      }),
      { outcome: "invalid", code: "basis_kind_not_allowed" },
    );
    const done = k.commitmentAcceptance({
      ...base,
      state: "accepted",
      basis: "他口头答应",
      actor: "user",
    });
    assert.equal(done.outcome, "updated");
    const c = get(id).commitment;
    assert.equal(c.acceptanceState, "accepted");
    assert.equal(c.acceptanceBasisKind, "user_report");
    assert.equal(c.acceptanceBasis, "他口头答应");
    // the Agent may relay a refusal that has a source
    assert.equal(
      k.commitmentAcceptance({
        ...base,
        state: "declined",
        basis: "邮件:他说做不了",
        actor: "agent",
      }).outcome,
      "updated",
    );
    assert.equal(get(id).commitment.acceptanceState, "declined");
    // only the user can clear it
    assert.equal(
      k.commitmentAcceptance({ ...base, state: "unknown", actor: "agent" }).outcome,
      "forbidden",
    );
    assert.equal(
      k.commitmentAcceptance({ ...base, state: "unknown", actor: "user" }).outcome,
      "updated",
    );
    assert.equal(get(id).commitment.acceptanceAt, null);
  });

  it("manual resolve needs a reason, previews its reach, keeps verification honest, and can be taken back", () => {
    const id = make("手动结案").id;
    const w1 = newWork("需要它");
    const w2 = newWork("只是参考它");
    assert.equal(link(w1, id).outcome, "linked");
    assert.equal(link(w2, id, "reference").outcome, "linked");
    assert.deepEqual(
      k.commitmentResolve({ principal: A, commitmentId: id, reason: " ", now: now() }),
      { outcome: "invalid", code: "reason_required" },
    );
    const preview = k.commitmentResolve({
      principal: A,
      commitmentId: id,
      reason: "他线下交了",
      dryRun: true,
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    const impact = (
      preview as { impact: { works: { workId: string; role: string }[]; plansToWrapUp: unknown[] } }
    ).impact;
    assert.deepEqual(
      impact.works.map((w) => [w.workId, w.role]).toSorted(),
      [
        [w1, "required"],
        [w2, "reference"],
      ].toSorted(),
    );
    assert.deepEqual(impact.plansToWrapUp, []);
    assert.equal(get(id).commitment.lifecycle, "open", "a dry run changes nothing");
    const done = k.commitmentResolve({
      principal: A,
      commitmentId: id,
      reason: "他线下交了",
      now: now(),
    });
    assert.equal(done.outcome, "resolved");
    const c = get(id).commitment;
    assert.equal(c.lifecycle, "resolved");
    assert.equal(c.resolutionBasis, "manual_override");
    assert.equal(c.verification, "unverified");
    assert.equal(c.resolutionReason, "他线下交了");
    assert.equal(
      k.commitmentResolve({ principal: A, commitmentId: id, reason: "again", now: now() }).outcome,
      "not_open",
    );
    const back = k.commitmentReopen({ principal: A, commitmentId: id, now: now() });
    assert.equal(back.outcome, "reopened");
    const after = get(id).commitment;
    assert.equal(after.lifecycle, "open");
    assert.equal(after.resolutionBasis, null);
    assert.equal(after.resolvedAt, null);
  });

  it("cancel is not fulfilment, needs a reason, and only an explicit restore revives it", () => {
    const id = make("取消测试").id;
    assert.equal(
      k.commitmentCancel({ principal: A, commitmentId: id, reason: "", now: now() }).outcome,
      "invalid",
    );
    assert.equal(
      k.commitmentCancel({ principal: A, commitmentId: id, reason: "不需要了", now: now() })
        .outcome,
      "cancelled",
    );
    const c = get(id).commitment;
    assert.equal(c.lifecycle, "cancelled");
    assert.equal(c.cancelReason, "不需要了");
    assert.equal(
      k.commitmentRestore({ principal: A, commitmentId: id, now: now() }).outcome,
      "restored",
    );
    assert.equal(get(id).commitment.lifecycle, "open");
    assert.equal(get(id).commitment.cancelledAt, null);
    assert.equal(
      k.commitmentRestore({ principal: A, commitmentId: id, now: now() }).outcome,
      "not_cancelled",
    );
    assert.equal(
      k.commitmentReopen({ principal: A, commitmentId: id, now: now() }).outcome,
      "not_resolved",
    );
  });

  it("overdue is computed, never stored", () => {
    const t = now();
    const id = make("过期测试", { due: { kind: "known", at: t - 1000, tz: "UTC" } }).id;
    assert.equal(get(id).commitment.overdue, true);
    const overdue = k.commitmentList({
      principal: A,
      now: now(),
      overdueOnly: true,
      limit: 50,
      offset: 0,
    });
    assert.ok(overdue.items.some((item) => item.commitment.id === id));
    k.commitmentCancel({ principal: A, commitmentId: id, reason: "x", now: now() });
    assert.equal(get(id).commitment.overdue, false);
    const col = db
      .prepare("SELECT COUNT(*) AS c FROM pragma_table_info('commitments') WHERE name = 'overdue'")
      .get() as { c: number };
    assert.equal(col.c, 0);
  });

  it("origin columns cannot change after creation (INV-27)", () => {
    const id = make("起源测试").id;
    assert.throws(() =>
      db
        .prepare("UPDATE commitments SET origin_ref_id = 'other' WHERE owner_id = ? AND id = ?")
        .run(A.ownerId, id),
    );
  });

  it("every read and write is scoped to its owner", () => {
    const id = make("A 的承诺").id;
    assert.equal(
      k.commitmentGet({ principal: B, commitmentId: id, now: now() }).outcome,
      "not_found",
    );
    assert.equal(
      k.commitmentCancel({ principal: B, commitmentId: id, reason: "x", now: now() }).outcome,
      "not_found",
    );
    assert.equal(
      k.commitmentList({ principal: B, now: now(), limit: 50, offset: 0 }).items.length,
      0,
    );
    const wB = newWork("B 的工作", B);
    const out = k.workLinkAdd({
      principal: B,
      workId: wB,
      role: "required",
      targetKind: "commitment",
      targetId: id,
      actor: "user",
      now: now(),
    });
    assert.equal(out.outcome, "target_not_found");
  });
});

describe("commitments and the Works that cite them", () => {
  it("cites one commitment once per Work: a second link in the other role is refused, and old double links fold into one", () => {
    const wid = newWork("纽约行程");
    const id = make("准备开会的材料").id;
    assert.equal(link(wid, id, "required").outcome, "linked");
    const second = link(wid, id, "reference") as { outcome: string; role?: string };
    assert.equal(second.outcome, "role_conflict");
    assert.equal(second.role, "required");
    assert.equal(link(wid, id, "required").outcome, "exists");
    // A Work that already holds both links (made before this rule) shows the commitment twice; a role change folds them.
    db.prepare(
      "INSERT INTO work_links (owner_id, id, work_id, role, target_kind, target_id, link_version, created_at) VALUES (?, 'wl_legacy', ?, 'reference', 'commitment', ?, 1, ?)",
    ).run(A.ownerId, wid, id, now());
    const active = () =>
      (
        db
          .prepare(
            "SELECT role FROM work_links WHERE owner_id = ? AND work_id = ? AND target_id = ? AND ended_at IS NULL ORDER BY role",
          )
          .all(A.ownerId, wid, id) as { role: string }[]
      ).map((r) => r.role);
    assert.deepEqual(active(), ["reference", "required"]);
    const need = k.commitmentSetRole({
      principal: A,
      workId: wid,
      commitmentId: id,
      role: "reference",
      actor: "user",
      now: now(),
    });
    assert.equal(
      need.outcome,
      "gap_ack_required",
      "dropping the required link still needs the acknowledgement",
    );
    const done = k.commitmentSetRole({
      principal: A,
      workId: wid,
      commitmentId: id,
      role: "reference",
      acknowledgeGap: true,
      actor: "user",
      now: now(),
    });
    assert.equal(done.outcome, "changed");
    assert.deepEqual(active(), ["reference"]);
  });

  it("a required open commitment with no follow-up shows a blocked Work, not a finished one", () => {
    const wid = newWork("等他交");
    const created = k.commitmentCreate({
      principal: A,
      spec: spec("等他交报价"),
      createdBy: "user",
      workId: wid,
      now: now(),
    });
    assert.equal(created.outcome, "created");
    const state = workState(wid);
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "no_follow_up");
  });

  it("only a source-verified commitment completes a Work; reopening takes the completion back", () => {
    const wid = newWork("要他交");
    const id = (
      k.commitmentCreate({
        principal: A,
        spec: spec("交成果"),
        createdBy: "user",
        workId: wid,
        now: now(),
      }) as { commitment: { id: string } }
    ).commitment.id;
    assert.equal(workState(wid).primary, "blocked");
    assert.equal((verify(id, "met", 99) as { outcome: string }).outcome, "stale");
    const out = verify(id, "met", 0);
    assert.equal(out.outcome, "committed");
    const c = get(id).commitment;
    assert.equal(c.lifecycle, "resolved");
    assert.equal(c.resolutionBasis, "source_verified");
    assert.equal(c.verification, "verified_complete");
    assert.ok(c.currentAssessmentId);
    assert.equal(c.verificationCommitVersion, 1);
    assert.equal(workState(wid).primary, "done");
    const events = db
      .prepare(
        "SELECT event_type FROM work_outcome_events WHERE owner_id = ? AND work_id = ? ORDER BY recorded_at, id",
      )
      .all(A.ownerId, wid) as { event_type: string }[];
    assert.deepEqual(
      events.map((e) => e.event_type),
      ["achieved"],
    );
    // new contradicting evidence: the user (or later the engine) reopens it and the Work stops being done
    assert.equal(
      k.commitmentReopen({ principal: A, commitmentId: id, now: now() }).outcome,
      "reopened",
    );
    const reopened = get(id).commitment;
    assert.equal(reopened.verification, "unverified");
    assert.equal(reopened.currentAssessmentId, null);
    assert.notEqual(workState(wid).primary, "done");
    const after = db
      .prepare(
        "SELECT event_type FROM work_outcome_events WHERE owner_id = ? AND work_id = ? ORDER BY recorded_at, id",
      )
      .all(A.ownerId, wid) as { event_type: string }[];
    assert.deepEqual(
      after.map((e) => e.event_type),
      ["achieved", "withdrawn"],
    );
    const live = db
      .prepare(
        "SELECT COUNT(*) AS c FROM commitment_assessments WHERE owner_id = ? AND commitment_id = ? AND superseded_at IS NULL",
      )
      .get(A.ownerId, id) as { c: number };
    assert.equal(live.c, 0);
  });

  it("a manual close or a cancel never completes the Work: it asks the user what to do", () => {
    const wid = newWork("手动不算完成");
    const id = (
      k.commitmentCreate({
        principal: A,
        spec: spec("交材料"),
        createdBy: "user",
        workId: wid,
        now: now(),
      }) as { commitment: { id: string } }
    ).commitment.id;
    k.commitmentResolve({ principal: A, commitmentId: id, reason: "线下收到了", now: now() });
    const state = workState(wid);
    assert.equal(state.primary, "needs_you");
    assert.equal(state.reasons[0]?.objectKind, "commitment");
    const wid2 = newWork("取消不算完成");
    const id2 = (
      k.commitmentCreate({
        principal: A,
        spec: spec("交材料2"),
        createdBy: "user",
        workId: wid2,
        now: now(),
      }) as { commitment: { id: string } }
    ).commitment.id;
    k.commitmentCancel({ principal: A, commitmentId: id2, reason: "不要了", now: now() });
    assert.equal(workState(wid2).primary, "needs_you");
    // the user ends the Work with what exists: that is the honest way out
    const ended = k.workControl({
      principal: A,
      workId: wid,
      action: "end_partial",
      decisionRef: "console:req-c",
      actor: "user",
      now: now(),
    });
    assert.equal(ended.outcome, "ended");
    assert.equal(workState(wid).primary, "ended_incomplete");
  });

  it("a verification that finds a problem keeps the commitment open and asks the user", () => {
    const wid = newWork("核验异常");
    const id = (
      k.commitmentCreate({
        principal: A,
        spec: spec("交文件"),
        createdBy: "user",
        workId: wid,
        now: now(),
      }) as { commitment: { id: string } }
    ).commitment.id;
    assert.equal(verify(id, "not_met", 0).outcome, "committed");
    const c = get(id).commitment;
    assert.equal(c.lifecycle, "open");
    assert.equal(c.verification, "verified_exception");
    assert.equal(workState(wid).primary, "needs_you");
    assert.equal(verify(id, "conflicting_evidence", 1).outcome, "committed");
    assert.equal(get(id).commitment.verification, "conflicting_evidence");
    // one current assessment at all times
    const live = db
      .prepare(
        "SELECT COUNT(*) AS c FROM commitment_assessments WHERE owner_id = ? AND commitment_id = ? AND superseded_at IS NULL",
      )
      .get(A.ownerId, id) as { c: number };
    assert.equal(live.c, 1);
  });

  it("a reference commitment never blocks; linking a new required one takes a finished Work back", () => {
    const wid = newWork("参考不阻断");
    const t = k.create({
      principal: A,
      id: "Tref1",
      kind: "errand",
      title: "t",
      goal: { text: "g" },
      entities: null,
      idempotencyKey: "op_ref1",
      fingerprint: requestFingerprint({ kind: "errand", entities: null, goal: { key: "op_ref1" } }),
      sessionKey: "agent:main:main",
      now: now(),
      work: { title: "参考不阻断 task work", origin: "agent" },
    });
    assert.equal(t.outcome, "created");
    const taskWork = (t as { workId: string }).workId;
    db.prepare(
      "UPDATE nexus_tasks SET status = 'succeeded' WHERE owner_id = ? AND id = 'Tref1'",
    ).run(A.ownerId);
    k.workEvaluate({ principal: A, workId: taskWork, now: now() });
    assert.equal(workState(taskWork).primary, "done");
    const ref = make("只是参考");
    assert.equal(link(taskWork, ref.id, "reference").outcome, "linked");
    assert.equal(workState(taskWork).primary, "done");
    const req = make("真的需要");
    assert.equal(link(taskWork, req.id, "required").outcome, "linked");
    assert.notEqual(workState(taskWork).primary, "done");
    assert.ok(wid);
  });

  it("removing a required commitment link needs an explicit acknowledgement", () => {
    const wid = newWork("解除关联");
    const id = (
      k.commitmentCreate({
        principal: A,
        spec: spec("交付物"),
        createdBy: "user",
        workId: wid,
        now: now(),
      }) as { commitment: { id: string } }
    ).commitment.id;
    const linkRow = db
      .prepare("SELECT id FROM work_links WHERE owner_id = ? AND work_id = ? AND target_id = ?")
      .get(A.ownerId, wid, id) as { id: string };
    const base = {
      principal: A,
      workId: wid,
      linkId: linkRow.id,
      basis: "user_unlinked",
      actor: "user" as const,
      now: now(),
    };
    assert.equal(k.workLinkEnd(base).outcome, "gap_ack_required");
    assert.equal(k.workLinkEnd({ ...base, acknowledgeGap: true }).outcome, "ended");
    const kinds = new Set(get(id).events.map((e) => e.kind));
    assert.ok(kinds.has("linked_to_work") && kinds.has("unlinked_from_work"));
  });

  it("list filters by Work with the link role, by lifecycle and keyword, and pages", () => {
    const wid = newWork("列表测试");
    const a = k.commitmentCreate({
      principal: A,
      spec: spec("列表甲"),
      createdBy: "user",
      workId: wid,
      now: now(),
    }) as { commitment: { id: string } };
    const b = k.commitmentCreate({
      principal: A,
      spec: spec("列表乙"),
      createdBy: "user",
      workId: wid,
      workRole: "reference",
      now: now(),
    }) as { commitment: { id: string } };
    const out = k.commitmentList({ principal: A, now: now(), workId: wid, limit: 10, offset: 0 });
    assert.equal(out.total, 2);
    const roles = Object.fromEntries(out.items.map((i) => [i.commitment.id, i.role]));
    assert.equal(roles[a.commitment.id], "required");
    assert.equal(roles[b.commitment.id], "reference");
    k.commitmentCancel({ principal: A, commitmentId: b.commitment.id, reason: "x", now: now() });
    const open = k.commitmentList({
      principal: A,
      now: now(),
      workId: wid,
      lifecycles: ["open", "waiting"],
      limit: 10,
      offset: 0,
    });
    assert.deepEqual(
      open.items.map((i) => i.commitment.id),
      [a.commitment.id],
    );
    const kw = k.commitmentList({
      principal: A,
      now: now(),
      keyword: "列表乙",
      limit: 10,
      offset: 0,
    });
    assert.equal(kw.total, 1);
    const page = k.commitmentList({ principal: A, now: now(), workId: wid, limit: 1, offset: 1 });
    assert.equal(page.items.length, 1);
    assert.equal(page.total, 2);
    assert.equal(
      k.commitmentList({ principal: A, now: now(), keyword: "100%_", limit: 10, offset: 0 }).total,
      0,
    );
  });
});

describe("periodic obligations", () => {
  const period = (i: number) => ({
    key: `2026-W${i}`,
    index: i,
    start: 1_000_000 * i,
    end: 1_000_000 * i + 500_000,
    tz: "Asia/Shanghai",
    dueAt: 1_000_000 * i + 400_000,
  });
  it("creates one commitment per period, idempotent on request id + period key", () => {
    const wid = newWork("每周周报");
    const input = {
      principal: A,
      requestId: "req_weekly",
      spec: spec("交周报"),
      periods: [1, 2, 3].map(period),
      createdBy: "user" as const,
      workId: wid,
      now: now(),
    };
    const first = k.commitmentGeneratePeriods(input);
    assert.equal(first.outcome, "generated");
    assert.equal((first as { created: unknown[] }).created.length, 3);
    const again = k.commitmentGeneratePeriods({ ...input, now: now() });
    assert.equal((again as { created: unknown[] }).created.length, 0);
    assert.equal((again as { existing: unknown[] }).existing.length, 3);
    const rows = k.commitmentList({ principal: A, now: now(), workId: wid, limit: 20, offset: 0 });
    assert.equal(rows.total, 3);
    // each period is its own obligation: resolving one leaves the rest
    const firstId = (first as { created: { id: string }[] }).created[0]?.id as string;
    k.commitmentResolve({
      principal: A,
      commitmentId: firstId,
      reason: "第一期线下交了",
      now: now(),
    });
    const open = k.commitmentList({
      principal: A,
      now: now(),
      workId: wid,
      lifecycles: ["open"],
      limit: 20,
      offset: 0,
    });
    assert.equal(open.total, 2);
  });

  it("refuses more than 12 periods and leaves nothing half-created on a bad one", () => {
    const tooMany = k.commitmentGeneratePeriods({
      principal: A,
      requestId: "req_many",
      spec: spec("太多期"),
      periods: Array.from({ length: 13 }, (_, i) => period(i + 1)),
      createdBy: "user",
      now: now(),
    });
    assert.equal(tooMany.outcome, "invalid");
    assert.equal((tooMany as { code: string }).code, "too_many_periods");
    const bad = k.commitmentGeneratePeriods({
      principal: A,
      requestId: "req_bad",
      spec: spec("有坏的一期"),
      periods: [period(1), { ...period(2), end: 1 }],
      createdBy: "user",
      now: now(),
    });
    assert.equal((bad as { code: string }).code, "bad_period");
    const none = db
      .prepare(
        "SELECT COUNT(*) AS c FROM commitments WHERE owner_id = ? AND period_request_id IN ('req_many','req_bad')",
      )
      .get(A.ownerId) as { c: number };
    assert.equal(none.c, 0);
  });
});
