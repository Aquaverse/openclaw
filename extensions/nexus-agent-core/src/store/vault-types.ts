// Personal file vault plain-data types (Vault design sections 4-6), Stage 5. Everything here crosses the SQLite worker boundary,
// so it is data only. The sync phases (R / W-done / P-plan / P-done / C and the lifecycle edits) run in the worker
// (vault-ledger.ts); every byte of file I/O is awaited by the service (src/vault/vault-service.ts) between these calls, so no
// write transaction ever spans an await.
import type { Principal } from "./types.js";

export const VAULT_COLLECTIONS = ["inbox", "vault", "deliverable"] as const;
export type VaultCollection = (typeof VAULT_COLLECTIONS)[number];

/** `gone` is not a stored state: a finished purge deletes the row and writes a receipt. */
export const VAULT_FILE_STATES = ["active", "trashed", "purging", "damaged"] as const;
export type VaultFileState = (typeof VAULT_FILE_STATES)[number];

export const VAULT_SOURCES = [
  "upload",
  "local_import",
  "chat",
  "email",
  "mobile",
  "task_output",
] as const;
export type VaultSource = (typeof VAULT_SOURCES)[number];

export const VAULT_SENSITIVITIES = ["normal", "sensitive"] as const;
export type VaultSensitivity = (typeof VAULT_SENSITIVITIES)[number];
export const VAULT_SENSITIVITY_BY = ["rule", "user", "operator"] as const;
export type VaultSensitivityBy = (typeof VAULT_SENSITIVITY_BY)[number];

export const VAULT_RESERVATION_STATES = [
  "reserved",
  "written",
  "promoted",
  "committed",
  "failed",
  "expired",
] as const;
export type VaultReservationState = (typeof VAULT_RESERVATION_STATES)[number];

export const VAULT_OBJECT_STATES = ["live", "reclaiming", "deleted"] as const;
export type VaultObjectState = (typeof VAULT_OBJECT_STATES)[number];

// ---------------------------------------------------------------- defaults (Vault design 5.4; all configurable)

export const VAULT_DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const VAULT_DEFAULT_OWNER_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;
export const VAULT_DEFAULT_INBOX_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const VAULT_DEFAULT_TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const VAULT_DEFAULT_RESERVATION_TTL_MS = 3600 * 1000;
export const VAULT_DEFAULT_VERSION_KEEP = 5;

export const MAX_VAULT_NAME_CHARS = 255;
export const MAX_VAULT_FOLDER_CHARS = 512;
export const MAX_VAULT_FOLDER_DEPTH = 8;
export const MAX_VAULT_LIST_LIMIT = 200;

export type VaultLimits = {
  /** Largest single file (checked at R when the size is known, always at W). */
  maxFileBytes: number;
  /** Soft quota per owner: live + reclaiming objects plus unsettled reservations. */
  ownerQuotaBytes: number;
};

export type VaultQuotaScope = "owner" | "file";
export type VaultQuotaExceeded = {
  outcome: "quota_exceeded";
  scope: VaultQuotaScope;
  limit: number;
  used: number;
  requested: number;
};

// ---------------------------------------------------------------- reads

export type VaultFileRecord = {
  id: string;
  objectId: string;
  displayName: string;
  folder: string;
  collection: VaultCollection;
  state: VaultFileState;
  source: VaultSource;
  sourceRef: string | null;
  sensitivity: VaultSensitivity;
  sensitivityBy: VaultSensitivityBy;
  importedBy: string;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  expiresAt: number | null;
  size: number;
  mime: string;
  contentHash: string;
  versionCount: number;
  pinnedAt: number | null;
  favorite: boolean;
  lastOpenedAt: number | null;
};

export type VaultGetInput = { principal: Principal; fileId: string };
export type VaultGetOutcome = { outcome: "ok"; file: VaultFileRecord } | { outcome: "not_found" };

export type VaultListInput = {
  principal: Principal;
  collection?: VaultCollection;
  folder?: string;
  /** Default: `active` only. `trashed` is the recycle bin view. */
  state?: VaultFileState;
  /** Substring match on the display name only (never on content; content search is F2). */
  nameContains?: string;
  includeSensitive?: boolean;
  pinnedFirst?: boolean;
  limit?: number;
  offset?: number;
};
export type VaultListResult = { items: VaultFileRecord[]; total: number };

export type VaultStatsResult = {
  /** Files by collection / state (purging and damaged are listed so the console can show them). */
  files: Record<string, number>;
  /** Physical bytes held by live + reclaiming objects of this owner. */
  objectBytes: number;
  /** Bytes promised by reservations that are not settled yet. */
  reservedBytes: number;
  objects: number;
};

export type VaultFindByHashInput = { principal: Principal; contentHash: string };
export type VaultFindByHashResult = {
  objectId: string | null;
  files: {
    id: string;
    displayName: string;
    folder: string;
    collection: VaultCollection;
    state: VaultFileState;
  }[];
};

export type VaultReadRefInput = {
  principal: Principal;
  fileId: string;
  allowTrashed?: boolean;
  /** Stamp `last_opened_at` (the only write a read may do; it never changes access). */
  touchAt?: number;
};
export type VaultReadRefOutcome =
  | {
      outcome: "ok";
      fileId: string;
      objectId: string;
      size: number;
      mime: string;
      displayName: string;
      contentHash: string;
      sensitivity: VaultSensitivity;
    }
  | { outcome: "not_found" }
  | { outcome: "not_readable"; state: VaultFileState };

// ---------------------------------------------------------------- R: reserve

export type VaultReserveInput = {
  principal: Principal;
  now: number;
  /** Known size (RPC upload, path import after stat). Null/absent when streaming; W then enforces the cap. */
  expectedSize?: number | null;
  limits: VaultLimits;
  ttlMs: number;
  writerAttemptId: string;
  /** The incarnation the plugin service registered at start; the vault never registers one itself. */
  incarnationId: string;
};

export type VaultReservationView = {
  id: string;
  newObjectId: string;
  /** Always `staging/<id>` on disk; the key is the reservation id. */
  stagingKey: string;
  expiresAt: number;
};

export type VaultReserveOutcome =
  | { outcome: "reserved"; reservation: VaultReservationView }
  | VaultQuotaExceeded
  | { outcome: "writer_unregistered" };

// ---------------------------------------------------------------- W / P

export type VaultMarkWrittenInput = {
  principal: Principal;
  reservationId: string;
  contentHash: string;
  byteSize: number;
  now: number;
  limits: VaultLimits;
};
export type VaultMarkWrittenOutcome =
  | { outcome: "written" }
  | VaultQuotaExceeded
  | { outcome: "wrong_state"; state: VaultReservationState }
  | { outcome: "not_found" }
  | { outcome: "invalid" };

export type VaultFailReservationInput = {
  principal: Principal;
  reservationId: string;
  now: number;
  reason: "write_failed" | "rejected" | "cancelled";
};
export type VaultFailReservationOutcome =
  | { outcome: "failed" }
  | { outcome: "wrong_state"; state: VaultReservationState }
  | { outcome: "not_found" };

export type VaultPlanPromoteInput = { principal: Principal; reservationId: string };
export type VaultPlanPromoteOutcome =
  /** A live object with the same content exists: reuse it, move nothing. The reservation stays `written`. */
  | { outcome: "reuse"; objectId: string }
  /** No live object: rename `staging/<id>` to `objects/<newObjectId>`. */
  | { outcome: "promote"; newObjectId: string; stagingKey: string }
  | { outcome: "wrong_state"; state: VaultReservationState }
  | { outcome: "not_found" };

export type VaultMarkPromotedInput = { principal: Principal; reservationId: string; now: number };
export type VaultMarkPromotedOutcome =
  | { outcome: "promoted" }
  | { outcome: "wrong_state"; state: VaultReservationState }
  | { outcome: "not_found" };

// ---------------------------------------------------------------- C: commit

export type VaultFileDraft = {
  displayName: string;
  folder?: string;
  collection: VaultCollection;
  source: VaultSource;
  sourceRef?: string | null;
  sensitivity?: VaultSensitivity;
  sensitivityBy?: VaultSensitivityBy;
  importedBy: string;
};

export type VaultCommitInput = {
  principal: Principal;
  reservationId: string;
  now: number;
  /** Server-sniffed media type (never the declared one); stored on a new object only. */
  mime: string;
  file: VaultFileDraft;
  /** Inbox entries expire after this long (Vault design 5.4). */
  inboxRetentionMs: number;
};

export type VaultCommitOutcome =
  | {
      outcome: "committed";
      fileId: string;
      objectId: string;
      /** true: this reservation's own physical file became the object. false: an existing live object was reused. */
      newObject: boolean;
      /** Set when the reservation was already `promoted` but lost the race: its physical file is now the failed side. */
      loser: { newObjectId: string; stagingKey: string } | null;
    }
  | { outcome: "noop"; state: VaultReservationState }
  /** `written` and no winner any more: the service must run P (rename) and call commit again. */
  | { outcome: "need_promote" }
  | { outcome: "invalid"; reason: "name" | "folder" | "collection" }
  | { outcome: "not_found" };

// ---------------------------------------------------------------- lifecycle edits

export type VaultKeepInput = { principal: Principal; fileId: string; now: number; folder?: string };
export type VaultDiscardInput = { principal: Principal; fileId: string; now: number };
export type VaultTrashInput = { principal: Principal; fileId: string; now: number };
export type VaultRestoreInput = { principal: Principal; fileId: string; now: number };
export type VaultRenameInput = {
  principal: Principal;
  fileId: string;
  now: number;
  displayName: string;
};
export type VaultMoveInput = { principal: Principal; fileId: string; now: number; folder: string };
export type VaultSetSensitivityInput = {
  principal: Principal;
  fileId: string;
  now: number;
  sensitivity: VaultSensitivity;
  by: VaultSensitivityBy;
};
export type VaultPinInput = {
  principal: Principal;
  fileId: string;
  now: number;
  pinned?: boolean;
  favorite?: boolean;
};

export type VaultEditOutcome =
  | { outcome: "ok"; file: VaultFileRecord }
  | { outcome: "not_found" }
  | { outcome: "wrong_state"; state: VaultFileState; collection: VaultCollection }
  | { outcome: "invalid"; reason: "name" | "folder" };

// ---------------------------------------------------------------- name / folder rules (shared by the ledger and the RPC layer)

/** True when the text holds an ASCII control character (U+0000-U+001F or U+007F). */
function hasControlChar(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return false;
}

export function normalizeVaultName(raw: string): string | null {
  const name = raw.normalize("NFC").trim();
  if (name.length === 0 || name.length > MAX_VAULT_NAME_CHARS) {
    return null;
  }
  if (
    hasControlChar(name) ||
    name.includes("/") ||
    name.includes("\\") ||
    name === "." ||
    name === ".."
  ) {
    return null;
  }
  return name;
}

/** Folders are metadata only (never a path): `a/b/c`, no empty segments, no `.` / `..`, bounded depth and length. */
export function normalizeVaultFolder(raw: string): string | null {
  const text = raw
    .normalize("NFC")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (text === "") {
    return "";
  }
  if (text.length > MAX_VAULT_FOLDER_CHARS || hasControlChar(text) || text.includes("\\")) {
    return null;
  }
  const parts = text.split("/");
  if (parts.length > MAX_VAULT_FOLDER_DEPTH) {
    return null;
  }
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed === "" || trimmed === "." || trimmed === ".." || trimmed !== part) {
      return null;
    }
  }
  return parts.join("/");
}

// ---------------------------------------------------------------- physical keys (shared by the ledger and the byte store)

/** Relative to the vault root: `objects/<id[0..2]>/<id>`. The id is a server-issued random id, never user text. */
export const vaultObjectKey = (objectId: string): string =>
  `objects/${objectId.slice(0, 2)}/${objectId}`;
/** Relative to the vault root: `staging/<reservation id>`. */
export const vaultStagingKey = (reservationId: string): string => `staging/${reservationId}`;
