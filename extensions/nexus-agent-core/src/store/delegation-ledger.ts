import {
  PLAN_OWNER_TYPES,
  PLAN_STATUSES,
  SCHEDULE_LIMITS,
  START_INTENTS,
  type PlanBody,
  type PlanGap,
  type PlanOwnerType,
  type StartIntent,
} from "../schedule/types.js";
import { createDelegationConfirmOps } from "./delegation-confirm-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import { checkSpecs, toPlan } from "./schedule-common.js";
import type { ScheduleLedger } from "./schedule-ledger.js";
import type { Principal } from "./types.js";
import type { WorkLedger } from "./work-ledger.js";

// Delegation plan kernel (object-model design 4.5.1, 9.5, INV-10): the follow-up plan a user reviews and accepts. A plan is a
// DRAFT until accepted and a draft is never a Schedule (NX-05); accepting is one transaction (delegation-confirm-ledger.ts).
// A plan states what will be looked at and what will NOT be done; it grants no outside action. Every method is ONE synchronous
// transaction and every statement filters on owner_id.

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");
const LIST_MAX = 200;

/** Check the parts of a plan body the ledger relies on; returns the first problem code or null. */
function badBody(body: unknown, now: number): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "bad_plan";
  }
  if (JSON.stringify(body).length > SCHEDULE_LIMITS.planJson) {
    return "plan_too_large";
  }
  const b = body as PlanBody;
  if (b.schedules !== undefined && b.schedules.length > 0) {
    const checked = checkSpecs(b.schedules, now);
    if (!checked.ok) {
      return checked.code;
    }
  }
  if (b.stopConditions !== undefined) {
    if (!Array.isArray(b.stopConditions) || b.stopConditions.length > 10) {
      return "bad_stop_conditions";
    }
    for (const stop of b.stopConditions) {
      const okGoal =
        stop?.kind === "goal_event" &&
        typeof stop.goalId === "string" &&
        stop.goalId !== "" &&
        Array.isArray(stop.events) &&
        stop.events.length > 0 &&
        stop.events.every((e) => e === "completed" || e === "deleted");
      const okUntil = stop?.kind === "until" && Number.isSafeInteger(stop.at) && stop.at > 0;
      if (!okGoal && !okUntil && stop?.kind !== "commitment_resolved") {
        return "bad_stop_conditions";
      }
    }
  }
  return null;
}

function badGaps(gaps: unknown): string | null {
  if (!Array.isArray(gaps) || gaps.length > 20) {
    return "bad_gaps";
  }
  return gaps.every(
    (g: PlanGap) => typeof g?.code === "string" && g.code !== "" && g.code.length <= 100,
  )
    ? null
    : "bad_gaps";
}

export function createDelegationLedger(
  transaction: TransactionRunner,
  work: WorkLedger["internals"],
  schedules: ScheduleLedger["internals"],
) {
  const c = work.common;
  const { one, all, run, newId } = c;
  const k = schedules.common;

  const delegationPlanCreate = (input: {
    principal: Principal;
    workId: string;
    planOwnerType: PlanOwnerType;
    planOwnerId: string;
    purpose: string;
    plan?: PlanBody;
    startIntent?: StartIntent;
    gaps?: PlanGap[];
    replacesPlanId?: string;
    handoffFromWorkId?: string;
    createdBy: "user" | "agent";
    requestRef?: string;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const requestRef = clean(input.requestRef);
      if (requestRef !== "") {
        const same = one(
          "SELECT * FROM delegation_plans WHERE owner_id = ? AND request_ref = ?",
          owner,
          requestRef,
        );
        if (same) {
          // A replayed create (a double click, a retried call) answers with the plan it already made.
          return { outcome: "exists" as const, plan: toPlan(same) };
        }
      }
      if (input.createdBy !== "user" && input.createdBy !== "agent") {
        return { outcome: "invalid" as const, code: "bad_created_by" };
      }
      const purpose = clean(input.purpose);
      if (purpose.length === 0 || purpose.length > SCHEDULE_LIMITS.purpose) {
        return { outcome: "invalid" as const, code: "bad_purpose" };
      }
      if (!(PLAN_OWNER_TYPES as readonly string[]).includes(input.planOwnerType)) {
        return { outcome: "invalid" as const, code: "bad_plan_owner_type" };
      }
      const ownerId = clean(input.planOwnerId);
      if (
        ownerId === "" ||
        ownerId.length > SCHEDULE_LIMITS.ref ||
        requestRef.length > SCHEDULE_LIMITS.ref
      ) {
        return { outcome: "invalid" as const, code: "bad_plan_owner_id" };
      }
      const found = work.requireLive(owner, input.workId);
      if (found.problem || found.work.lifecycle !== "live") {
        return { outcome: "work_not_found" as const };
      }
      const carrier = found.work;
      const problem = k.ownerProblem(owner, input.planOwnerType, ownerId);
      if (problem) {
        return { outcome: problem };
      }
      if (input.planOwnerType === "personal_goal" && carrier.contextMode !== "personal") {
        return { outcome: "executive_work" as const };
      }
      const body = input.plan ?? {};
      const bad = badBody(body, input.now);
      if (bad) {
        return { outcome: "invalid" as const, code: bad };
      }
      const gaps = input.gaps ?? [];
      const badGap = badGaps(gaps);
      if (badGap) {
        return { outcome: "invalid" as const, code: badGap };
      }
      const intent = input.startIntent ?? "none";
      if (!(START_INTENTS as readonly string[]).includes(intent)) {
        return { outcome: "invalid" as const, code: "bad_start_intent" };
      }
      if (input.replacesPlanId !== undefined) {
        const old = k.plan(owner, input.replacesPlanId);
        if (
          !old ||
          old.status !== "accepted" ||
          old.planOwnerType !== input.planOwnerType ||
          old.planOwnerId !== ownerId
        ) {
          return { outcome: "invalid" as const, code: "bad_replaces" };
        }
      }
      if (
        input.handoffFromWorkId !== undefined &&
        !work.requireLive(owner, input.handoffFromWorkId).work
      ) {
        return { outcome: "invalid" as const, code: "bad_handoff" };
      }
      const id = newId("dp_");
      run(
        "INSERT INTO delegation_plans (owner_id, id, work_id, work_version, plan_owner_type, plan_owner_id, purpose, plan_version, status, plan_json, " +
          "gaps_json, start_intent, replaces_plan_id, handoff_from_work_id, request_ref, created_by, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)",
        owner,
        id,
        carrier.id,
        carrier.currentWorkVersion,
        input.planOwnerType,
        ownerId,
        purpose,
        JSON.stringify(body),
        gaps.length > 0 ? JSON.stringify(gaps) : null,
        intent,
        input.replacesPlanId ?? null,
        input.handoffFromWorkId ?? null,
        requestRef === "" ? null : requestRef,
        input.createdBy,
        input.now,
      );
      c.touch(owner, carrier.id, input.now);
      return { outcome: "created" as const, plan: k.plan(owner, id) };
    });

  const delegationPlanGet = (input: { principal: Principal; planId: string }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const plan = k.plan(owner, input.planId);
      if (!plan) {
        return { outcome: "not_found" as const };
      }
      return { outcome: "ok" as const, plan, schedules: k.schedulesOfPlan(owner, plan.id) };
    });

  const delegationPlanList = (input: {
    principal: Principal;
    planOwnerType?: PlanOwnerType;
    planOwnerId?: string;
    workId?: string;
    statuses?: string[];
    limit?: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const where = ["owner_id = ?"];
      const params: (string | number)[] = [owner];
      for (const [column, value] of [
        ["plan_owner_type", input.planOwnerType],
        ["plan_owner_id", input.planOwnerId],
        ["work_id", input.workId],
      ] as const) {
        if (value !== undefined) {
          where.push(`${column} = ?`);
          params.push(value);
        }
      }
      const statuses = (input.statuses ?? []).filter((s) =>
        (PLAN_STATUSES as readonly string[]).includes(s),
      );
      if (statuses.length > 0) {
        where.push(`status IN (${statuses.map(() => "?").join(", ")})`);
        params.push(...statuses);
      }
      const limit = Math.min(Math.max(Math.trunc(input.limit ?? 100), 1), LIST_MAX);
      const rows = all(
        `SELECT * FROM delegation_plans WHERE ${where.join(" AND ")} ORDER BY created_at DESC, id LIMIT ?`,
        ...params,
        limit,
      );
      return { plans: rows.map(toPlan) };
    });

  const delegationPlanUpdate = (input: {
    principal: Principal;
    planId: string;
    expectedPlanVersion: number;
    changes: { purpose?: string; plan?: PlanBody; startIntent?: StartIntent; gaps?: PlanGap[] };
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const plan = k.plan(owner, input.planId);
      if (!plan) {
        return { outcome: "not_found" as const };
      }
      if (plan.status !== "draft") {
        // An accepted plan is changed by replacing it (a new draft that replaces it), never edited behind the user's back.
        return { outcome: "not_draft" as const, plan };
      }
      if (input.expectedPlanVersion !== plan.planVersion) {
        return { outcome: "conflict" as const, plan };
      }
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      const { changes } = input;
      if (changes.purpose !== undefined) {
        const purpose = clean(changes.purpose);
        if (purpose.length === 0 || purpose.length > SCHEDULE_LIMITS.purpose) {
          return { outcome: "invalid" as const, code: "bad_purpose" };
        }
        sets.push("purpose = ?");
        params.push(purpose);
      }
      if (changes.plan !== undefined) {
        const bad = badBody(changes.plan, input.now);
        if (bad) {
          return { outcome: "invalid" as const, code: bad };
        }
        sets.push("plan_json = ?");
        params.push(JSON.stringify(changes.plan));
      }
      if (changes.startIntent !== undefined) {
        if (!(START_INTENTS as readonly string[]).includes(changes.startIntent)) {
          return { outcome: "invalid" as const, code: "bad_start_intent" };
        }
        sets.push("start_intent = ?");
        params.push(changes.startIntent);
      }
      if (changes.gaps !== undefined) {
        const bad = badGaps(changes.gaps);
        if (bad) {
          return { outcome: "invalid" as const, code: bad };
        }
        sets.push("gaps_json = ?");
        params.push(changes.gaps.length > 0 ? JSON.stringify(changes.gaps) : null);
      }
      if (sets.length === 0) {
        return { outcome: "unchanged" as const, plan };
      }
      run(
        `UPDATE delegation_plans SET ${sets.join(", ")}, plan_version = plan_version + 1 WHERE owner_id = ? AND id = ?`,
        ...params,
        owner,
        plan.id,
      );
      c.touch(owner, plan.workId, input.now);
      return { outcome: "updated" as const, plan: k.plan(owner, plan.id) };
    });

  /** Withdraw a draft: it never became a plan, so nothing was scheduled. */
  const delegationPlanRevoke = (input: {
    principal: Principal;
    planId: string;
    expectedPlanVersion?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const plan = k.plan(owner, input.planId);
      if (!plan) {
        return { outcome: "not_found" as const };
      }
      if (plan.status === "revoked") {
        return { outcome: "unchanged" as const, plan };
      }
      if (plan.status !== "draft") {
        return { outcome: "not_draft" as const, plan };
      }
      if (
        input.expectedPlanVersion !== undefined &&
        input.expectedPlanVersion !== plan.planVersion
      ) {
        return { outcome: "conflict" as const, plan };
      }
      run(
        "UPDATE delegation_plans SET status = 'revoked' WHERE owner_id = ? AND id = ?",
        owner,
        plan.id,
      );
      c.touch(owner, plan.workId, input.now);
      return { outcome: "revoked" as const, plan: k.plan(owner, plan.id) };
    });

  /** End an accepted plan and cancel the schedules it bound. The bounded wrap-up of design 6.4 (CD-04) is slice W4d. */
  const delegationPlanEnd = (input: {
    principal: Principal;
    planId: string;
    reason: string;
    expectedPlanVersion?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const plan = k.plan(owner, input.planId);
      if (!plan) {
        return { outcome: "not_found" as const };
      }
      if (plan.status === "ended") {
        return { outcome: "unchanged" as const, plan };
      }
      if (plan.status !== "accepted") {
        return { outcome: "not_accepted" as const, plan };
      }
      if (
        input.expectedPlanVersion !== undefined &&
        input.expectedPlanVersion !== plan.planVersion
      ) {
        return { outcome: "conflict" as const, plan };
      }
      const reason = clean(input.reason).slice(0, 100) || "user_ended";
      run(
        "UPDATE delegation_plans SET status = 'ended', ended_at = ?, end_reason = ?, end_requested_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        reason,
        input.now,
        owner,
        plan.id,
      );
      const ended = schedules.finishPlanSchedulesInTx(
        owner,
        plan.id,
        "cancelled",
        "plan_ended",
        input.now,
      );
      c.touch(owner, plan.workId, input.now);
      return {
        outcome: "ended" as const,
        plan: k.plan(owner, plan.id),
        cancelledScheduleIds: ended,
      };
    });

  const confirmOps = createDelegationConfirmOps({ transaction, work, schedules });

  return {
    delegationPlanCreate,
    delegationPlanGet,
    delegationPlanList,
    delegationPlanUpdate,
    delegationPlanRevoke,
    delegationPlanEnd,
    ...confirmOps,
  };
}
