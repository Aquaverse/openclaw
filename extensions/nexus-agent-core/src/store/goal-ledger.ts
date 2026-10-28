// Goals kernel (Goals design sections 5 and 9). Runs inside the SQLite worker; every method is ONE synchronous transaction and
// every statement filters on owner_id. The kernel is split by job (goal-ledger-common.ts, goal-create-ledger.ts,
// goal-edit-ledger.ts, goal-read-ledger.ts, goal-entry-ledger.ts, goal-metric-ledger.ts, goal-review-ledger.ts) and put together here. What holds across all of them:
//   * a goal is NOT authority and NOT evidence (design 1.3): nothing in these files touches a grant, a decision, an execution or
//     a claim row except to READ that a pointer's target exists (a test enforces that no decision / claim code reads `goals`);
//   * the Agent has exactly two ways to bring a goal into existence: `goalCreate` (only with a single-use creation grant the
//     console issued for ONE session and ONE category) and `goalPropose` (lands as `proposed`; only the console confirms);
//   * entries are append-only: a retraction sets retracted_at and never rewrites the text.
import type { ClaimLedger } from "./claim-ledger.js";
import { createGoalCreation } from "./goal-create-ledger.js";
import { createGoalEdits } from "./goal-edit-ledger.js";
import { createGoalEntries } from "./goal-entry-ledger.js";
import { createGoalCommon } from "./goal-ledger-common.js";
import { createGoalMetrics } from "./goal-metric-ledger.js";
import { createGoalReads } from "./goal-read-ledger.js";
import { createGoalReviews } from "./goal-review-ledger.js";
import type { TransactionRunner } from "./kernel.js";

export function createGoalLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const common = createGoalCommon(transaction, internals);
  return {
    ...createGoalCreation(common),
    ...createGoalEdits(common),
    ...createGoalReads(common),
    ...createGoalEntries(common),
    ...createGoalMetrics(common),
    ...createGoalReviews(common),
  };
}

export type GoalLedger = ReturnType<typeof createGoalLedger>;
