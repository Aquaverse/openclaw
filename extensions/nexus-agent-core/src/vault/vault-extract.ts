import type { StoreOperationName, StoreOperations } from "../store/contract.js";
import type { Principal } from "../store/types.js";
// Background text extraction (Vault design 9.3): a small task runner over the `vault_jobs` queue. One job at a time, a bounded
// number per pass, wall-clock backoff between attempts, and a hard line around what may be extracted at all: the ledger decides
// eligibility (never sensitive, never a reclaimed object) when a job is claimed and again when its text is stored, so nothing
// in this file has to remember that rule.
import { vaultObjectKey } from "../store/vault-types.js";
import {
  BUILTIN_EXTRACTORS,
  ExtractError,
  paginateText,
  selectExtractor,
  TEXT_EXTRACTOR,
  type VaultTextExtractor,
} from "./vault-extractors.js";
import type { VaultFileStore } from "./vault-file-store.js";

type ExtractOperationName = Extract<
  StoreOperationName,
  "vaultJobSweep" | "vaultJobClaim" | "vaultJobComplete" | "vaultJobFail"
>;
export type VaultExtractStore = {
  [K in ExtractOperationName]: (
    input: StoreOperations[K]["input"],
  ) => Promise<Awaited<StoreOperations[K]["output"]>>;
};

export type VaultExtractConfig = {
  enabled: boolean;
  /** Larger objects are rejected (`too_large`) without being read. */
  maxBytes: number;
  /** Characters kept per file; the rest is dropped and the finished job says `truncated`. */
  maxChars: number;
  pageChars: number;
  maxAttempts: number;
  backoffMs: number[];
  /** Jobs handled per pass. */
  batch: number;
  /** A job stuck in `running` this long (a crashed pass) is picked up again. */
  runningTimeoutMs: number;
};

export const VAULT_EXTRACT_DEFAULTS: VaultExtractConfig = {
  enabled: true,
  maxBytes: 5 * 1024 * 1024,
  maxChars: 2_000_000,
  pageChars: 50_000,
  maxAttempts: 3,
  backoffMs: [60_000, 5 * 60_000, 30 * 60_000],
  batch: 20,
  runningTimeoutMs: 10 * 60_000,
};

export type VaultExtractReport = {
  queued: number;
  ready: number;
  rejected: number;
  retried: number;
  failed: number;
  dropped: number;
};

const emptyReport = (): VaultExtractReport => ({
  queued: 0,
  ready: 0,
  rejected: 0,
  retried: 0,
  failed: 0,
  dropped: 0,
});

export type VaultExtractDeps = {
  getStore: () => Promise<VaultExtractStore>;
  files: Pick<VaultFileStore, "stat" | "readRange">;
  config: () => VaultExtractConfig | undefined;
  now: () => number;
  warn: (message: string) => void;
  extractors?: readonly VaultTextExtractor[];
  /** Called after a pass changed what the console shows (new text, new failure). */
  onProgress?: (principal: Principal, report: VaultExtractReport) => void;
};

export function createVaultExtractor(deps: VaultExtractDeps) {
  const extractors = deps.extractors ?? BUILTIN_EXTRACTORS;
  // The queue entry is per pipeline (`text`), not per file type: which extractor handles a job is decided when it runs.
  const pipeline = { id: TEXT_EXTRACTOR.id, version: TEXT_EXTRACTOR.version };
  let active: Promise<VaultExtractReport> | undefined;

  async function handle(
    store: VaultExtractStore,
    principal: Principal,
    cfg: VaultExtractConfig,
    job: {
      jobId: string;
      objectId: string;
      size: number;
      mime: string;
      displayName: string;
    },
    report: VaultExtractReport,
  ): Promise<void> {
    const fail = async (
      code: string,
      message: string,
      kind: "retry" | "rejected",
    ): Promise<void> => {
      const outcome = await store.vaultJobFail({
        principal,
        now: deps.now(),
        jobId: job.jobId,
        objectId: job.objectId,
        code,
        message,
        kind,
        maxAttempts: cfg.maxAttempts,
        backoffMs: cfg.backoffMs,
      });
      if (outcome.outcome === "rejected") {
        report.rejected += 1;
      } else if (outcome.outcome === "pending") {
        report.retried += 1;
      } else if (outcome.outcome === "failed") {
        report.failed += 1;
      }
    };
    const file = { mime: job.mime, name: job.displayName };
    const extractor = selectExtractor(file, extractors);
    if (!extractor) {
      await fail("unsupported_type", `no extractor for ${job.mime}`, "rejected");
      return;
    }
    if (job.size > cfg.maxBytes) {
      await fail("too_large", `larger than the ${cfg.maxBytes} byte extraction limit`, "rejected");
      return;
    }
    const key = vaultObjectKey(job.objectId);
    try {
      if (!(await deps.files.stat(key))) {
        await fail("bytes_missing", "the stored bytes are missing", "retry");
        return;
      }
      const bytes = await deps.files.readRange(key, 0, job.size);
      const { text } = extractor.extract({ bytes, mime: job.mime, name: job.displayName });
      const { pages, truncated } = paginateText(text, cfg.pageChars, cfg.maxChars);
      const done = await store.vaultJobComplete({
        principal,
        now: deps.now(),
        jobId: job.jobId,
        objectId: job.objectId,
        extractor: pipeline.id,
        extractorVersion: pipeline.version,
        pages,
        ...(truncated
          ? {
              note: {
                code: "truncated",
                message: `only the first ${cfg.maxChars} characters were indexed`,
              },
            }
          : {}),
      });
      if (done.outcome === "ready") {
        report.ready += 1;
      } else if (done.outcome === "dropped") {
        report.dropped += 1;
      }
    } catch (error) {
      if (error instanceof ExtractError) {
        await fail(error.code, error.message, error.retryable ? "retry" : "rejected");
        return;
      }
      await fail("extract_error", error instanceof Error ? error.message : String(error), "retry");
    }
  }

  async function runPass(principal: Principal): Promise<VaultExtractReport> {
    const report = emptyReport();
    const cfg = deps.config();
    if (!cfg?.enabled) {
      return report;
    }
    const store = await deps.getStore();
    const swept = await store.vaultJobSweep({
      principal,
      now: deps.now(),
      extractor: pipeline.id,
      extractorVersion: pipeline.version,
      limit: 500,
    });
    report.queued = swept.queued + swept.requeued;
    for (let handled = 0; handled < cfg.batch; handled += 1) {
      const claimed = await store.vaultJobClaim({
        principal,
        now: deps.now(),
        runningTimeoutMs: cfg.runningTimeoutMs,
      });
      if (claimed.outcome === "none") {
        break;
      }
      try {
        await handle(store, principal, cfg, claimed, report);
      } catch (error) {
        deps.warn(
          `vault: extract job ${claimed.jobId} could not be settled: ${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    }
    if (report.ready + report.rejected + report.failed + report.dropped > 0) {
      deps.onProgress?.(principal, report);
    }
    return report;
  }

  /**
   * One pass at a time. A caller that arrives while a pass runs marks it dirty, so the pass goes around once more and sees the
   * job that was queued after the sweep already happened.
   */
  let dirty = false;
  async function loop(principal: Principal): Promise<VaultExtractReport> {
    let report = emptyReport();
    try {
      do {
        dirty = false;
        report = await runPass(principal);
      } while (dirty);
    } finally {
      // Cleared in the same synchronous step as the last `dirty` check: a caller can never mark a pass dirty after it stopped looking.
      active = undefined;
    }
    return report;
  }
  function pass(principal: Principal): Promise<VaultExtractReport> {
    if (active) {
      dirty = true;
      return active;
    }
    const current = loop(principal);
    active = current;
    return current;
  }

  return { pass };
}

export type VaultExtractor = ReturnType<typeof createVaultExtractor>;
