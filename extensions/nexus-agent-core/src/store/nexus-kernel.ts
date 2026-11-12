// The combined kernel the worker exposes: Task (Stage 1) + Decision / Grant / Execution (Stage 2) + Claim / Evidence and
// Blob evidence and Purge (Stage 3) + Preference and Watch (Stage 4) + personal file Vault (Stage 5, text extraction included) +
// Goals (Stage 6), then the Stage 7 Work / Commitment / Counterpart / Schedule layers.
// Method names are disjoint by construction; the type below fails to compile if they ever collide.
import type { DatabaseSync } from "node:sqlite";
import { createBlobLedger } from "./blob-ledger.js";
import { createClaimLedger } from "./claim-ledger.js";
import { createCommitmentLedger } from "./commitment-ledger.js";
import { createCounterpartLedger } from "./counterpart-ledger.js";
import { createDecisionKernel, type DecisionKernelOptions } from "./decision-kernel.js";
import { createDelegationLedger } from "./delegation-ledger.js";
import { createGoalBriefingOps } from "./goal-briefing-ledger.js";
import { createGoalLedger } from "./goal-ledger.js";
import { createGoalLifecycleLedger } from "./goal-lifecycle-ledger.js";
import { createTaskKernel, type TransactionRunner } from "./kernel.js";
import { createPreferenceLedger } from "./preference-ledger.js";
import { createPurgeLedger } from "./purge-ledger.js";
import { createScheduleLedger } from "./schedule-ledger.js";
import { createVaultLedger } from "./vault-ledger.js";
import { createVaultMaintenanceLedger } from "./vault-maintenance-ledger.js";
import type { VaultPurgeHooks } from "./vault-maintenance-types.js";
import { createVaultTextLedger } from "./vault-text-ledger.js";
import { createWatchLedger } from "./watch-ledger.js";
import { createWorkBackfill } from "./work-backfill-ledger.js";
import { createWorkLedger } from "./work-ledger.js";

export function createNexusKernel(
  db: DatabaseSync,
  transaction: TransactionRunner,
  options: DecisionKernelOptions & {
    /** Overrides the Goal<->File detach / check hooks (tests only); by default the Goals kernel's own hooks, always registered. */
    vaultPurgeHooks?: VaultPurgeHooks;
  } = {},
) {
  const ledger = createClaimLedger(db, transaction, options.newId ? { newId: options.newId } : {});
  const work = createWorkLedger(transaction, ledger.internals);
  const { hooks: workHooks, internals: _workInternals, ...workKernel } = work;
  const workBackfill = createWorkBackfill(work);
  const commitments = createCommitmentLedger(transaction, work.internals);
  const counterparts = createCounterpartLedger(transaction, work.internals);
  const schedules = createScheduleLedger(transaction, work.internals.common);
  work.internals.followUp.hooks = schedules.followUpHooks;
  const delegations = createDelegationLedger(transaction, work.internals, schedules.internals);
  const briefings = createGoalBriefingOps({ transaction, c: work.internals.common });
  const tasks = createTaskKernel(db, transaction, {
    checkCompletion: ledger.hooks.checkCompletionInTx,
    validateWorkInTx: workHooks.validateWorkInTx,
    attachTaskInTx: workHooks.attachTaskInTx,
    afterTaskSucceededInTx: workHooks.afterTaskSucceededInTx,
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
  const goals = createGoalLedger(transaction, ledger.internals);
  const goalLifecycle = createGoalLifecycleLedger(transaction, ledger.internals);
  const vaultMaintenance = createVaultMaintenanceLedger(
    transaction,
    ledger.internals,
    options.vaultPurgeHooks ?? goalLifecycle.hooks,
  );
  const vaultText = createVaultTextLedger(db, transaction, ledger.internals);
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
    ...vaultText,
    ...goals,
    ...goalLifecycle.kernel,
    ...workKernel,
    ...workBackfill,
    ...commitments,
    ...counterparts,
    ...schedules.kernel,
    ...delegations,
    ...briefings,
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
type VaultTextKeys = keyof ReturnType<typeof createVaultTextLedger>;
type GoalKeys = keyof ReturnType<typeof createGoalLedger>;
type GoalLifecycleKeys = keyof ReturnType<typeof createGoalLifecycleLedger>["kernel"];
type WorkKeys = Exclude<keyof ReturnType<typeof createWorkLedger>, "hooks" | "internals">;
type WorkBackfillKeys = keyof ReturnType<typeof createWorkBackfill>;
type CommitmentKeys = keyof ReturnType<typeof createCommitmentLedger>;
type CounterpartKeys = keyof ReturnType<typeof createCounterpartLedger>;
type ScheduleKeys = keyof ReturnType<typeof createScheduleLedger>["kernel"];
type DelegationKeys = keyof ReturnType<typeof createDelegationLedger>;
type BriefingKeys = keyof ReturnType<typeof createGoalBriefingOps>;
/** Method names that appear in more than one kernel part (a union of the repeats; `never` when every name is unique). */
type Dup<K extends readonly unknown[], Seen = never> = K extends readonly [infer H, ...infer R]
  ? Extract<H, Seen> | Dup<R, Seen | H>
  : never;
type Overlap = Dup<
  [
    TaskKeys,
    DecisionKeys,
    LedgerKeys,
    BlobKeys,
    PurgeKeys,
    PreferenceKeys,
    WatchKeys,
    VaultKeys,
    VaultMaintenanceKeys,
    VaultTextKeys,
    GoalKeys,
    GoalLifecycleKeys,
    WorkKeys,
    WorkBackfillKeys,
    CommitmentKeys,
    CounterpartKeys,
    ScheduleKeys,
    DelegationKeys,
    BriefingKeys,
  ]
>;
export const NO_METHOD_OVERLAP: [Overlap] extends [never] ? true : never = true;
