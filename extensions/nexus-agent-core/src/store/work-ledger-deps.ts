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

export type WorkOpsDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  facts: ReturnType<typeof createWorkFacts>;
  requireLive: ReturnType<typeof createRequireLive>;
  evaluateOutcomeInTx: (owner: string, workId: string, now: number) => void;
  syncGoalShadow: (owner: string, workId: string, now: number) => void;
};
