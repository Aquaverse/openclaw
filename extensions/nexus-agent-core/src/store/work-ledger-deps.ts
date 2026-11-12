// Shared wiring for the Work ledger's operation modules (work-goal-ledger, work-link-ledger, work-control-ledger). They are split
// out of work-ledger.ts only to keep each file readable; they run in the same worker, in the same transaction runner.
import type { TransactionRunner } from "./kernel.js";
import type { createWorkFacts } from "./work-facts.js";
import { toWork, type WorkCommon } from "./work-ledger-common.js";

/** SQL list of the Task statuses that count as finished (used in `status NOT IN ${TERMINAL_TASK}`). */
export const TERMINAL_TASK = "('succeeded','failed','cancelled')";

/** Load a Work that is still usable (not deleted or being purged); `{ problem: "not_found" }` otherwise. */
export function createRequireLive(c: Pick<WorkCommon, "workRow">) {
  return (owner: string, workId: string) => {
    const row = c.workRow(owner, workId);
    if (!row) {
      return { problem: "not_found" as const };
    }
    const work = toWork(row);
    if (work.lifecycle === "deleted" || work.lifecycle === "purging") {
      return { problem: "not_found" as const };
    }
    return { work };
  };
}

/** One live schedule as a preview line (design 10.4: every control shows what it will touch before it is confirmed). */
export type FollowUpLine = {
  id: string;
  purpose: string;
  status: string;
  pauseSource: string | null;
};

/**
 * What a Work-level control does to the Work's follow-up (design 6.6, WK-04). The schedule ledger fills these in after both
 * ledgers exist; each one runs INSIDE the caller's transaction, so the control and its effect on the schedules commit together.
 */
export type FollowUpHooks = {
  liveOfWork: (owner: string, workId: string) => FollowUpLine[];
  /** Pause every active schedule of the Work (pause_source work_control). Returns the ids it paused. */
  pauseInTx: (owner: string, workId: string, now: number) => string[];
  /** Resume the schedules the Work control paused; never one the user paused. */
  resumeInTx: (
    owner: string,
    workId: string,
    dispatchReady: boolean,
    now: number,
  ) => { resumed: string[]; ended: string[]; waiting: string[] };
  /** End every live schedule and the accepted plans of a Work that has just ended. */
  endInTx: (
    owner: string,
    workId: string,
    reason: string,
    now: number,
  ) => { schedules: string[]; plans: string[] };
  /**
   * A commitment ended (resolved or cancelled): register the bounded wrap-up of the accepted plans it owns (design 6.4, CD-04).
   * Nothing new is dispatched; checks already running may finish; a plan with none running ends at once.
   */
  wrapUpInTx: (
    owner: string,
    commitmentId: string,
    reason: "commitment_resolved" | "commitment_cancelled",
    now: number,
  ) => { plans: string[]; ended: string[] };
  /** The accepted plans a commitment owns, for the preview of closing it. */
  plansOfCommitment: (owner: string, commitmentId: string) => { planId: string; purpose: string }[];
  /** Stop the follow-up the user selected: cancel one schedule, and end its plan when it was the last live one. */
  stopOneInTx: (
    owner: string,
    workId: string,
    scheduleId: string,
    now: number,
  ) => { outcome: "stopped"; planEnded: boolean } | { outcome: "not_found" | "already_final" };
};
/** A late-bound slot: the Work ledger is built before the schedule ledger, so the hooks are set afterwards. */
export type FollowUpSlot = { hooks: FollowUpHooks | null };

export type WorkOpsDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  facts: ReturnType<typeof createWorkFacts>;
  requireLive: ReturnType<typeof createRequireLive>;
  evaluateOutcomeInTx: (owner: string, workId: string, now: number) => void;
  syncGoalShadow: (owner: string, workId: string, now: number) => void;
  followUp: FollowUpSlot;
};
