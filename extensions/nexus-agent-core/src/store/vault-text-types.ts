import type { Principal } from "./types.js";
// Text extraction and content search plain-data types (Vault design sections 9.1-9.4), Stage 5 / F2. Everything here crosses
// the SQLite worker boundary, so it is data only. Text is derived data: it is deleted with its object, hidden as soon as any
// file that references the object is sensitive, and never reaches the agent (the agent only learns which files matched).
import type { VaultFileRecord, VaultCollection } from "./vault-types.js";

export const VAULT_JOB_STAGES = ["extract", "classify", "index", "derive"] as const;
export const VAULT_JOB_STATES = [
  "pending",
  "running",
  "ready",
  "failed",
  "rejected",
  "cancelled",
] as const;
export type VaultJobState = (typeof VAULT_JOB_STATES)[number];

/** What the console and the agent are told about one file's text. `skipped` = sensitive (or not eligible); `none` = no job yet. */
export type VaultExtractionState = VaultJobState | "skipped" | "none";

export type VaultExtractionStatus = {
  state: VaultExtractionState;
  extractor: string;
  failureCode: string | null;
  failureMessage: string | null;
  attempts: number;
  pages: number;
  chars: number;
  updatedAt: number | null;
};

export const VAULT_TEXT_MAX_QUERY_TERMS = 5;
export const VAULT_TEXT_MAX_QUERY_CHARS = 200;
export const VAULT_TEXT_MAX_PAGE_CHARS = 100_000;

// ---------------------------------------------------------------- job queue

export type VaultJobSweepInput = {
  principal: Principal;
  now: number;
  extractor: string;
  extractorVersion: string;
  limit: number;
};
/** `queued`: new jobs; `requeued`: cancelled jobs that became eligible again (a file stopped being sensitive). */
export type VaultJobSweepResult = { queued: number; requeued: number };

export type VaultJobClaimInput = {
  principal: Principal;
  now: number;
  /** A job still `running` after this long belongs to a crashed pass and is picked up again. */
  runningTimeoutMs: number;
};
export type VaultJobClaimOutcome =
  | {
      outcome: "claimed";
      jobId: string;
      objectId: string;
      attempts: number;
      size: number;
      mime: string;
      /** A display name of a (non-sensitive) file that references the object; used for the extension only. */
      displayName: string;
    }
  | { outcome: "none" };

export type VaultJobCompleteInput = {
  principal: Principal;
  now: number;
  jobId: string;
  objectId: string;
  extractor: string;
  extractorVersion: string;
  pages: string[];
  /** A finished job may still carry a remark (for example `truncated`); the console shows it next to the ready state. */
  note?: { code: string; message: string };
};
export type VaultJobCompleteOutcome =
  | { outcome: "ready"; pages: number; chars: number }
  /** The object became ineligible while the extractor ran (sensitive, reclaimed): nothing was stored. */
  | { outcome: "dropped" }
  | { outcome: "not_running" };

export type VaultJobFailInput = {
  principal: Principal;
  now: number;
  jobId: string;
  objectId: string;
  code: string;
  message: string;
  /** `rejected`: this object can never be extracted by this extractor (unsupported type, too large, binary). */
  kind: "retry" | "rejected";
  maxAttempts: number;
  /** Wall-clock backoff before the next attempt, indexed by attempts so far (the last entry repeats). */
  backoffMs: number[];
};
export type VaultJobFailOutcome =
  | { outcome: "pending"; nextRunAt: number }
  | { outcome: "failed" }
  | { outcome: "rejected" }
  | { outcome: "not_running" };

export type VaultJobRetryInput = { principal: Principal; fileId: string; now: number };
export type VaultJobRetryOutcome =
  | { outcome: "queued" }
  | { outcome: "not_found" }
  | { outcome: "not_retryable"; state: VaultExtractionState };

export type VaultJobListInput = {
  principal: Principal;
  state?: VaultJobState;
  limit?: number;
};
export type VaultJobView = {
  jobId: string;
  objectId: string;
  fileId: string | null;
  displayName: string | null;
  state: VaultJobState;
  attempts: number;
  extractor: string;
  failureCode: string | null;
  failureMessage: string | null;
  nextRunAt: number | null;
  updatedAt: number;
};
export type VaultJobListResult = { items: VaultJobView[] };

// ---------------------------------------------------------------- reads

export type VaultExtractionStatusInput = { principal: Principal; objectIds: string[] };
export type VaultExtractionStatusResult = { byObject: Record<string, VaultExtractionStatus> };

export type VaultTextReadInput = {
  principal: Principal;
  fileId: string;
  page?: number;
  maxChars?: number;
  allowTrashed?: boolean;
};
export type VaultTextReadOutcome =
  | {
      outcome: "ok";
      fileId: string;
      page: number;
      pageCount: number;
      text: string;
      truncated: boolean;
      chars: number;
      extractor: string;
    }
  | { outcome: "not_found" }
  | { outcome: "no_text"; state: VaultExtractionState };

export type VaultTextSearchInput = {
  principal: Principal;
  query: string;
  collection?: VaultCollection;
  folder?: string;
  limit?: number;
  offset?: number;
  /** Test hook: force the LIKE path even when FTS5 is available. */
  forceLike?: boolean;
};
export type VaultTextSearchResult = {
  items: VaultFileRecord[];
  total: number;
  /** `fts`: FTS5 trigram index; `like`: substring scan (FTS5 unavailable, or a term shorter than three characters). */
  mode: "fts" | "like";
  /** Eligible active files in the same scope that have no searchable text yet. A "no match" never covers these. */
  unindexed: { pending: number; failed: number; unsupported: number };
};

export type VaultTextStatsResult = {
  fts: boolean;
  secureDelete: boolean;
  jobs: Record<string, number>;
  indexedObjects: number;
  textChars: number;
};
