// Work kernel tests (design 4.2, 5, 12): real SQL on node:sqlite, every migration applied. Covers creation inside the Task
// transaction (INV-02), the outcome chain, end facts and reopening, stacked controls, the Goal link and its shadow, typed links,
// the backfill and the integrity report.
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { requestFingerprint } from "../canonical.js";
import { A, B, setup } from "../test-support/goal-kit.js";
import type { WorkSpec } from "../work/types.js";
import type { CreateInput } from "./kernel.js";

const kit = setup();
const { k, db, now, count } = kit;

let seq = 0;
function makeTask(over: Partial<CreateInput> & { work?: WorkSpec } = {}, owner = A) {
  seq += 1;
  const id = over.id ?? `T${seq}`;
  const key = over.idempotencyKey ?? `op_${id}`;
  const out = k.create({
    principal: owner,
    id,
    kind: "errand",
    title: over.title ?? `task ${seq}`,
    goal: { text: `goal ${seq}` },
    entities: null,
    idempotencyKey: key,
    fingerprint: requestFingerprint({ kind: "errand", entities: null, goal: { key } }),
    sessionKey: "agent:main:main",
    now: now(),
    ...over,
  });
  return out;
}
const spec = (title: string, over: Partial<WorkSpec> = {}): WorkSpec => ({
  title,
  origin: "agent",
  ...over,
});
const setStatus = (taskId: string, status: string) =>
  db
    .prepare("UPDATE nexus_tasks SET status = ? WHERE owner_id = ? AND id = ?")
    .run(status, A.ownerId, taskId);
const view = (workId: string, owner = A) => {
  const got = k.workGet({ principal: owner, workId, now: now(), eventLimit: 50 });
  assert.ok(got, "work should exist");
  return got;
};
const created = (out: ReturnType<typeof makeTask>) => {
  assert.equal(out.outcome, "created");
  assert.ok("workId" in out && out.workId);
  return { task: out.task, workId: out.workId as string };
};

describe("work kernel", () => {
  it("applies stage7-0001 and creates every Work table", () => {
    const names = new Set(
      (
        db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
    for (const table of [
      "works",
      "work_versions",
      "task_work_owner",
      "work_links",
      "goal_work_links",
      "work_events",
      "work_outcome_events",
      "work_terminal_events",
      "work_prerequisites",
      "work_controls",
      "task_ext",
      "context_scopes",
      "task_adoptions",
      "store_flags",
      "migration_snapshots",
    ]) {
      assert.ok(names.has(table), table);
    }
    assert.equal(
      count("SELECT COUNT(*) AS c FROM schema_migrations WHERE id = 'stage7-0001-works'"),
      1,
    );
  });

  it("creates the Work in the Task transaction: one owner row, version 1, created event, a root scope", () => {
    const { task, workId } = created(
      makeTask({ work: spec("Book the Tokyo flight", { requestText: "Book a flight to Tokyo" }) }),
    );
    const v = view(workId);
    assert.equal(v.work.title, "Book the Tokyo flight");
    assert.equal(v.work.origin, "agent");
    assert.equal(v.work.contextOrigin, "explicit");
    assert.equal(v.tasks.length, 1);
    assert.equal(v.tasks[0]?.id, task.id);
    assert.equal(count("SELECT COUNT(*) AS c FROM task_work_owner WHERE task_id = ?", task.id), 1);
    assert.equal(count("SELECT COUNT(*) AS c FROM work_versions WHERE work_id = ?", workId), 1);
    assert.equal(v.events[0]?.kind, "created");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM context_scopes WHERE owner_id = ? AND scope_kind = 'mode'",
        A.ownerId,
      ),
      1,
    );
    // A freshly created Task is `clarifying`: the user owes input.
    assert.equal(v.state.primary, "needs_you");
  });

  it("replaying the same idempotency key returns the same Work and creates nothing", () => {
    const first = created(makeTask({ idempotencyKey: "replay-1", work: spec("Replay me") }));
    const before = count("SELECT COUNT(*) AS c FROM works");
    const again = makeTask({ id: "TX", idempotencyKey: "replay-1", work: spec("Replay me") });
    assert.equal(again.outcome, "replayed");
    assert.equal("workId" in again ? again.workId : undefined, first.workId);
    assert.equal(count("SELECT COUNT(*) AS c FROM works"), before);
  });

  it("a Task without a work spec creates no Work (worksEnabled off behaves as before)", () => {
    const out = makeTask({});
    assert.equal(out.outcome, "created");
    assert.equal("workId" in out ? out.workId : undefined, undefined);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM task_work_owner WHERE task_id = ?",
        (out as { task: { id: string } }).task.id,
      ),
      0,
    );
  });

  it("attaches a second Task to an existing Work; foreign, missing and archived Works are refused without side effects", () => {
    const one = created(makeTask({ work: spec("Shared work") }));
    const two = created(makeTask({ work: spec("ignored title", { workId: one.workId }) }));
    assert.equal(two.workId, one.workId);
    assert.equal(view(one.workId).tasks.length, 2);

    const tasksBefore = count("SELECT COUNT(*) AS c FROM nexus_tasks");
    const missing = makeTask({ work: spec("x", { workId: "w_nope" }) });
    assert.deepEqual(missing, { outcome: "work_unusable", reason: "work_not_found" });
    const foreign = makeTask({ work: spec("x", { workId: one.workId }) }, B);
    assert.deepEqual(foreign, { outcome: "work_unusable", reason: "work_not_found" });
    k.workUpdate({
      principal: A,
      workId: one.workId,
      patch: { archived: true },
      actor: "user",
      now: now(),
    });
    const archived = makeTask({ work: spec("x", { workId: one.workId }) });
    assert.deepEqual(archived, { outcome: "work_unusable", reason: "work_not_live" });
    assert.equal(count("SELECT COUNT(*) AS c FROM nexus_tasks"), tasksBefore);
  });

  it("a repeated request reference reuses the Work", () => {
    const a = created(makeTask({ work: spec("From message", { requestRef: "msg-42" }) }));
    const b = created(makeTask({ work: spec("From message again", { requestRef: "msg-42" }) }));
    assert.equal(a.workId, b.workId);
    assert.equal(view(a.workId).tasks.length, 2);
  });

  it("task_work_owner is write-once (INV-02)", () => {
    const { task } = created(makeTask({ work: spec("immutable owner") }));
    const other = created(makeTask({ work: spec("other") })).workId;
    assert.throws(
      () =>
        db.prepare("UPDATE task_work_owner SET work_id = ? WHERE task_id = ?").run(other, task.id),
      /INV-02/,
    );
    assert.throws(
      () => db.prepare("DELETE FROM task_work_owner WHERE task_id = ?").run(task.id),
      /INV-02/,
    );
  });

  it("outcome chain: achieved, withdrawn when an unfinished Task joins, reinstated; done is read from the event", () => {
    const first = created(makeTask({ work: spec("Chain") }));
    assert.notEqual(view(first.workId).state.primary, "done");
    setStatus(first.task.id, "succeeded");
    assert.equal(
      k.workEvaluate({ principal: A, workId: first.workId, now: now() }).outcome,
      "evaluated",
    );
    const done = view(first.workId);
    assert.equal(done.state.primary, "done");
    assert.equal(done.outcome?.eventType, "achieved");
    const firstAt = done.outcome?.firstAchievedAt;
    assert.ok(firstAt);

    const second = created(makeTask({ work: spec("x", { workId: first.workId }) }));
    const reopened = view(first.workId);
    assert.notEqual(reopened.state.primary, "done", "an unfinished Task withdraws the achievement");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_outcome_events WHERE work_id = ? AND event_type = 'withdrawn'",
        first.workId,
      ),
      1,
    );

    setStatus(second.task.id, "succeeded");
    k.workEvaluate({ principal: A, workId: first.workId, now: now() });
    const again = view(first.workId);
    assert.equal(again.state.primary, "done");
    assert.equal(again.outcome?.eventType, "reinstated");
    assert.equal(again.outcome?.firstAchievedAt, firstAt, "first_achieved_at stays fixed");
    // Re-running changes nothing.
    k.workEvaluate({ principal: A, workId: first.workId, now: now() });
    assert.equal(
      count("SELECT COUNT(*) AS c FROM work_outcome_events WHERE work_id = ?", first.workId),
      3,
    );
  });

  it("a superseded Task does not count against the achievement", () => {
    const first = created(makeTask({ work: spec("Successor chain") }));
    const next = created(makeTask({ work: spec("x", { workId: first.workId }) }));
    db.prepare(
      "INSERT INTO task_ext (owner_id, task_id, supersedes_task_id, revision, updated_at) VALUES (?, ?, ?, 1, 1)",
    ).run(A.ownerId, next.task.id, first.task.id);
    setStatus(first.task.id, "cancelled");
    setStatus(next.task.id, "succeeded");
    k.workEvaluate({ principal: A, workId: first.workId, now: now() });
    assert.equal(view(first.workId).state.primary, "done");
  });

  it("stop_work: preview, needs a decision reference, cancels open Tasks, ends the Work and blocks later achievement; reopen needs a basis", () => {
    const w = created(makeTask({ work: spec("Stop me") }));
    setStatus(w.task.id, "executing");
    const preview = k.workControl({
      principal: A,
      workId: w.workId,
      action: "stop_work",
      dryRun: true,
      actor: "user",
      now: now(),
    });
    assert.equal(preview.outcome, "preview");
    assert.equal(
      db.prepare("SELECT status FROM nexus_tasks WHERE id = ?").get(w.task.id)?.status,
      "executing",
      "dry run changes nothing",
    );
    assert.equal(
      k.workControl({
        principal: A,
        workId: w.workId,
        action: "stop_work",
        actor: "user",
        now: now(),
      }).outcome,
      "needs_decision_ref",
    );
    const stopped = k.workControl({
      principal: A,
      workId: w.workId,
      action: "stop_work",
      decisionRef: "console:req-1",
      actor: "user",
      now: now(),
    });
    assert.equal(stopped.outcome, "ended");
    assert.equal(
      db.prepare("SELECT status FROM nexus_tasks WHERE id = ?").get(w.task.id)?.status,
      "cancelled",
    );
    assert.equal(view(w.workId).state.primary, "ended_incomplete");
    assert.equal(
      k.workControl({
        principal: A,
        workId: w.workId,
        action: "stop_work",
        decisionRef: "console:req-2",
        actor: "user",
        now: now(),
      }).outcome,
      "already_ended",
    );

    assert.deepEqual(
      k.workControl({
        principal: A,
        workId: w.workId,
        action: "reopen",
        actor: "user",
        now: now(),
      }),
      { outcome: "invalid", code: "reopen_needs_basis" },
    );
    assert.equal(
      k.workControl({
        principal: A,
        workId: w.workId,
        action: "reopen",
        reopenBasis: "user changed mind",
        actor: "user",
        now: now(),
      }).outcome,
      "reopened",
    );
    assert.notEqual(view(w.workId).state.primary, "ended_incomplete");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_terminal_events WHERE work_id = ? AND reopened_at IS NOT NULL",
        w.workId,
      ),
      1,
    );
  });

  it("end_partial cancels open Tasks as partial and flags the result", () => {
    const w = created(makeTask({ work: spec("Partial") }));
    setStatus(w.task.id, "executing");
    const out = k.workControl({
      principal: A,
      workId: w.workId,
      action: "end_partial",
      decisionRef: "console:req-p",
      actor: "user",
      now: now(),
    });
    assert.equal(out.outcome, "ended");
    const v = view(w.workId);
    assert.equal(v.state.primary, "ended_incomplete");
    assert.ok(v.state.flags.includes("partial_result"));
    assert.ok(v.state.flags.includes("manual_close"));
  });

  it("controls stack: resume releases only the named one and reports the Work is still controlled", () => {
    const w = created(makeTask({ work: spec("Pause me") }));
    setStatus(w.task.id, "executing");
    assert.equal(view(w.workId).state.primary, "in_progress");
    const user = k.workControl({
      principal: A,
      workId: w.workId,
      action: "pause",
      actor: "user",
      now: now(),
    });
    assert.equal(user.outcome, "applied");
    const hold = k.workControl({
      principal: A,
      workId: w.workId,
      action: "pause",
      reason: "incident_hold",
      actor: "system",
      now: now(),
    });
    assert.equal(hold.outcome, "applied");
    assert.equal(
      k.workControl({ principal: A, workId: w.workId, action: "pause", actor: "user", now: now() })
        .outcome,
      "unchanged",
    );
    const paused = view(w.workId);
    assert.equal(paused.state.primary, "blocked");
    assert.equal(paused.state.reasons[0]?.code, "incident_hold");
    const released = k.workControl({
      principal: A,
      workId: w.workId,
      action: "resume",
      actor: "user",
      now: now(),
    });
    assert.equal(released.outcome, "released");
    assert.equal((released as { stillControlled: boolean }).stillControlled, true);
    assert.equal(view(w.workId).state.primary, "blocked");
    const holdId = (hold as { controlId: string }).controlId;
    k.workControl({
      principal: A,
      workId: w.workId,
      action: "resume",
      controlId: holdId,
      actor: "user",
      now: now(),
    });
    assert.equal(view(w.workId).state.primary, "in_progress");
    assert.equal(
      k.workControl({ principal: A, workId: w.workId, action: "resume", actor: "user", now: now() })
        .outcome,
      "no_such_control",
    );
  });

  it("prerequisites: a user request makes the Work needs_you, a system one blocks it, resolving clears both", () => {
    const w = created(makeTask({ work: spec("Needs input") }));
    setStatus(w.task.id, "executing");
    const user = k.workPrereqAdd({
      principal: A,
      workId: w.workId,
      kind: "input",
      actor: "user",
      reason: "need passport number",
      by: "agent",
      now: now(),
    });
    assert.equal(user.outcome, "added");
    assert.equal(view(w.workId).state.primary, "needs_you");
    k.workPrereqResolve({
      principal: A,
      workId: w.workId,
      prerequisiteId: (user as { prerequisiteId: string }).prerequisiteId,
      state: "satisfied",
      basis: "user_provided",
      by: "user",
      now: now(),
    });
    const sys = k.workPrereqAdd({
      principal: A,
      workId: w.workId,
      kind: "permission",
      actor: "system",
      reason: "no mail scope",
      by: "system",
      now: now(),
    });
    const blocked = view(w.workId);
    assert.equal(blocked.state.primary, "blocked");
    assert.equal(blocked.state.reasons[0]?.code, "permission_missing");
    assert.equal(
      k.workPrereqResolve({
        principal: A,
        workId: w.workId,
        prerequisiteId: (sys as { prerequisiteId: string }).prerequisiteId,
        state: "withdrawn",
        basis: "x",
        by: "system",
        now: now(),
      }).outcome,
      "resolved",
    );
    assert.equal(
      k.workPrereqAdd({
        principal: A,
        workId: w.workId,
        kind: "bogus",
        actor: "user",
        reason: "x",
        by: "user",
        now: now(),
      }).outcome,
      "invalid",
    );
    assert.equal(view(w.workId).state.primary, "in_progress");
  });

  it("Goal link has one write source and keeps the goal_links(task) shadow in step", () => {
    const g1 = kit.mustGoal(kit.createViaGrant(A, "Goal one").created);
    const g2 = kit.mustGoal(kit.createViaGrant(A, "Goal two").created);
    const first = created(makeTask({ work: spec("Goal work") }));
    const second = created(makeTask({ work: spec("x", { workId: first.workId }) }));
    assert.equal(
      k.workSetGoal({
        principal: A,
        workId: first.workId,
        goalId: g1.id,
        actor: "user",
        now: now(),
      }).outcome,
      "linked",
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_links WHERE kind = 'task' AND goal_id = ?", g1.id),
      2,
      "one shadow row per Task",
    );
    assert.equal(view(first.workId).goalId, g1.id);
    assert.equal(
      k.workSetGoal({
        principal: A,
        workId: first.workId,
        goalId: g1.id,
        actor: "user",
        now: now(),
      }).outcome,
      "unchanged",
    );
    assert.equal(
      k.workSetGoal({
        principal: A,
        workId: first.workId,
        goalId: g2.id,
        actor: "user",
        now: now(),
      }).outcome,
      "linked",
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_links WHERE kind = 'task' AND goal_id = ?", g1.id),
      0,
    );
    assert.equal(
      count("SELECT COUNT(*) AS c FROM goal_links WHERE kind = 'task' AND goal_id = ?", g2.id),
      2,
    );
    // A Task added later inherits the shadow.
    const third = created(makeTask({ work: spec("x", { workId: first.workId }) }));
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM goal_links WHERE kind = 'task' AND ref_id = ? AND goal_id = ?",
        third.task.id,
        g2.id,
      ),
      1,
    );
    assert.equal(
      k
        .workIntegrity({ principal: A, now: now() })
        .findings.filter((f) => f.code.startsWith("goal_shadow")).length,
      0,
    );
    assert.equal(
      k.workSetGoal({ principal: A, workId: first.workId, goalId: null, actor: "user", now: now() })
        .outcome,
      "cleared",
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM goal_links WHERE kind = 'task' AND ref_id IN (?, ?, ?)",
        first.task.id,
        second.task.id,
        third.task.id,
      ),
      0,
    );
    assert.equal(
      k.workSetGoal({
        principal: A,
        workId: first.workId,
        goalId: "G_nope",
        actor: "user",
        now: now(),
      }).outcome,
      "goal_not_found",
    );
  });

  it("an Executive Work refuses any Goal edge (INV-05)", () => {
    const g = kit.mustGoal(kit.createViaGrant(A, "Exec goal").created);
    const w = k.workCreate({
      principal: A,
      spec: { title: "Client work", origin: "user", contextMode: "executive" },
      now: now(),
    });
    assert.equal(w.outcome, "created");
    assert.equal(
      k.workSetGoal({
        principal: A,
        workId: (w as { workId: string }).workId,
        goalId: g.id,
        actor: "user",
        now: now(),
      }).outcome,
      "executive_work",
    );
  });

  it("typed links: coordination between Works, role/target mismatches, own Task outputs, a commitment that does not exist", () => {
    const a = created(makeTask({ work: spec("Link A") }));
    const b = created(makeTask({ work: spec("Link B") }));
    const link = k.workLinkAdd({
      principal: A,
      workId: a.workId,
      role: "coordination",
      targetKind: "work",
      targetId: b.workId,
      actor: "user",
      now: now(),
    });
    assert.equal(link.outcome, "linked");
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "coordination",
        targetKind: "work",
        targetId: b.workId,
        actor: "user",
        now: now(),
      }).outcome,
      "exists",
    );
    assert.deepEqual(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "required",
        targetKind: "work",
        targetId: b.workId,
        actor: "user",
        now: now(),
      }),
      { outcome: "invalid", code: "role_target_mismatch" },
    );
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "coordination",
        targetKind: "work",
        targetId: a.workId,
        actor: "user",
        now: now(),
      }).outcome,
      "target_not_found",
    );
    assert.deepEqual(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "output_dependency",
        targetKind: "task_output",
        targetId: a.task.id,
        taskPlanVersion: 1,
        outputRef: "o1",
        actor: "user",
        now: now(),
      }),
      { outcome: "invalid", code: "own_task" },
    );
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "output_dependency",
        targetKind: "task_output",
        targetId: b.task.id,
        taskPlanVersion: 1,
        outputRef: "o1",
        actor: "user",
        now: now(),
      }).outcome,
      "linked",
    );
    assert.equal(
      k.workLinkAdd({
        principal: A,
        workId: a.workId,
        role: "reference",
        targetKind: "commitment",
        targetId: "cm_1",
        actor: "user",
        now: now(),
      }).outcome,
      "target_not_found",
    );
    assert.equal(
      k.workLinkAdd({
        principal: B,
        workId: a.workId,
        role: "coordination",
        targetKind: "work",
        targetId: b.workId,
        actor: "user",
        now: now(),
      }).outcome,
      "not_found",
    );
    const ended = k.workLinkEnd({
      principal: A,
      workId: a.workId,
      linkId: (link as { linkId: string }).linkId,
      basis: "user_unlinked",
      actor: "user",
      now: now(),
    });
    assert.equal(ended.outcome, "ended");
    assert.equal(
      k.workLinkEnd({
        principal: A,
        workId: a.workId,
        linkId: (link as { linkId: string }).linkId,
        basis: "again",
        actor: "user",
        now: now(),
      }).outcome,
      "already_ended",
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_links WHERE id = ?",
        (link as { linkId: string }).linkId,
      ),
      1,
      "ended, never deleted",
    );
  });

  it("update: new version for wording edits, revision conflict, hidden and archive are visibility only", () => {
    const w = created(makeTask({ work: spec("Original title") }));
    const rev = view(w.workId).work.revision;
    const updated = k.workUpdate({
      principal: A,
      workId: w.workId,
      patch: { title: "New title", outcomeText: "A better outcome" },
      expectedRevision: rev,
      actor: "user",
      now: now(),
    });
    assert.equal(updated.outcome, "updated");
    const v = view(w.workId);
    assert.equal(v.work.currentWorkVersion, 2);
    assert.equal(count("SELECT COUNT(*) AS c FROM work_versions WHERE work_id = ?", w.workId), 2);
    assert.equal(
      k.workUpdate({
        principal: A,
        workId: w.workId,
        patch: { title: "stale" },
        expectedRevision: rev,
        actor: "user",
        now: now(),
      }).outcome,
      "revision_conflict",
    );
    assert.equal(
      k.workUpdate({
        principal: A,
        workId: w.workId,
        patch: { title: "   " },
        actor: "user",
        now: now(),
      }).outcome,
      "invalid",
    );
    setStatus(w.task.id, "executing");
    k.workUpdate({
      principal: A,
      workId: w.workId,
      patch: { hidden: true },
      actor: "user",
      now: now(),
    });
    assert.equal(view(w.workId).state.primary, "in_progress", "hiding pauses nothing");
    assert.equal(
      k
        .workList({ principal: A, now: now(), limit: 500, offset: 0 })
        .works.some((x) => x.work.id === w.workId),
      false,
    );
    assert.equal(
      k
        .workList({ principal: A, now: now(), limit: 500, offset: 0, includeHidden: true })
        .works.some((x) => x.work.id === w.workId),
      true,
    );
    assert.equal(
      k.workUpdate({
        principal: A,
        workId: w.workId,
        patch: { title: "New title" },
        actor: "user",
        now: now(),
      }).outcome,
      "unchanged",
    );
  });

  it("list filters by state and keyword; counts add up to the number of visible live Works", () => {
    const done = created(makeTask({ work: spec("zzz-needle done") }));
    setStatus(done.task.id, "succeeded");
    k.workEvaluate({ principal: A, workId: done.workId, now: now() });
    const doneOnly = k.workList({
      principal: A,
      now: now(),
      states: ["done"],
      keyword: "zzz-needle",
      limit: 50,
      offset: 0,
    });
    assert.equal(doneOnly.total, 1);
    assert.equal(doneOnly.works[0]?.work.id, done.workId);
    assert.equal(
      k.workList({ principal: A, now: now(), keyword: "100%_literal", limit: 50, offset: 0 }).total,
      0,
      "wildcards are escaped",
    );
    const counts = k.workCounts({ principal: A, now: now(), top: 2 });
    const sum = Object.values(counts.counts).reduce((a, b) => a + b, 0);
    assert.equal(sum, counts.total);
    assert.equal(
      counts.total,
      count(
        "SELECT COUNT(*) AS c FROM works WHERE owner_id = ? AND lifecycle = 'live' AND hidden = 0",
        A.ownerId,
      ),
    );
    for (const list of Object.values(counts.top)) {
      assert.ok(list.length <= 2);
    }
  });

  it("owners are isolated", () => {
    const w = created(makeTask({ work: spec("Private") }));
    assert.equal(k.workGet({ principal: B, workId: w.workId, now: now(), eventLimit: 10 }), null);
    assert.equal(
      k.workUpdate({
        principal: B,
        workId: w.workId,
        patch: { title: "hijack" },
        actor: "user",
        now: now(),
      }).outcome,
      "not_found",
    );
    assert.equal(
      k.workControl({ principal: B, workId: w.workId, action: "pause", actor: "user", now: now() })
        .outcome,
      "not_found",
    );
    assert.equal(
      k.workDelete({ principal: B, workId: w.workId, actor: "user", now: now() }).outcome,
      "not_found",
    );
    assert.equal(k.workOfTask({ principal: B, taskId: w.task.id }), null);
    assert.equal(k.workOfTask({ principal: A, taskId: w.task.id }), w.workId);
  });

  it("soft delete: refused while Tasks are active, then hides the Work", () => {
    const w = created(makeTask({ work: spec("Delete me") }));
    const refused = k.workDelete({ principal: A, workId: w.workId, actor: "user", now: now() });
    assert.equal(refused.outcome, "has_active_tasks");
    setStatus(w.task.id, "cancelled");
    assert.equal(
      k.workDelete({ principal: A, workId: w.workId, actor: "user", now: now() }).outcome,
      "deleted",
    );
    assert.equal(k.workGet({ principal: A, workId: w.workId, now: now(), eventLimit: 10 }), null);
  });

  it("explicit user report on a Work without events is written as legacy_backfill and continues the chain", () => {
    const w = created(makeTask({ work: spec("Historic") }));
    const rec = k.workRecordOutcome({
      principal: A,
      workId: w.workId,
      reason: "I know it was finished",
      actor: "user",
      now: now(),
    });
    assert.equal(rec.outcome, "recorded");
    const v = view(w.workId);
    assert.equal(v.state.primary, "done");
    assert.equal(v.outcome?.basis, "user_report");
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_outcome_events WHERE work_id = ? AND provenance = 'legacy_backfill'",
        w.workId,
      ),
      1,
    );
    assert.equal(
      k.workRecordOutcome({
        principal: A,
        workId: w.workId,
        reason: "again",
        actor: "user",
        now: now(),
      }).outcome,
      "already_done",
    );
  });
});

describe("work backfill", () => {
  // Legacy Tasks: created without a work spec, the way every pre-Work database has them.
  const legacy = (status: string, over: Partial<CreateInput> = {}) => {
    const out = makeTask(over);
    assert.equal(out.outcome, "created");
    const id = (out as { task: { id: string } }).task.id;
    if (status !== "clarifying") {
      setStatus(id, status);
    }
    return id;
  };
  const dump = () => JSON.stringify(db.prepare("SELECT * FROM nexus_tasks ORDER BY id").all());
  const decisionsDump = () =>
    JSON.stringify(db.prepare("SELECT * FROM decisions ORDER BY id").all());

  it("dry run reports and writes nothing; the real run maps every live Task to exactly one Work", () => {
    const trivialDone = legacy("succeeded");
    const trivialFailed = legacy("failed");
    const running = legacy("executing");
    const doneWithStep = legacy("succeeded");
    db.prepare(
      "INSERT INTO nexus_task_steps (id, owner_id, task_id, seq, kind, status, title, detail_json) VALUES ('st1', ?, ?, 1, 'note', 'done', 'a note', NULL)",
    ).run(A.ownerId, doneWithStep);
    const goalTask = legacy("cancelled");
    const g = kit.mustGoal(kit.createViaGrant(A, "Backfill goal").created);
    db.prepare(
      "INSERT INTO goal_links (owner_id, id, goal_id, kind, ref_id, created_at) VALUES (?, 'GLx', ?, 'task', ?, 1)",
    ).run(A.ownerId, g.id, goalTask);
    const deleted = legacy("clarifying");
    k.softDelete({ principal: A, taskId: deleted, now: now() });

    const before = dump();
    const decisionsBefore = decisionsDump();
    const worksBefore = count("SELECT COUNT(*) AS c FROM works");
    const dry = k.workBackfill({ principal: A, dryRun: true, now: now() });
    assert.equal(dry.dryRun, true);
    assert.equal(count("SELECT COUNT(*) AS c FROM works"), worksBefore);
    assert.equal(count("SELECT COUNT(*) AS c FROM migration_snapshots"), 0);

    const withoutOwner = count(
      "SELECT COUNT(*) AS c FROM nexus_tasks t WHERE t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.task_id = t.id)",
    );
    const real = k.workBackfill({ principal: A, dryRun: false, now: now() });
    assert.equal(real.dryRun, false);
    assert.equal((real as { created: number }).created, withoutOwner);
    assert.equal((dry as { toCreate: number }).toCreate, withoutOwner);
    assert.equal(count("SELECT COUNT(*) AS c FROM works") - worksBefore, withoutOwner);

    const hiddenOf = (taskId: string) =>
      (db.prepare("SELECT hidden FROM works WHERE id = ?").get(`w_${taskId}`) as { hidden: number })
        .hidden;
    assert.equal(hiddenOf(trivialDone), 1);
    assert.equal(hiddenOf(trivialFailed), 1);
    assert.equal(hiddenOf(running), 0, "a running Task is never hidden");
    assert.equal(hiddenOf(doneWithStep), 0, "a Task with a step is never hidden");
    assert.equal(hiddenOf(goalTask), 0, "a Task with a Goal link is never hidden");
    assert.equal(
      count("SELECT COUNT(*) AS c FROM works WHERE id = ?", `w_${deleted}`),
      0,
      "deleted Tasks are not backfilled",
    );

    const w = db.prepare("SELECT * FROM works WHERE id = ?").get(`w_${trivialDone}`) as Record<
      string,
      unknown
    >;
    assert.equal(w.origin, "migrated");
    assert.equal(w.migrated_outcome, "succeeded");
    assert.equal(w.context_origin, "legacy_default");
    assert.equal(w.context_review, "pending");
    assert.equal(w.original_result_id, `r_w_${trivialDone}`);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM goal_work_links WHERE work_id = ? AND role = 'primary'",
        `w_${goalTask}`,
      ),
      1,
    );

    // Finished old Tasks are not done: no outcome event was written for any of them.
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM work_outcome_events WHERE work_id LIKE 'w\\_%' ESCAPE '\\' AND provenance = 'live' AND work_id IN (SELECT id FROM works WHERE origin = 'migrated')",
      ),
      0,
    );
    assert.notEqual(view(`w_${trivialDone}`).state.primary, "done");
    assert.equal(view(`w_${running}`).state.primary, "in_progress");

    // Nothing that already existed changed.
    assert.equal(dump(), before);
    assert.equal(decisionsDump(), decisionsBefore);
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM migration_snapshots WHERE migration_key = 'works_backfill_v1'",
      ),
      1,
    );
    assert.equal(
      count(
        "SELECT COUNT(*) AS c FROM store_flags WHERE key = 'works_backfill_v1' AND value = '1'",
      ),
      1,
    );
  });

  it("running it again creates nothing; the data status and integrity report agree", () => {
    const worksBefore = count("SELECT COUNT(*) AS c FROM works");
    const eventsBefore = count("SELECT COUNT(*) AS c FROM work_events");
    const again = k.workBackfill({ principal: A, dryRun: false, now: now() });
    assert.equal((again as { created: number }).created, 0);
    assert.equal(count("SELECT COUNT(*) AS c FROM works"), worksBefore);
    assert.equal(count("SELECT COUNT(*) AS c FROM work_events"), eventsBefore);
    const status = k.workDataStatus({ principal: A });
    assert.equal(status.backfillDone, true);
    assert.equal(
      status.tasksWithoutWork,
      count(
        "SELECT COUNT(*) AS c FROM nexus_tasks t WHERE t.owner_id = 'owner-a' AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.task_id = t.id)",
      ),
    );
    assert.equal(status.tasksWithoutWork, 0);
    assert.ok(status.migrations.includes("stage7-0001-works"));
    assert.deepEqual(k.workIntegrity({ principal: A, now: now() }), { ok: true, findings: [] });
  });

  it("integrity reports a Task that has no Work and a link whose target vanished", () => {
    const orphan = makeTask({}) as { task: { id: string } };
    const rep = k.workIntegrity({ principal: A, now: now() });
    assert.ok(
      rep.findings.some((f) => f.code === "task_without_work" && f.objectId === orphan.task.id),
    );
    k.workBackfill({ principal: A, dryRun: false, now: now() });
    const a = created(makeTask({ work: spec("Dangling A") }));
    const b = created(makeTask({ work: spec("Dangling B") }));
    k.workLinkAdd({
      principal: A,
      workId: a.workId,
      role: "coordination",
      targetKind: "work",
      targetId: b.workId,
      actor: "user",
      now: now(),
    });
    db.prepare("UPDATE works SET lifecycle = 'deleted', deleted_at = 1 WHERE id = ?").run(b.workId);
    assert.ok(
      k
        .workIntegrity({ principal: A, now: now() })
        .findings.some((f) => f.code === "link_target_missing"),
    );
  });
});
