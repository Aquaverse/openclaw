// Table-driven tests for taskPhase() and deriveWorkState() (design 5.1 / 5.2 acceptance matrix, W1 subset: Task, prerequisite,
// control, outcome and terminal facts; Commitment and Schedule rows are covered with fact fixtures).
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { deriveWorkState, taskPhase, type TaskFact, type WorkFacts } from "./derive.js";

const task = (id: string, phase: TaskFact["phase"], over: Partial<TaskFact> = {}): TaskFact => ({
  id,
  phase,
  required: true,
  ...over,
});
const facts = (over: Partial<WorkFacts> = {}): WorkFacts => ({
  work: { id: "w1", lifecycle: "live" },
  contract: { version: 1 },
  outcome: null,
  terminal: null,
  prerequisites: [],
  tasks: [],
  commitments: [],
  schedules: [],
  controls: [],
  unknownEffects: [],
  evaluatedAt: 1000,
  ...over,
});
const base = { hasPendingDecision: false, controlPaused: false, hasActiveWatch: false };

describe("taskPhase", () => {
  const rows: [string, Parameters<typeof taskPhase>[0], string | null][] = [
    ["draft", { status: "draft", ...base }, "accepted"],
    ["clarifying", { status: "clarifying", ...base }, "waiting_input"],
    ["planning", { status: "planning", ...base }, "queued"],
    ["executing", { status: "executing", ...base }, "running"],
    ["executing paused", { status: "executing", ...base, controlPaused: true }, "blocked"],
    ["planning paused", { status: "planning", ...base, controlPaused: true }, "blocked"],
    [
      "awaiting with decision",
      { status: "awaiting_decision", ...base, hasPendingDecision: true },
      "waiting_approval",
    ],
    ["awaiting, decision gone", { status: "awaiting_decision", ...base }, "blocked"],
    ["watching", { status: "watching", ...base, hasActiveWatch: true }, "running"],
    ["succeeded", { status: "succeeded", ...base }, "completed"],
    ["failed", { status: "failed", ...base }, "failed"],
    ["cancelled", { status: "cancelled", ...base }, "cancelled"],
    ["cancelled partial", { status: "cancelled", endKind: "partial", ...base }, "partial"],
    ["blocked_since beats executing", { status: "executing", blockedSince: 5, ...base }, "blocked"],
    [
      "blocked_since does not touch terminal",
      { status: "succeeded", blockedSince: 5, ...base },
      "completed",
    ],
    ["deleted", { status: "deleted", ...base }, null],
    ["purging", { status: "purging", ...base }, null],
    ["unknown status is never running", { status: "mystery", ...base }, "blocked"],
  ];
  for (const [name, input, expected] of rows) {
    it(name, () => {
      assert.equal(taskPhase(input)?.phase ?? null, expected);
    });
  }
  it("marks the old watching status as a legacy watch only with an active watch", () => {
    assert.equal(
      taskPhase({ status: "watching", ...base, hasActiveWatch: true })?.legacyWatch,
      true,
    );
    assert.equal(taskPhase({ status: "watching", ...base })?.legacyWatch, false);
  });
});

describe("deriveWorkState", () => {
  const achieved = { eventId: "e1", basis: "source_verified", provenance: "live" };
  it("valid achieved event and no stop snapshot is done", () => {
    assert.equal(
      deriveWorkState(facts({ outcome: achieved, tasks: [task("t1", "completed")] })).primary,
      "done",
    );
  });
  it("all Tasks completed is NOT done without an outcome event", () => {
    const state = deriveWorkState(facts({ tasks: [task("t1", "completed")] }));
    assert.notEqual(state.primary, "done");
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "no_branch");
    assert.equal(state.nextStep.kind, "schedule_follow_up");
  });
  it("a stopped_before_completion snapshot beats a later achieved event", () => {
    const state = deriveWorkState(
      facts({
        outcome: achieved,
        terminal: { id: "x1", resultAtClose: "stopped_before_completion", reason: "stop" },
      }),
    );
    assert.equal(state.primary, "ended_incomplete");
  });
  it("one Task waiting for approval and another running: needs_you plus other_branch_running", () => {
    const state = deriveWorkState(
      facts({ tasks: [task("t1", "waiting_approval"), task("t2", "running")] }),
    );
    assert.equal(state.primary, "needs_you");
    assert.ok(state.flags.includes("other_branch_running"));
    assert.deepEqual(state.nextStep, { kind: "decide", objectKind: "task", objectId: "t1" });
  });
  it("a Work with only a pending user prerequisite and no Task is needs_you", () => {
    const state = deriveWorkState(
      facts({ prerequisites: [{ id: "p1", kind: "input", actor: "user", dispatchValid: false }] }),
    );
    assert.equal(state.primary, "needs_you");
    assert.deepEqual(state.nextStep, { kind: "provide_input", objectId: "p1" });
  });
  it("a system prerequisite is blocked, never needs_you", () => {
    const state = deriveWorkState(
      facts({
        prerequisites: [{ id: "p1", kind: "permission", actor: "system", dispatchValid: false }],
      }),
    );
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "permission_missing");
  });
  it("a work-level pause is blocked / paused", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "blocked", { blockedReason: "paused" })],
        controls: [
          {
            id: "c1",
            scopeKind: "work",
            scopeId: null,
            state: "paused",
            reason: "user",
            reconcileOnly: false,
          },
        ],
      }),
    );
    assert.equal(state.primary, "blocked");
    assert.equal(state.blockedKind, "paused");
    assert.equal(state.reasons.filter((r) => r.code === "paused_by_user").length, 1);
  });
  it("two stacked controls: releasing one leaves the Work blocked", () => {
    const control = (id: string, reason: string) => ({
      id,
      scopeKind: "work" as const,
      scopeId: null,
      state: "paused" as const,
      reason,
      reconcileOnly: false,
    });
    const both = deriveWorkState(
      facts({ controls: [control("c1", "user"), control("c2", "incident_hold")] }),
    );
    assert.equal(both.primary, "blocked");
    assert.equal(both.reasons[0]?.code, "incident_hold");
    const one = deriveWorkState(facts({ controls: [control("c1", "user")] }));
    assert.equal(one.primary, "blocked");
  });
  it("a reconcile-only pause shows as reconciling", () => {
    const state = deriveWorkState(
      facts({
        controls: [
          {
            id: "c1",
            scopeKind: "work",
            scopeId: null,
            state: "paused",
            reason: "user",
            reconcileOnly: true,
          },
        ],
      }),
    );
    assert.equal(state.blockedKind, "reconciling");
  });
  it("an unknown external effect blocks and shows the reconcile flag", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "running")],
        unknownEffects: [{ id: "u1", affectsRequired: true }],
      }),
    );
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "effect_unknown_needs_reconcile");
    assert.equal(state.blockedKind, "reconciling");
    assert.ok(state.flags.includes("unknown_effect"));
    assert.ok(state.flags.includes("other_branch_running"));
  });
  it("a running Task is in_progress", () => {
    assert.equal(deriveWorkState(facts({ tasks: [task("t1", "running")] })).primary, "in_progress");
  });
  it("a valid first-plan dispatch credential is in_progress", () => {
    const state = deriveWorkState(
      facts({ prerequisites: [{ id: "p1", kind: "input", actor: "user", dispatchValid: true }] }),
    );
    assert.equal(state.primary, "in_progress");
  });
  it("no branch, no prerequisite, no credential is blocked no_branch", () => {
    const state = deriveWorkState(facts());
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "no_branch");
  });
  it("a failed Task chain says task_failed, not progress", () => {
    const state = deriveWorkState(facts({ tasks: [task("t1", "failed")] }));
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "task_failed");
  });
  it("an unreadable contract is blocked unknown_input and never done", () => {
    const state = deriveWorkState(facts({ contract: null, outcome: achieved }));
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "unknown_input");
  });
  it("an effective terminal fact with no running branch is ended_incomplete; a running branch keeps it going", () => {
    const terminal = { id: "x1", resultAtClose: "partial" as const, reason: "accept_partial" };
    const ended = deriveWorkState(facts({ terminal, tasks: [task("t1", "partial")] }));
    assert.equal(ended.primary, "ended_incomplete");
    assert.ok(ended.flags.includes("manual_close"));
    assert.ok(ended.flags.includes("partial_result"));
    assert.equal(
      deriveWorkState(facts({ terminal, tasks: [task("t2", "running")] })).primary,
      "in_progress",
    );
  });
  it("a window past its end with no result yet shows reconciling, not ended", () => {
    const state = deriveWorkState(
      facts({
        terminal: {
          id: "x1",
          resultAtClose: "unknown",
          reason: "window_ended",
          windowPending: true,
        },
      }),
    );
    assert.equal(state.primary, "blocked");
    assert.equal(state.blockedKind, "reconciling");
  });
  it("Schedule ended by agreement with an open required commitment is ended_incomplete (follow_up_ended)", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "completed")],
        commitments: [{ id: "c1", resolved: false, needsUser: false }],
        schedules: [
          {
            id: "s1",
            status: "ended",
            coverage: "on_plan",
            stopReason: "agreed_end",
            needsUser: false,
          },
        ],
      }),
    );
    assert.equal(state.primary, "ended_incomplete");
    assert.equal(state.reasons[0]?.code, "follow_up_ended");
  });
  it("coverage flag ignores schedules that ended: a stale 'degraded' of an old one does not taint the live one", () => {
    const live = (coverage: "on_plan" | "degraded") => ({
      id: "s2",
      status: "active" as const,
      coverage,
      needsUser: false,
    });
    const old = {
      id: "s1",
      status: "ended" as const,
      coverage: "degraded" as const,
      needsUser: false,
    };
    const flagsOf = (schedules: WorkFacts["schedules"]) =>
      deriveWorkState(facts({ tasks: [task("t1", "completed")], schedules })).flags;
    assert.ok(flagsOf([old, live("on_plan")]).includes("coverage_on_plan"));
    assert.ok(!flagsOf([old, live("on_plan")]).includes("coverage_degraded"));
    assert.ok(flagsOf([old, live("degraded")]).includes("coverage_degraded"));
    assert.ok(!flagsOf([old]).some((flag) => flag.startsWith("coverage_")));
  });
  it("finished read-only Task, open commitment, nothing watching: blocked no_follow_up", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "completed")],
        commitments: [{ id: "c1", resolved: false, needsUser: false }],
      }),
    );
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "no_follow_up");
    assert.deepEqual(state.nextStep, { kind: "schedule_follow_up" });
  });
  it("a required commitment the user must look at (cancelled, manually closed, or a failed check) is needs_you with a decide step", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "completed")],
        commitments: [{ id: "c1", resolved: true, needsUser: true }],
      }),
    );
    assert.equal(state.primary, "needs_you");
    assert.deepEqual(state.nextStep, { kind: "decide", objectKind: "commitment", objectId: "c1" });
    assert.equal(state.reasons[0]?.objectKind, "commitment");
  });
  it("the same commitment after the user ended the Work with what exists: ended_incomplete, closed by hand", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "completed")],
        commitments: [{ id: "c1", resolved: true, needsUser: true }],
        terminal: { id: "te1", resultAtClose: "partial", reason: "accept_partial" },
      }),
    );
    assert.equal(state.primary, "ended_incomplete");
    assert.ok(state.flags.includes("manual_close"));
  });
  it("a Work with no Task at all and an open required commitment is blocked (no_follow_up)", () => {
    const state = deriveWorkState(
      facts({ tasks: [], commitments: [{ id: "c1", resolved: false, needsUser: false }] }),
    );
    assert.equal(state.primary, "blocked");
    assert.equal(state.reasons[0]?.code, "no_follow_up");
  });
  it("a Task waiting for the user's input wins over the commitment: needs_you, not blocked", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "waiting_input")],
        commitments: [{ id: "c1", resolved: false, needsUser: false }],
      }),
    );
    assert.equal(state.primary, "needs_you");
    assert.equal(state.nextStep.kind, "provide_input");
  });
  it("a closed commitment with nothing else left to run does not read as follow-up needed", () => {
    const state = deriveWorkState(
      facts({
        tasks: [task("t1", "completed")],
        commitments: [{ id: "c1", resolved: true, needsUser: false }],
      }),
    );
    assert.notEqual(state.reasons[0]?.code, "no_follow_up");
  });
  it("adoption pending: user must accept the revision card; accepted but no successor yet is blocked", () => {
    const needs = deriveWorkState(
      facts({ tasks: [task("t1", "running", { adoption: "needs_user" })] }),
    );
    assert.equal(needs.primary, "needs_you");
    assert.ok(needs.flags.includes("adoption_pending"));
    assert.equal(needs.nextStep.kind, "accept_revision");
    const waiting = deriveWorkState(
      facts({ tasks: [task("t1", "blocked", { adoption: "accepted_waiting" })] }),
    );
    assert.equal(waiting.primary, "blocked");
    assert.equal(waiting.reasons[0]?.code, "dependency_version_pending");
  });
  it("a non-required Task is ignored", () => {
    const state = deriveWorkState(facts({ tasks: [task("t1", "running", { required: false })] }));
    assert.equal(state.primary, "blocked");
  });
  it("archived Works derive like live ones", () => {
    const state = deriveWorkState(
      facts({ work: { id: "w1", lifecycle: "archived" }, tasks: [task("t1", "running")] }),
    );
    assert.equal(state.primary, "in_progress");
  });
  it("is invariant to the order of the same facts", () => {
    const tasks = [task("a", "running"), task("b", "waiting_input"), task("c", "completed")];
    const one = deriveWorkState(facts({ tasks }));
    const two = deriveWorkState(facts({ tasks: tasks.toReversed() }));
    assert.equal(one.primary, two.primary);
    assert.deepEqual(one.flags, two.flags);
  });
});
