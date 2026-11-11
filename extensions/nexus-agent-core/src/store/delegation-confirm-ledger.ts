import type { TransactionRunner } from "./kernel.js";
import { checkSpecs, toPlan } from "./schedule-common.js";
import type { ScheduleLedger } from "./schedule-ledger.js";
import type { Principal } from "./types.js";
import type { WorkLedger } from "./work-ledger.js";

// Accepting a follow-up plan, and finding the Work that carries a Commitment's follow-up (object-model design 4.5.1, 9.5).
// The accept transaction does every check BEFORE it writes anything, then in one go: marks the plan accepted, saves its
// schedules, writes the carrier Work's reference to the Commitment or Goal, ends a plan it replaces and keeps the receipt. A
// second click answers with the receipt that exists. One Commitment has at most one accepted plan: a new one replaces the current
// one only with the current plan's id AND version (compare-and-set), so two screens cannot both win.

export function createDelegationConfirmOps(deps: {
  transaction: TransactionRunner;
  work: WorkLedger["internals"];
  schedules: ScheduleLedger["internals"];
}) {
  const { transaction, work, schedules } = deps;
  const c = work.common;
  const { one, all, run, appendEvent, touch } = c;
  const k = schedules.common;

  const delegationPlanConfirm = (input: {
    principal: Principal;
    planId: string;
    expectedPlanVersion: number;
    /** The plan this one replaces, with the version the user saw. Required when the owner already has an accepted plan. */
    replaces?: { planId: string; planVersion: number };
    /** Whether a dispatcher can start check Tasks right now (design 4.5.3); without one the new schedules are saved blocked. */
    dispatchReady?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const plan = k.plan(owner, input.planId);
      if (!plan) {
        return { outcome: "not_found" as const };
      }
      if (plan.status === "accepted") {
        const row = one(
          "SELECT confirm_receipt_json FROM delegation_plans WHERE owner_id = ? AND id = ?",
          owner,
          plan.id,
        );
        let receipt: unknown;
        try {
          receipt = JSON.parse(String(row?.confirm_receipt_json ?? "null"));
        } catch {
          receipt = null;
        }
        // A repeated click: the answer is the receipt of the first one, and nothing is written twice.
        return {
          outcome: "already_accepted" as const,
          plan,
          schedules: k.schedulesOfPlan(owner, plan.id),
          receipt,
        };
      }
      if (plan.status !== "draft") {
        return { outcome: "not_draft" as const, plan };
      }
      if (input.expectedPlanVersion !== plan.planVersion) {
        return { outcome: "conflict" as const, plan };
      }
      if (plan.gaps.length > 0) {
        return { outcome: "gaps" as const, gaps: plan.gaps, plan };
      }
      const found = work.requireLive(owner, plan.workId);
      if (found.problem || found.work.lifecycle !== "live") {
        return { outcome: "work_not_found" as const };
      }
      const carrier = found.work;
      if (carrier.currentWorkVersion !== plan.workVersion) {
        // The Work's context follows its version: a plan reviewed against an older version is reviewed again (design 4.5.1).
        return { outcome: "work_changed" as const, workVersion: carrier.currentWorkVersion };
      }
      const problem = k.ownerProblem(owner, plan.planOwnerType, plan.planOwnerId);
      if (problem) {
        return { outcome: problem };
      }
      if (plan.planOwnerType === "personal_goal" && carrier.contextMode !== "personal") {
        return { outcome: "executive_work" as const };
      }
      const specs = plan.plan.schedules ?? [];
      const checked = checkSpecs(specs, input.now);
      if (!checked.ok) {
        return { outcome: "invalid" as const, code: checked.code };
      }
      // The current accepted plan of the owner decides whether this one may be accepted, and replaces it only by compare-and-set.
      const current = one(
        "SELECT id, plan_version FROM delegation_plans WHERE owner_id = ? AND plan_owner_type = ? AND plan_owner_id = ? AND status = 'accepted'",
        owner,
        plan.planOwnerType,
        plan.planOwnerId,
      );
      let replaced: string | null = null;
      if (plan.planOwnerType === "commitment" || input.replaces !== undefined) {
        if (current && !input.replaces) {
          return {
            outcome: "plan_exists" as const,
            currentPlanId: String(current.id),
            currentPlanVersion: Number(current.plan_version),
          };
        }
        if (input.replaces) {
          if (
            !current ||
            String(current.id) !== input.replaces.planId ||
            Number(current.plan_version) !== input.replaces.planVersion
          ) {
            return {
              outcome: "current_changed" as const,
              currentPlanId: current ? String(current.id) : null,
              currentPlanVersion: current ? Number(current.plan_version) : null,
            };
          }
          replaced = String(current.id);
        }
      }
      let responsibilityVersion: number | null = null;
      let contractVersion: number | null = null;
      if (plan.planOwnerType === "commitment") {
        const row = one(
          "SELECT responsibility_version, contract_version FROM commitments WHERE owner_id = ? AND id = ?",
          owner,
          plan.planOwnerId,
        ) as Record<string, unknown>;
        responsibilityVersion = Number(row.responsibility_version);
        contractVersion = Number(row.contract_version);
      }

      // ---- every check passed: the writes follow, all in this transaction ----
      if (replaced) {
        run(
          "UPDATE delegation_plans SET status = 'ended', ended_at = ?, end_reason = 'replaced', end_requested_at = ? WHERE owner_id = ? AND id = ?",
          input.now,
          input.now,
          owner,
          replaced,
        );
        schedules.finishPlanSchedulesInTx(owner, replaced, "cancelled", "plan_replaced", input.now);
      }
      run(
        "UPDATE delegation_plans SET status = 'accepted', accepted_at = ?, accepted_responsibility_version = ?, accepted_contract_version = ?, " +
          "replaces_plan_id = COALESCE(?, replaces_plan_id) WHERE owner_id = ? AND id = ?",
        input.now,
        responsibilityVersion,
        contractVersion,
        replaced,
        owner,
        plan.id,
      );
      const accepted = k.plan(owner, plan.id) as NonNullable<ReturnType<typeof k.plan>>;
      const scheduleIds = specs.map((spec, index) =>
        schedules.insertScheduleInTx({
          owner,
          plan: accepted,
          spec,
          cadence: checked.cadences[index]!,
          dispatchReady: input.dispatchReady === true,
          startNow: accepted.startIntent === "now",
          now: input.now,
        }),
      );
      let carrierLink: "existing" | "added" = "existing";
      if (!k.carrierLinked(owner, plan.planOwnerType, plan.planOwnerId, plan.workId)) {
        carrierLink = "added";
        if (plan.planOwnerType === "commitment") {
          const linked = work.linkAddInTx({
            principal: input.principal,
            workId: plan.workId,
            role: "reference",
            targetKind: "commitment",
            targetId: plan.planOwnerId,
            actor: "user",
            now: input.now,
          });
          if (linked.outcome !== "linked" && linked.outcome !== "exists") {
            throw new Error(`delegation confirm: carrier link failed (${linked.outcome})`);
          }
        } else if (plan.planOwnerType === "personal_goal") {
          run(
            "INSERT INTO goal_work_links (owner_id, id, goal_id, work_id, role, work_version, created_at) VALUES (?, ?, ?, ?, 'reference', ?, ?)",
            owner,
            c.newId("gw_"),
            plan.planOwnerId,
            plan.workId,
            carrier.currentWorkVersion,
            input.now,
          );
          appendEvent(
            owner,
            plan.workId,
            "goal_set",
            "user",
            { goalId: plan.planOwnerId, role: "reference", via: "delegation_plan" },
            input.now,
          );
          work.syncGoalShadow(owner, plan.workId, input.now);
        }
      }
      const blockedForHost = scheduleIds.filter(
        (id) => (k.schedule(owner, id) as { status: string }).status === "blocked",
      );
      const receipt = {
        planId: plan.id,
        planVersion: plan.planVersion,
        scheduleIds,
        carrierLink,
        replacedPlanId: replaced,
        blockedScheduleIds: blockedForHost,
        acceptedAt: input.now,
      };
      run(
        "UPDATE delegation_plans SET confirm_receipt_json = ? WHERE owner_id = ? AND id = ?",
        JSON.stringify(receipt),
        owner,
        plan.id,
      );
      touch(owner, plan.workId, input.now);
      return {
        outcome: "accepted" as const,
        plan: k.plan(owner, plan.id) as NonNullable<ReturnType<typeof k.plan>>,
        schedules: k.schedulesOfPlan(owner, plan.id),
        receipt,
      };
    });

  /**
   * Which Work carries the follow-up of a Commitment (design 9.5, PRD D.4): the Work of the current plan, the one Work that
   * requires it, a choice among several, none, or a replacement after an ended plan. Reads only; nothing is created.
   */
  const delegationCarrier = (input: { principal: Principal; commitmentId: string }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (
        !one(
          "SELECT 1 AS found FROM commitments WHERE owner_id = ? AND id = ?",
          owner,
          input.commitmentId,
        )
      ) {
        return { outcome: "not_found" as const };
      }
      const current = one(
        "SELECT * FROM delegation_plans WHERE owner_id = ? AND plan_owner_type = 'commitment' AND plan_owner_id = ? AND status = 'accepted'",
        owner,
        input.commitmentId,
      );
      if (current) {
        const plan = toPlan(current);
        const live = k
          .schedulesOfPlan(owner, plan.id)
          .filter((s) => !["ended", "cancelled"].includes(s.status));
        const paused = live.length > 0 && live.every((s) => s.status === "paused");
        return {
          outcome: "ok" as const,
          carrier: {
            kind: paused ? ("paused" as const) : ("active" as const),
            workId: plan.workId,
            planId: plan.id,
            planVersion: plan.planVersion,
          },
        };
      }
      // Only a Work that REQUIRES the Commitment can carry its follow-up; one that merely cites it can only use the result.
      const candidates = all(
        "SELECT w.id, w.title FROM work_links l JOIN works w ON w.owner_id = l.owner_id AND w.id = l.work_id " +
          "WHERE l.owner_id = ? AND l.target_kind = 'commitment' AND l.target_id = ? AND l.role = 'required' AND l.ended_at IS NULL " +
          "AND w.lifecycle = 'live' AND NOT EXISTS (SELECT 1 FROM work_terminal_events t WHERE t.owner_id = w.owner_id AND t.work_id = w.id AND t.reopened_at IS NULL) " +
          "ORDER BY w.created_at, w.id",
        owner,
        input.commitmentId,
      ).map((row) => ({ workId: String(row.id), title: String(row.title) }));
      if (candidates.length === 1) {
        return {
          outcome: "ok" as const,
          carrier: { kind: "unique" as const, workId: candidates[0]!.workId },
        };
      }
      if (candidates.length > 1) {
        return { outcome: "ok" as const, carrier: { kind: "multi" as const, candidates } };
      }
      const old = one(
        "SELECT id FROM delegation_plans WHERE owner_id = ? AND plan_owner_type = 'commitment' AND plan_owner_id = ? AND status = 'ended' ORDER BY ended_at DESC, id LIMIT 1",
        owner,
        input.commitmentId,
      );
      return {
        outcome: "ok" as const,
        carrier: old
          ? { kind: "replace" as const, oldPlanId: String(old.id) }
          : { kind: "none" as const },
      };
    });

  return { delegationPlanConfirm, delegationCarrier };
}
