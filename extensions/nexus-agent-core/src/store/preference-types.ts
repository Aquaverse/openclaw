// Preference plain-data types (DESIGN section 11). Everything here crosses the SQLite worker boundary.
import type { Principal } from "./types.js";

export type PreferenceOrigin = "stated" | "observed" | "task_exception";
export type PreferenceAssertedBy = "user" | "agent";

/** Active rows an owner may hold; keeps a runaway Agent from filling the table with observations. */
export const MAX_ACTIVE_PREFERENCES = 1000;
/** Canonical JSON size of one value. A preference is a short value, not a document. */
export const MAX_PREFERENCE_VALUE_BYTES = 4096;
export const MAX_SOURCE_NOTE_CHARS = 500;

const SCOPE = /^(global|domain:[a-z0-9][a-z0-9_.-]{0,39})$/;
const KEY = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export function isValidPreferenceScope(scope: unknown): scope is string {
  return typeof scope === "string" && SCOPE.test(scope);
}
export function isValidPreferenceKey(key: unknown): key is string {
  return typeof key === "string" && KEY.test(key);
}

export type PreferenceRecord = {
  id: string;
  scope: string;
  key: string;
  value: unknown;
  origin: PreferenceOrigin;
  taskId: string | null;
  assertedBy: PreferenceAssertedBy;
  /** Set when a `set_preference` decision confirmed this value (stated only). */
  decisionRef: string | null;
  confidence: number | null;
  revision: number;
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type PreferenceRevisionRecord = {
  id: string;
  seq: number;
  op: "set" | "supersede" | "delete";
  value: unknown;
  origin: PreferenceOrigin;
  assertedBy: PreferenceAssertedBy;
  decisionRef: string | null;
  sourceNote: string | null;
  createdAt: number;
};

/** The mutation a `set_preference` decision carries (effect_payload_canonical, part of the authority hash). */
export type PreferenceMutation = { op: "set"; scope: string; key: string; value: unknown };

export type PreferenceInvalidCode =
  | "bad_scope"
  | "bad_key"
  | "bad_value"
  | "value_too_large"
  | "origin_not_allowed"
  | "task_required"
  | "task_forbidden"
  | "bad_confidence"
  | "source_note_required"
  | "source_note_too_long";

export type PreferenceWriteOutcome =
  | { outcome: "created" | "updated" | "unchanged"; preference: PreferenceRecord }
  | { outcome: "invalid"; code: PreferenceInvalidCode }
  | { outcome: "task_not_found" }
  | { outcome: "task_closed"; status: string }
  | { outcome: "limit_reached"; max: number };

export type PreferenceAgentSetInput = {
  principal: Principal;
  scope: string;
  key: string;
  value: unknown;
  /** The Agent can only write these two. `stated` has no way in through this method. */
  origin: "observed" | "task_exception";
  taskId?: string;
  confidence?: number;
  sourceNote?: string;
  now: number;
};

export type PreferenceOperatorSetInput = {
  principal: Principal;
  scope: string;
  key: string;
  value: unknown;
  /** Audit string only; the row records `asserted_by = 'user'`. */
  actor: string;
  now: number;
};

export type PreferenceShadowed = {
  preferenceId: string;
  value: unknown;
  origin: PreferenceOrigin;
  reason: string;
};

export type PreferenceResolution = {
  scope: string;
  key: string;
  value: unknown;
  origin: PreferenceOrigin;
  preferenceId: string;
  revision: number;
  /** `observed` is a candidate and a display reason only (section 11.2); nothing automatic may rely on it. */
  eligibleForAutomation: boolean;
  shadowed: PreferenceShadowed[];
  /** A task_exception exists for this Task but did not take part (the Task is closed, or was not found). */
  ignoredTaskException?: { preferenceId: string; reason: "task_closed" | "task_not_found" };
};

export type PreferenceGetOutcome =
  | { outcome: "found"; resolution: PreferenceResolution }
  | { outcome: "none" };

export type PreferenceListInput = {
  principal: Principal;
  scope?: string;
  origin?: PreferenceOrigin;
  taskId?: string;
  includeDeleted?: boolean;
  limit: number;
};

export type PreferenceHistoryOutcome =
  | { outcome: "found"; preference: PreferenceRecord; revisions: PreferenceRevisionRecord[] }
  | { outcome: "not_found" };

export type PreferenceDeleteOutcome =
  | { outcome: "deleted"; preference: PreferenceRecord }
  | { outcome: "not_found" }
  | { outcome: "already_deleted"; preference: PreferenceRecord };

export type PreferencePurgeOutcome =
  | { outcome: "purged"; receipt: PreferenceReceiptRow }
  | { outcome: "not_found" };

/** Carries hashes and counts only (DESIGN 11.5): never the key, the scope or any value. */
export type PreferenceReceiptRow = {
  id: string;
  preferenceKeyHash: string;
  revisionCount: number;
  purgedScope: "preferences";
  requestedBy: string;
  executedAt: number;
};
