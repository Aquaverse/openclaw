import type { PlanBody, StartIntent } from "../schedule/types.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkLedger } from "./work-ledger.js";

// "Keep following up" from a person's page, in one step (design 9.5, PRD D.4): the Work that will carry the follow-up is chosen or
// created, the Commitment is linked to it as required, the plan is written and accepted, all in ONE transaction. Nothing is created
// before the user confirms, and when any step refuses, nothing is left behind (the transaction is rolled back): no empty Work, no
// plan that is half accepted. The carrier is resolved again inside the transaction and compared with the kind the user reviewed, so
// two screens cannot both win and a plan that appeared meanwhile is never doubled.

/** A step refused: the answer to give, after the transaction has been rolled back. */
class StartRefused extends Error {
  constructor(readonly result: { outcome: string } & Record<string, unknown>) {
    super(result.outcome);
  }
}

export type FollowStartKind = "unique" | "multi" | "none" | "replace";

export function createDelegationFollowOps(deps: {
  transaction: TransactionRunner;
  work: WorkLedger["internals"];
  createPlanInTx: (input: {
    principal: Principal;
    workId: string;
    planOwnerType: "commitment";
    planOwnerId: string;
    purpose: string;
    plan: PlanBody;
    startIntent?: StartIntent;
    createdBy: "user";
    handoffFromWorkId?: string;
    requestRef?: string;
    now: number;
  }) => { outcome: string } & Record<string, unknown>;
  confirmInTx: (input: {
    principal: Principal;
    planId: string;
    expectedPlanVersion: number;
    dispatchReady: boolean;
    now: number;
  }) => { outcome: string } & Record<string, unknown>;
  carrierInTx: (
    owner: string,
    commitmentId: string,
  ) => { outcome: string; carrier?: { kind: string } & Record<string, unknown> };
}) {
  const { transaction, work, createPlanInTx, confirmInTx, carrierInTx } = deps;
  const c = work.common;
  const { one, appendEvent } = c;

  const delegationFollowStart = (input: {
    principal: Principal;
    commitmentId: string;
    /** The kind of carrier the user reviewed; a different one now means the screen was stale. */
    expectedKind: FollowStartKind;
    /** An existing Work that is a candidate, or a title for a new one. */
    workId?: string;
    newWorkTitle?: string;
    purpose: string;
    plan: PlanBody;
    startIntent?: StartIntent;
    requestRef?: string;
    dispatchReady: boolean;
    now: number;
  }) => {
    try {
      return transaction(() => {
        const owner = input.principal.ownerId;
        const refuse = (result: { outcome: string } & Record<string, unknown>): never => {
          throw new StartRefused(result);
        };
        const requestRef = (input.requestRef ?? "").trim();
        if (requestRef !== "") {
          const same = one(
            "SELECT id, work_id, status FROM delegation_plans WHERE owner_id = ? AND request_ref = ?",
            owner,
            requestRef,
          );
          if (same) {
            // A repeated click or a retried call: the answer is the work and plan it already made.
            return {
              outcome: "exists" as const,
              planId: String(same.id),
              workId: String(same.work_id),
            };
          }
        }
        const commitment = one(
          "SELECT lifecycle, requirement_text FROM commitments WHERE owner_id = ? AND id = ?",
          owner,
          input.commitmentId,
        );
        if (!commitment) {
          return refuse({ outcome: "not_found" });
        }
        if (commitment.lifecycle !== "open" && commitment.lifecycle !== "waiting") {
          return refuse({ outcome: "commitment_closed" });
        }
        const resolved = carrierInTx(owner, input.commitmentId);
        const carrier = resolved.carrier;
        if (!carrier) {
          return refuse({ outcome: resolved.outcome });
        }
        if (carrier.kind === "active" || carrier.kind === "paused") {
          // Already followed up: only view / change / resume exist, never a second plan (D.4).
          return refuse({ outcome: "plan_exists", carrier });
        }
        if (carrier.kind !== input.expectedKind) {
          return refuse({ outcome: "carrier_changed", carrier });
        }
        const candidates: string[] =
          carrier.kind === "unique"
            ? [String(carrier.workId)]
            : carrier.kind === "multi"
              ? (carrier.candidates as { workId: string }[]).map((entry) => entry.workId)
              : [];
        let workId: string;
        let created = false;
        if (input.workId !== undefined) {
          if (!candidates.includes(input.workId)) {
            return refuse({ outcome: "work_not_candidate" });
          }
          workId = input.workId;
        } else {
          const title = (input.newWorkTitle ?? "").trim();
          if (title === "" || title.length > 300 || carrier.kind === "unique") {
            return refuse({ outcome: "invalid", code: "bad_new_work" });
          }
          workId = work.insertWork(
            owner,
            { title, requestText: String(commitment.requirement_text), origin: "user" },
            input.now,
          );
          appendEvent(owner, workId, "created", "user", { via: "follow_up" }, input.now);
          const linked = work.linkAddInTx({
            principal: input.principal,
            workId,
            role: "required",
            targetKind: "commitment",
            targetId: input.commitmentId,
            actor: "user",
            now: input.now,
          });
          if (linked.outcome !== "linked" && linked.outcome !== "exists") {
            return refuse({ outcome: "invalid", code: `link_${linked.outcome}` });
          }
          created = true;
        }
        // CD-03: following up again after the earlier carrier ended or was stopped is a handover. The new plan remembers which Work it
        // took over from; the old plan and its checks stay ended and untouched (INV-20), and the new checks start with no history.
        let handoffFromWorkId: string | undefined;
        if (carrier.kind === "replace") {
          const old = one(
            "SELECT work_id FROM delegation_plans WHERE owner_id = ? AND id = ?",
            owner,
            String(carrier.oldPlanId),
          );
          const from = old ? String(old.work_id) : "";
          if (from !== "" && from !== workId && work.requireLive(owner, from).work) {
            handoffFromWorkId = from;
          }
        }
        const draft = createPlanInTx({
          principal: input.principal,
          workId,
          planOwnerType: "commitment",
          planOwnerId: input.commitmentId,
          purpose: input.purpose,
          plan: input.plan,
          ...(input.startIntent ? { startIntent: input.startIntent } : {}),
          createdBy: "user",
          ...(handoffFromWorkId ? { handoffFromWorkId } : {}),
          ...(requestRef !== "" ? { requestRef } : {}),
          now: input.now,
        });
        if (draft.outcome !== "created") {
          return refuse(draft);
        }
        const plan = draft.plan as { id: string; planVersion: number };
        const accepted = confirmInTx({
          principal: input.principal,
          planId: plan.id,
          expectedPlanVersion: plan.planVersion,
          dispatchReady: input.dispatchReady,
          now: input.now,
        });
        if (accepted.outcome !== "accepted") {
          return refuse(accepted);
        }
        return {
          outcome: "started" as const,
          workId,
          workCreated: created,
          plan: accepted.plan,
          schedules: accepted.schedules,
        };
      });
    } catch (error) {
      if (error instanceof StartRefused) {
        return error.result;
      }
      throw error;
    }
  };

  return { delegationFollowStart };
}
