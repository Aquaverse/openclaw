// The combined kernel the worker exposes: Task (Stage 1) + Decision / Grant / Execution (Stage 2) + Claim / Evidence (Stage 3).
// Method names are disjoint by construction; the type below fails to compile if they ever collide.
import type { DatabaseSync } from "node:sqlite";
import { createClaimLedger } from "./claim-ledger.js";
import { createDecisionKernel, type DecisionKernelOptions } from "./decision-kernel.js";
import { createTaskKernel, type TransactionRunner } from "./kernel.js";

export function createNexusKernel(
  db: DatabaseSync,
  transaction: TransactionRunner,
  options: DecisionKernelOptions = {},
) {
  const ledger = createClaimLedger(db, transaction, options.newId ? { newId: options.newId } : {});
  const tasks = createTaskKernel(db, transaction, {
    checkCompletion: ledger.hooks.checkCompletionInTx,
  });
  const decisions = createDecisionKernel(db, transaction, {
    ...options,
    afterSettleInTx: ledger.hooks.recordExecutionResultInTx,
  });
  return { ...tasks, ...decisions, ...ledger.kernel };
}

export type NexusKernel = ReturnType<typeof createNexusKernel>;
type TaskKeys = keyof ReturnType<typeof createTaskKernel>;
type DecisionKeys = keyof ReturnType<typeof createDecisionKernel>;
type LedgerKeys = keyof ReturnType<typeof createClaimLedger>["kernel"];
type Overlap =
  | Extract<TaskKeys, DecisionKeys>
  | Extract<TaskKeys, LedgerKeys>
  | Extract<DecisionKeys, LedgerKeys>;
export const NO_METHOD_OVERLAP: [Overlap] extends [never] ? true : never = true;
