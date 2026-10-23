// The combined kernel the worker exposes: Task (Stage 1) + Decision / Grant / Execution (Stage 2) + Claim / Evidence and
// Blob evidence and Purge (Stage 3) + Preference and Watch (Stage 4) + personal file Vault (Stage 5).
// Method names are disjoint by construction; the type below fails to compile if they ever collide.
import type { DatabaseSync } from "node:sqlite";
import { createBlobLedger } from "./blob-ledger.js";
import { createClaimLedger } from "./claim-ledger.js";
import { createDecisionKernel, type DecisionKernelOptions } from "./decision-kernel.js";
import { createTaskKernel, type TransactionRunner } from "./kernel.js";
import { createPreferenceLedger } from "./preference-ledger.js";
import { createPurgeLedger } from "./purge-ledger.js";
import { createVaultLedger } from "./vault-ledger.js";
import { createVaultMaintenanceLedger } from "./vault-maintenance-ledger.js";
import type { VaultPurgeHooks } from "./vault-maintenance-types.js";
import { createWatchLedger } from "./watch-ledger.js";

export function createNexusKernel(
  db: DatabaseSync,
  transaction: TransactionRunner,
  options: DecisionKernelOptions & {
    /** Goal<->File detach / check hooks; registered by Goals storage presence, no-ops when absent. */
    vaultPurgeHooks?: VaultPurgeHooks;
  } = {},
) {
  const ledger = createClaimLedger(db, transaction, options.newId ? { newId: options.newId } : {});
  const tasks = createTaskKernel(db, transaction, {
    checkCompletion: ledger.hooks.checkCompletionInTx,
  });
  const preferences = createPreferenceLedger(transaction, ledger.internals);
  const decisions = createDecisionKernel(db, transaction, {
    ...options,
    afterSettleInTx: ledger.hooks.recordExecutionResultInTx,
    applyPreferenceInTx: (owner, mutationText, decisionId, now) => {
      const applied = preferences.hooks.applyStatedInTx(owner, mutationText, decisionId, now);
      return applied.ok ? { ok: true } : { ok: false, reason: applied.reason };
    },
  });
  const blobs = createBlobLedger(transaction, ledger.internals);
  const purge = createPurgeLedger(transaction, ledger.internals);
  const watches = createWatchLedger(transaction, ledger.internals);
  const vault = createVaultLedger(transaction, ledger.internals);
  const vaultMaintenance = createVaultMaintenanceLedger(
    transaction,
    ledger.internals,
    options.vaultPurgeHooks,
  );
  return {
    ...tasks,
    ...decisions,
    ...ledger.kernel,
    ...blobs,
    ...purge,
    ...preferences.kernel,
    ...watches.kernel,
    ...vault,
    ...vaultMaintenance,
  };
}

export type NexusKernel = ReturnType<typeof createNexusKernel>;
type TaskKeys = keyof ReturnType<typeof createTaskKernel>;
type DecisionKeys = keyof ReturnType<typeof createDecisionKernel>;
type LedgerKeys = keyof ReturnType<typeof createClaimLedger>["kernel"];
type BlobKeys = keyof ReturnType<typeof createBlobLedger>;
type PurgeKeys = keyof ReturnType<typeof createPurgeLedger>;
type PreferenceKeys = keyof ReturnType<typeof createPreferenceLedger>["kernel"];
type WatchKeys = keyof ReturnType<typeof createWatchLedger>["kernel"];
type VaultKeys = keyof ReturnType<typeof createVaultLedger>;
type VaultMaintenanceKeys = keyof ReturnType<typeof createVaultMaintenanceLedger>;
type Overlap =
  | Extract<TaskKeys, DecisionKeys>
  | Extract<TaskKeys, LedgerKeys>
  | Extract<DecisionKeys, LedgerKeys>
  | Extract<BlobKeys, TaskKeys | DecisionKeys | LedgerKeys>
  | Extract<PurgeKeys, TaskKeys | DecisionKeys | LedgerKeys | BlobKeys>
  | Extract<PreferenceKeys, TaskKeys | DecisionKeys | LedgerKeys | BlobKeys | PurgeKeys>
  | Extract<WatchKeys, TaskKeys | DecisionKeys | LedgerKeys | BlobKeys | PurgeKeys | PreferenceKeys>
  | Extract<
      VaultKeys,
      TaskKeys | DecisionKeys | LedgerKeys | BlobKeys | PurgeKeys | PreferenceKeys | WatchKeys
    >
  | Extract<
      VaultMaintenanceKeys,
      | TaskKeys
      | DecisionKeys
      | LedgerKeys
      | BlobKeys
      | PurgeKeys
      | PreferenceKeys
      | WatchKeys
      | VaultKeys
    >;
export const NO_METHOD_OVERLAP: [Overlap] extends [never] ? true : never = true;
