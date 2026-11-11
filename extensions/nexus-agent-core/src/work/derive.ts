// Pure derivation of a Task's PRD 8.1 phase (`taskPhase`, design 5.1) and of a Work's primary state (`deriveWorkState`, design 5.2).
// No IO: the Work ledger gathers the facts in one batch and calls these. A Work's "done" or "ended" is never computed here from
// Task states alone; it is READ from the outcome / terminal events (INV-19, INV-20). Missing or unreadable facts mean "unknown",
// never "done".
import {
  WORK_EVALUATION_VERSION,
  type NextStep,
  type Reason,
  type ReasonCode,
  type ResultAtClose,
  type TaskPhase,
  type WorkFlag,
  type WorkState,
} from "./types.js";

// ---------------------------------------------------------------------------------------------------------------------
// taskPhase()
// ---------------------------------------------------------------------------------------------------------------------

export type TaskPhaseInput = {
  /** nexus_tasks.status */
  status: string;
  /** task_ext.end_kind */
  endKind?: "partial" | null;
  /** task_ext.blocked_since: non-null means blocked (takes priority over the non-terminal mappings). */
  blockedSince?: number | null;
  /** A pending, unexpired decision exists for this Task. */
  hasPendingDecision: boolean;
  /** A work_controls pause is in force for this Task (task scope or the whole Work). */
  controlPaused: boolean;
  /** An active re-check (pending_schedule / scheduled / firing) exists. */
  hasActiveWatch: boolean;
};

export type TaskPhaseResult = {
  phase: TaskPhase;
  /** The old `watching` status: the Task runs, the observation path is a legacy watch. */
  legacyWatch: boolean;
  blockedReason?: "paused" | "approval_expired" | "blocked_reason";
};

/** Returns null for a Task that is deleted or being purged: it appears in no view. */
export function taskPhase(input: TaskPhaseInput): TaskPhaseResult | null {
  const plain = (phase: TaskPhase): TaskPhaseResult => ({ phase, legacyWatch: false });
  switch (input.status) {
    case "deleted":
    case "purging":
      return null;
    case "succeeded":
      return plain("completed");
    case "failed":
      return plain("failed");
    case "cancelled":
      return plain(input.endKind === "partial" ? "partial" : "cancelled");
    default:
      break;
  }
  if (input.blockedSince !== null && input.blockedSince !== undefined) {
    return { phase: "blocked", legacyWatch: false, blockedReason: "blocked_reason" };
  }
  switch (input.status) {
    case "draft":
      return plain("accepted");
    case "clarifying":
      return plain("waiting_input");
    case "planning":
    case "executing":
      if (input.controlPaused) {
        return { phase: "blocked", legacyWatch: false, blockedReason: "paused" };
      }
      return plain(input.status === "planning" ? "queued" : "running");
    case "awaiting_decision":
      return input.hasPendingDecision
        ? plain("waiting_approval")
        : { phase: "blocked", legacyWatch: false, blockedReason: "approval_expired" };
    case "watching":
      return { phase: "running", legacyWatch: input.hasActiveWatch };
    default:
      // An unknown status is data we do not understand: treat it as blocked, never as running or completed.
      return { phase: "blocked", legacyWatch: false, blockedReason: "blocked_reason" };
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// deriveWorkState()
// ---------------------------------------------------------------------------------------------------------------------

export type TaskFact = {
  id: string;
  phase: TaskPhase;
  /** Counts toward the Work's required branches (primary-owned Tasks, and referenced outputs marked required). */
  required: boolean;
  blockedReason?: "paused" | "approval_expired" | "blocked_reason";
  /**
   * Version-adoption state (design 4.2.11): `needs_user` = the Work was revised and the user must accept the current version on
   * the revision card; `accepted_waiting` = accepted, the successor Task is not created yet.
   */
  adoption?: "needs_user" | "accepted_waiting";
};

export type PrereqFact = {
  id: string;
  kind: string;
  actor: "user" | "system";
  /** A first-plan dispatch credential (queue ref with an unexpired lease): an in-flight first planning, not a request to anyone. */
  dispatchValid: boolean;
};

export type ControlFact = {
  id: string;
  scopeKind: "work" | "task" | "run" | "schedule";
  scopeId: string | null;
  state: "pause_requested" | "paused";
  reason: string | null;
  reconcileOnly: boolean;
};

export type OutcomeFact = { eventId: string; basis: string; provenance: string } | null;
export type TerminalFact = {
  id: string;
  resultAtClose: ResultAtClose;
  reason: string;
  /** Evidence that the window evaluation service started but has not written its result yet. */
  windowPending?: boolean;
} | null;

/** Commitment facts (slice W2) and Schedule facts (slice W4); the shapes are fixed so derive does not change with the slices. */
export type CommitmentFact = {
  id: string;
  /** A required Commitment (active link) that is no longer open: resolved or cancelled. */
  resolved: boolean;
  needsUser: boolean;
  blocked?: ReasonCode;
};
export type ScheduleFact = {
  id: string;
  status: "draft" | "active" | "paused" | "blocked" | "ended";
  coverage: "on_plan" | "degraded" | "unavailable";
  stopReason?: string;
  needsUser: boolean;
};
export type UnknownEffectFact = { id: string; affectsRequired: boolean };

export type WorkFacts = {
  work: { id: string; lifecycle: "live" | "archived" };
  /** null = unreadable: the Work can never be "done" then. */
  contract: { version: number } | null;
  outcome: OutcomeFact;
  terminal: TerminalFact;
  prerequisites: PrereqFact[];
  tasks: TaskFact[];
  commitments: CommitmentFact[];
  schedules: ScheduleFact[];
  controls: ControlFact[];
  unknownEffects: UnknownEffectFact[];
  evaluatedAt: number;
};

/** Order of the blocking causes when several hold at once (design 5.2, R-11): the first one present is the displayed cause. */
const REASON_ORDER: readonly ReasonCode[] = [
  "incident_hold",
  "effect_unknown_needs_reconcile",
  "paused_by_user",
  "permission_missing",
  "source_auth_expired",
  "browser_not_ready",
  "quota_exhausted",
  "dependency_version_pending",
  "prerequisite_missing",
  "no_follow_up",
  "no_branch",
  "task_failed",
  "unknown_input",
  "follow_up_ended",
];

const BRANCH_RUNNING: ReadonlySet<TaskPhase> = new Set<TaskPhase>([
  "running",
  "queued",
  "accepted",
]);

function byReasonOrder(a: Reason, b: Reason): number {
  return REASON_ORDER.indexOf(a.code) - REASON_ORDER.indexOf(b.code);
}

function blockedKindOf(
  reasons: Reason[],
  controls: ControlFact[],
): "paused" | "reconciling" | "blocked_reason" {
  const first = reasons[0];
  if (!first) {
    return "blocked_reason";
  }
  if (first.code === "effect_unknown_needs_reconcile") {
    return "reconciling";
  }
  if (first.code === "paused_by_user") {
    return controls.some((control) => control.reconcileOnly) ? "reconciling" : "paused";
  }
  return "blocked_reason";
}

export function deriveWorkState(facts: WorkFacts): WorkState {
  const base = (
    partial: Pick<WorkState, "primary" | "reasons" | "nextStep"> & Partial<WorkState>,
  ): WorkState => ({
    flags: [],
    evaluationVersion: WORK_EVALUATION_VERSION,
    ...partial,
  });
  const work = facts.work;

  // Unreadable contract: never claim success, never invent a cause (design 5.2 "missing data is unknown").
  if (facts.contract === null) {
    return base({
      primary: "blocked",
      blockedKind: "blocked_reason",
      reasons: [{ code: "unknown_input", objectKind: "work", objectId: work.id, actor: "system" }],
      nextStep: { kind: "none" },
    });
  }

  const required = facts.tasks.filter((task) => task.required);
  const activeSchedules = facts.schedules.filter(
    (schedule) => schedule.status === "active" && schedule.coverage !== "unavailable",
  );
  const dispatchCredential = facts.prerequisites.some((prereq) => prereq.dispatchValid);
  const openPrereqs = facts.prerequisites.filter((prereq) => !prereq.dispatchValid);
  const branchRunning =
    required.some((task) => BRANCH_RUNNING.has(task.phase)) ||
    activeSchedules.length > 0 ||
    dispatchCredential;

  const flags = new Set<WorkFlag>();
  if (
    required.some((task) => task.phase === "partial") ||
    facts.terminal?.resultAtClose === "partial"
  ) {
    flags.add("partial_result");
  }
  if (facts.unknownEffects.some((effect) => effect.affectsRequired)) {
    flags.add("unknown_effect");
  }
  // Only schedules that still stand count: an ended or cancelled one keeps its last coverage value, which says nothing about now.
  const standing = facts.schedules.filter(
    (schedule) => schedule.status !== "ended" && schedule.status !== "draft",
  );
  if (standing.length > 0) {
    const worst = standing.some((s) => s.coverage === "unavailable")
      ? "coverage_unavailable"
      : standing.some((s) => s.coverage === "degraded")
        ? "coverage_degraded"
        : "coverage_on_plan";
    flags.add(worst);
  }
  if (required.some((task) => task.adoption !== undefined)) {
    flags.add("adoption_pending");
  }
  const finish = (state: WorkState): WorkState => {
    if (state.primary !== "in_progress" && branchRunning) {
      flags.add("other_branch_running");
    }
    return { ...state, flags: [...flags].toSorted() };
  };

  // 1. done: a valid achieved / reinstated event and no applicable stopped_before_completion snapshot (INV-20).
  const stopped = facts.terminal?.resultAtClose === "stopped_before_completion";
  if (facts.outcome && !stopped) {
    return finish(base({ primary: "done", reasons: [], nextStep: { kind: "none" } }));
  }

  // 2. ended_incomplete: an effective result-level end fact, with no continuing branch left.
  if (facts.terminal && !branchRunning) {
    const waiting = facts.terminal.windowPending === true;
    if (!waiting) {
      if (facts.terminal.reason === "accept_partial") {
        flags.add("manual_close");
      }
      return finish(
        base({ primary: "ended_incomplete", reasons: [], nextStep: { kind: "review_result" } }),
      );
    }
  }

  // 2b. The agreed follow-up simply ran out (Schedule ended by agreement or expiry) while every required Task is finished and a
  //     required obligation is still open. Read from the Schedule's own end fact; no work_terminal_events row is written for it
  //     (R-04 reserves `window_ended` for the window evaluation service; the overlap is open question R-44).
  const allFinished =
    required.length > 0 &&
    required.every((task) => ["completed", "partial", "failed", "cancelled"].includes(task.phase));
  if (
    !facts.terminal &&
    !branchRunning &&
    allFinished &&
    facts.commitments.some((commitment) => !commitment.resolved) &&
    facts.schedules.some(
      (s) => s.status === "ended" && (s.stopReason === "agreed_end" || s.stopReason === "expired"),
    )
  ) {
    return finish(
      base({
        primary: "ended_incomplete",
        reasons: [
          { code: "follow_up_ended", objectKind: "work", objectId: work.id, actor: "system" },
        ],
        nextStep: { kind: "review_result" },
      }),
    );
  }

  // 3. needs_you: anything only the user can act on. User-actionable requests win over the system-side blocked class (R-34).
  const needsReasons: Reason[] = [];
  let nextStep: NextStep | undefined;
  for (const prereq of openPrereqs) {
    if (prereq.actor === "user") {
      needsReasons.push({
        code: "prerequisite_missing",
        objectKind: "prerequisite",
        objectId: prereq.id,
        actor: "user",
        ref: prereq.kind,
      });
      nextStep ??= { kind: "provide_input", objectId: prereq.id };
    }
  }
  for (const task of required) {
    if (task.phase === "waiting_input") {
      needsReasons.push({
        code: "prerequisite_missing",
        objectKind: "task",
        objectId: task.id,
        actor: "user",
        ref: "input",
      });
      nextStep ??= { kind: "provide_input", objectId: task.id };
    } else if (task.phase === "waiting_approval") {
      needsReasons.push({
        code: "prerequisite_missing",
        objectKind: "task",
        objectId: task.id,
        actor: "user",
        ref: "approval",
      });
      nextStep ??= { kind: "decide", objectKind: "task", objectId: task.id };
    } else if (task.adoption === "needs_user") {
      needsReasons.push({
        code: "dependency_version_pending",
        objectKind: "task",
        objectId: task.id,
        actor: "user",
      });
      nextStep ??= { kind: "accept_revision", objectId: work.id };
    }
  }
  for (const commitment of facts.commitments) {
    if (commitment.needsUser) {
      needsReasons.push({
        code: "prerequisite_missing",
        objectKind: "commitment",
        objectId: commitment.id,
        actor: "user",
      });
      nextStep ??= { kind: "decide", objectKind: "commitment", objectId: commitment.id };
    }
  }
  for (const schedule of facts.schedules) {
    if (schedule.needsUser) {
      needsReasons.push({
        code: "prerequisite_missing",
        objectKind: "schedule",
        objectId: schedule.id,
        actor: "user",
      });
      nextStep ??= { kind: "decide", objectKind: "schedule", objectId: schedule.id };
    }
  }
  if (needsReasons.length > 0) {
    return finish(
      base({ primary: "needs_you", reasons: needsReasons, nextStep: nextStep ?? { kind: "none" } }),
    );
  }

  // 4. blocked: a required dependency is blocked or paused, a system prerequisite is open, an effect is unknown, or an unresolved
  //    obligation has no usable execution or observation path.
  const blocked: Reason[] = [];
  for (const control of facts.controls) {
    if (
      control.scopeKind === "work" ||
      control.scopeKind === "task" ||
      control.scopeKind === "run"
    ) {
      blocked.push({
        code: control.reason === "incident_hold" ? "incident_hold" : "paused_by_user",
        objectKind: "control",
        objectId: control.id,
        actor: control.reason === "incident_hold" ? "system" : "user",
      });
    }
  }
  for (const task of required) {
    if (task.adoption === "accepted_waiting") {
      blocked.push({
        code: "dependency_version_pending",
        objectKind: "task",
        objectId: task.id,
        actor: "system",
      });
    } else if (task.phase === "blocked") {
      const paused = task.blockedReason === "paused";
      // A pause already reported through its control row is not repeated once per Task.
      if (
        !(
          paused &&
          blocked.some(
            (reason) => reason.code === "paused_by_user" || reason.code === "incident_hold",
          )
        )
      ) {
        blocked.push({
          code: paused ? "paused_by_user" : "prerequisite_missing",
          objectKind: "task",
          objectId: task.id,
          actor: paused ? "user" : "system",
          ...(task.blockedReason === "approval_expired" ? { ref: "approval_expired" } : {}),
        });
      }
    }
  }
  for (const prereq of openPrereqs) {
    if (prereq.actor === "system") {
      blocked.push({
        code:
          prereq.kind === "permission"
            ? "permission_missing"
            : prereq.kind === "source"
              ? "source_auth_expired"
              : "prerequisite_missing",
        objectKind: "prerequisite",
        objectId: prereq.id,
        actor: "system",
        ref: prereq.kind,
      });
    }
  }
  for (const effect of facts.unknownEffects) {
    if (effect.affectsRequired) {
      blocked.push({
        code: "effect_unknown_needs_reconcile",
        objectKind: "effect",
        objectId: effect.id,
        actor: "system",
      });
    }
  }
  for (const schedule of facts.schedules) {
    if (schedule.status === "paused" || schedule.status === "blocked") {
      blocked.push({
        code: schedule.status === "paused" ? "paused_by_user" : "prerequisite_missing",
        objectKind: "schedule",
        objectId: schedule.id,
        actor: schedule.status === "paused" ? "user" : "system",
      });
    }
  }
  for (const commitment of facts.commitments) {
    if (commitment.blocked) {
      blocked.push({
        code: commitment.blocked,
        objectKind: "commitment",
        objectId: commitment.id,
        actor: "system",
      });
    }
  }
  const unresolved = facts.commitments.some((commitment) => !commitment.resolved);
  if (blocked.length === 0 && unresolved && !branchRunning) {
    blocked.push({ code: "no_follow_up", objectKind: "work", objectId: work.id, actor: "user" });
  }
  if (blocked.length > 0) {
    const reasons = blocked.toSorted(byReasonOrder);
    const noFollowUp = reasons[0]?.code === "no_follow_up";
    return finish(
      base({
        primary: "blocked",
        blockedKind: blockedKindOf(reasons, facts.controls),
        reasons,
        nextStep: noFollowUp ? { kind: "schedule_follow_up" } : { kind: "none" },
      }),
    );
  }

  // The window ended but the evaluation service has not written its result yet: say "waiting for the check", do not invent an end.
  if (facts.terminal?.windowPending) {
    return finish(
      base({
        primary: "blocked",
        blockedKind: "reconciling",
        reasons: [
          {
            code: "effect_unknown_needs_reconcile",
            objectKind: "work",
            objectId: work.id,
            actor: "system",
            ref: "window_pending",
          },
        ],
        nextStep: { kind: "none" },
      }),
    );
  }

  // 5. in_progress: a branch that can advance, an active observation path, or a valid first-plan dispatch credential.
  if (branchRunning) {
    return finish(base({ primary: "in_progress", reasons: [], nextStep: { kind: "none" } }));
  }

  // 6. fallback: nothing is scheduled. A finished Task chain without an outcome says so instead of claiming progress.
  const failed = required.some((task) => task.phase === "failed");
  const reasons: Reason[] = [
    {
      code: failed ? "task_failed" : "no_branch",
      objectKind: "work",
      objectId: work.id,
      actor: "user",
    },
  ];
  return finish(
    base({
      primary: "blocked",
      blockedKind: "blocked_reason",
      reasons,
      nextStep: { kind: "schedule_follow_up" },
    }),
  );
}
