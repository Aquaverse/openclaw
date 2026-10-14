// The combined kernel the worker exposes: Task (Stage 1) + Decision / Grant / Execution (Stage 2) + Claim / Evidence and
// Blob evidence and Purge (Stage 3).
// Method names are disjoint by construction; the type below fails to compile if they ever collide.
import type { DatabaseSync } from "node:sqlite";
import { createBlobLedger } from "./blob-ledger.js";
import { createClaimLedger } from "./claim-ledger.js";
import { createDecisionKernel, type DecisionKernelOptions } from "./decision-kernel.js";
import { createTaskKernel, type TransactionRunner } from "./kernel.js";
import { createPurgeLedger } from "./purge-ledger.js";

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
  const blobs = createBlobLedger(transaction, ledger.internals);
  const purge = createPurgeLedger(transaction, ledger.internals);
  return { ...tasks, ...decisions, ...ledger.kernel, ...blobs, ...purge };
}

export type NexusKernel = ReturnType<typeof createNexusKernel>;
type TaskKeys = keyof ReturnType<typeof createTaskKernel>;
type DecisionKeys = keyof ReturnType<typeof createDecisionKernel>;
type LedgerKeys = keyof ReturnType<typeof createClaimLedger>["kernel"];
type BlobKeys = keyof ReturnType<typeof createBlobLedger>;
type PurgeKeys = keyof ReturnType<typeof createPurgeLedger>;
type Overlap =
  | Extract<TaskKeys, DecisionKeys>
  | Extract<TaskKeys, LedgerKeys>
  | Extract<DecisionKeys, LedgerKeys>
  | Extract<BlobKeys, TaskKeys | DecisionKeys | LedgerKeys>
  | Extract<PurgeKeys, TaskKeys | DecisionKeys | LedgerKeys | BlobKeys>;
export const NO_METHOD_OVERLAP: [Overlap] extends [never] ? true : never = true;
