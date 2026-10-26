// Lazy owner of the Task store worker. Tools, RPC handlers and the prompt hook share one host; the service
// closes it on stop and the next call reopens it (reload, replacement and one-shot CLI runs all work).
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { openSqliteWorkerStore, type SqliteWorkerStore } from "openclaw/plugin-sdk/sqlite-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import type { StoreOperationName, StoreOperations } from "./contract.js";

export type TaskStore = {
  [K in StoreOperationName]: (
    input: StoreOperations[K]["input"],
  ) => Promise<Awaited<StoreOperations[K]["output"]>>;
};

// Exhaustive on purpose: adding a kernel method without listing it here is a compile error.
const STORE_OPERATIONS: Record<StoreOperationName, true> = {
  info: true,
  lookupByKey: true,
  create: true,
  findSimilar: true,
  get: true,
  list: true,
  queryTasks: true,
  update: true,
  note: true,
  abort: true,
  softDelete: true,
  listOpen: true,
  search: true,
  registerAction: true,
  getAction: true,
  createDecision: true,
  getDecision: true,
  listDecisions: true,
  findDecisionForToolCall: true,
  resolveDecision: true,
  claimCoreApproval: true,
  recordApprovalResolution: true,
  expireDueDecisions: true,
  recordRunTrigger: true,
  readRunTrigger: true,
  purgeRunTriggers: true,
  authorizeAction: true,
  admitExecution: true,
  settleExecution: true,
  getExecution: true,
  listExecutions: true,
  listReadyExecutions: true,
  listGrants: true,
  revokeGrant: true,
  claimOutbox: true,
  finishOutbox: true,
  recoverOutbox: true,
  reconcileOnStart: true,
  addClaim: true,
  addEvidence: true,
  retractClaim: true,
  unlinkEvidence: true,
  getClaim: true,
  listClaims: true,
  verifyChain: true,
  checkCompletion: true,
  registerIncarnation: true,
  closeIncarnation: true,
  blobPrecheck: true,
  blobPlan: true,
  blobAdmit: true,
  blobGcClaim: true,
  blobGcSettle: true,
  blobTombstones: true,
  blobTombstoneChecked: true,
  blobStats: true,
  listBlobObjects: true,
  listEvidence: true,
  evidenceReadRef: true,
  purgeBegin: true,
  purgeClaimReservations: true,
  purgeAdvanceReservations: true,
  purgeSealWorkset: true,
  purgeClassify: true,
  purgeFinalize: true,
  purgeStatus: true,
  purgeRelease: true,
  listPurgeRuns: true,
  listPurgeReceipts: true,
  evidenceDelete: true,
  blobIncarnationSettle: true,
  preferenceAgentSet: true,
  preferenceOperatorSet: true,
  preferenceGet: true,
  preferenceList: true,
  preferenceHistory: true,
  preferenceDelete: true,
  preferencePurge: true,
  listPreferenceReceipts: true,
  watchCreate: true,
  watchGet: true,
  watchList: true,
  watchCancel: true,
  watchListUnscheduled: true,
  watchMarkScheduled: true,
  watchClaim: true,
  watchReport: true,
  watchJobFinished: true,
  watchMaintain: true,
  vaultReserve: true,
  vaultMarkWritten: true,
  vaultFailReservation: true,
  vaultPlanPromote: true,
  vaultMarkPromoted: true,
  vaultCommit: true,
  vaultGet: true,
  vaultList: true,
  vaultStats: true,
  vaultFindByHash: true,
  vaultReadRef: true,
  vaultVersions: true,
  vaultRestoreVersion: true,
  vaultLinks: true,
  vaultKeep: true,
  vaultDiscard: true,
  vaultTrash: true,
  vaultRestore: true,
  vaultRename: true,
  vaultMove: true,
  vaultSetSensitivity: true,
  vaultPin: true,
  vaultListRecoverable: true,
  vaultRecoverCheck: true,
  vaultReservationExpire: true,
  vaultRepairPromoted: true,
  vaultReclaimCandidates: true,
  vaultReclaimClaim: true,
  vaultReclaimPurgeData: true,
  vaultReclaimSettle: true,
  vaultAbsenceProof: true,
  vaultRetireTombstones: true,
  vaultPruneReservations: true,
  vaultListDue: true,
  vaultVerifyBatch: true,
  vaultMarkDamaged: true,
  vaultPurgeBegin: true,
  vaultPurgeRecordItems: true,
  vaultPurgeItems: true,
  vaultPurgeEvaluateItem: true,
  vaultPurgeFinish: true,
  vaultPurgeRelease: true,
  vaultPurgeStatus: true,
  vaultPurgeReceipts: true,
  vaultPurgeListRuns: true,
  vaultCompactReceipts: true,
  vaultJobSweep: true,
  vaultJobClaim: true,
  vaultJobComplete: true,
  vaultJobFail: true,
  vaultJobRetry: true,
  vaultJobList: true,
  vaultExtractionStatus: true,
  vaultTextRead: true,
  vaultTextSearch: true,
  vaultTextStats: true,
};

export type StoreHost = {
  store: TaskStore;
  /** Open (or reopen) the worker and run migrations now, so failures surface at service start. */
  ready(): Promise<void>;
  close(): Promise<void>;
};

export function resolveNexusDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "plugins", "nexus-agent-core", "nexus.sqlite");
}

export function resolveStoreWorkerUrl(runtimeSource: string | undefined): URL | undefined {
  if (!runtimeSource) {
    return undefined;
  }
  return new URL(
    `./src/store/sqlite-store.worker${path.extname(runtimeSource)}`,
    pathToFileURL(runtimeSource),
  );
}

export function createStoreHost(options: { workerUrl: URL; databasePath: string }): StoreHost {
  let opened: Promise<SqliteWorkerStore<StoreOperations>> | undefined;
  const open = () => {
    opened ??= (async () => {
      fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
      return await openSqliteWorkerStore<StoreOperations>({
        moduleUrl: options.workerUrl,
        databasePath: options.databasePath,
        input: undefined,
      });
    })().catch((error: unknown) => {
      opened = undefined;
      throw error;
    });
    return opened;
  };
  const call = async <K extends StoreOperationName>(type: K, input: StoreOperations[K]["input"]) =>
    (await (await open()).execute({ type, input })) as Awaited<StoreOperations[K]["output"]>;
  const store = Object.fromEntries(
    (Object.keys(STORE_OPERATIONS) as StoreOperationName[]).map((name) => [
      name,
      (input: never) => call(name, input),
    ]),
  ) as TaskStore;
  return {
    store,
    async ready() {
      await open();
    },
    async close() {
      const current = opened;
      opened = undefined;
      if (current) {
        await (await current.catch(() => undefined))?.close();
      }
    },
  };
}
