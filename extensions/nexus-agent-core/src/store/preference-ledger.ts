// Preference kernel (DESIGN section 11). Runs inside the SQLite worker; every method is ONE synchronous transaction and
// every statement filters on owner_id. What is specific here:
//   * a preference narrows candidates or changes a default; it is NEVER authority (section 11.1). Nothing in this file
//     touches a grant, an execution or a risk tier, and no decision/grant code reads `preferences` (a test enforces it);
//   * the origin ladder is enforced by structure first and by CHECK second: the Agent has exactly one write method and it
//     accepts only `observed` / `task_exception`; `stated` has two doors - the operator method and the in-transaction hook
//     the decision kernel calls when a `set_preference` decision is approved;
//   * `preferences` is the projection, `preference_revisions` the append-only history; neither joins the claim chain.
import { canonicalJson, sha256Hex } from "../canonical.js";
import type { ClaimLedger } from "./claim-ledger.js";
import { isClosed, parseJson, type TransactionRunner } from "./kernel.js";
import {
  isValidPreferenceKey,
  isValidPreferenceScope,
  MAX_ACTIVE_PREFERENCES,
  MAX_PREFERENCE_VALUE_BYTES,
  MAX_SOURCE_NOTE_CHARS,
  type PreferenceAgentSetInput,
  type PreferenceAssertedBy,
  type PreferenceDeleteOutcome,
  type PreferenceGetOutcome,
  type PreferenceHistoryOutcome,
  type PreferenceInvalidCode,
  type PreferenceListInput,
  type PreferenceMutation,
  type PreferenceOperatorSetInput,
  type PreferenceOrigin,
  type PreferencePurgeOutcome,
  type PreferenceReceiptRow,
  type PreferenceRecord,
  type PreferenceRevisionRecord,
  type PreferenceShadowed,
  type PreferenceWriteOutcome,
} from "./preference-types.js";
import type { Principal } from "./types.js";

type Row = Record<string, unknown>;

const RANK: Record<PreferenceOrigin, number> = { task_exception: 0, stated: 1, observed: 2 };

function toPreference(row: Row): PreferenceRecord {
  return {
    id: String(row.id),
    scope: String(row.scope),
    key: String(row.key),
    value: parseJson(row.value_json),
    origin: String(row.origin) as PreferenceOrigin,
    taskId: typeof row.task_id === "string" ? row.task_id : null,
    assertedBy: String(row.asserted_by) as PreferenceAssertedBy,
    decisionRef: typeof row.decision_ref === "string" ? row.decision_ref : null,
    confidence:
      row.confidence === null || row.confidence === undefined ? null : Number(row.confidence),
    revision: Number(row.revision),
    deletedAt:
      row.deleted_at === null || row.deleted_at === undefined ? null : Number(row.deleted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function toRevision(row: Row): PreferenceRevisionRecord {
  return {
    id: String(row.id),
    seq: Number(row.seq),
    op: String(row.op) as PreferenceRevisionRecord["op"],
    value: row.value_json === null ? null : parseJson(row.value_json),
    origin: String(row.origin) as PreferenceOrigin,
    assertedBy: String(row.asserted_by) as PreferenceAssertedBy,
    decisionRef: typeof row.decision_ref === "string" ? row.decision_ref : null,
    sourceNote: typeof row.source_note === "string" ? row.source_note : null,
    createdAt: Number(row.created_at),
  };
}

/** Stable text of a value, or the reason it cannot be stored. `undefined` and non-JSON values are refused. */
export function canonicalPreferenceValue(
  value: unknown,
): { ok: true; text: string } | { ok: false; code: PreferenceInvalidCode } {
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return { ok: false, code: "bad_value" };
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return { ok: false, code: "bad_value" };
  }
  let text: string;
  try {
    text = canonicalJson(value);
  } catch {
    return { ok: false, code: "bad_value" };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_PREFERENCE_VALUE_BYTES) {
    return { ok: false, code: "value_too_large" };
  }
  return { ok: true, text };
}

export function preferenceMutationCanonical(mutation: PreferenceMutation): string {
  return canonicalJson({
    op: "set",
    scope: mutation.scope,
    key: mutation.key,
    value: mutation.value,
  });
}

type UpsertSpec = {
  scope: string;
  key: string;
  valueText: string;
  origin: PreferenceOrigin;
  assertedBy: PreferenceAssertedBy;
  taskId: string | null;
  confidence: number | null;
  decisionRef: string | null;
  sourceNote: string | null;
  now: number;
};

export function createPreferenceLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId } = internals;

  const activeRow = (
    owner: string,
    spec: Pick<UpsertSpec, "scope" | "key" | "origin" | "taskId">,
  ) =>
    one(
      "SELECT * FROM preferences WHERE owner_id = ? AND scope = ? AND key = ? AND origin = ? " +
        "AND COALESCE(task_id, '') = ? AND deleted_at IS NULL AND purged_at IS NULL",
      owner,
      spec.scope,
      spec.key,
      spec.origin,
      spec.taskId ?? "",
    );

  const preferenceById = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM preferences WHERE owner_id = ? AND id = ?", owner, id);

  /** Insert or supersede one (scope, key, origin, task) row and append its revision. Caller owns the transaction. */
  const upsertInTx = (owner: string, spec: UpsertSpec): PreferenceWriteOutcome => {
    const existing = activeRow(owner, spec);
    if (existing) {
      const sameValue = String(existing.value_json) === spec.valueText;
      const sameConfidence =
        spec.origin !== "observed" || Number(existing.confidence) === spec.confidence;
      if (sameValue && sameConfidence) {
        return { outcome: "unchanged", preference: toPreference(existing) };
      }
      const revisionId = newId("PV");
      const seq = Number(existing.revision) + 1;
      run(
        "INSERT INTO preference_revisions (id, owner_id, preference_id, seq, op, value_json, origin, asserted_by, decision_ref, " +
          "source_note, created_at) VALUES (?, ?, ?, ?, 'supersede', ?, ?, ?, ?, ?, ?)",
        revisionId,
        owner,
        String(existing.id),
        seq,
        spec.valueText,
        spec.origin,
        spec.assertedBy,
        spec.decisionRef,
        spec.sourceNote,
        spec.now,
      );
      run(
        "UPDATE preferences SET value_json = ?, confidence = ?, decision_ref = ?, head_revision_id = ?, revision = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ?",
        spec.valueText,
        spec.confidence,
        spec.decisionRef,
        revisionId,
        seq,
        spec.now,
        owner,
        String(existing.id),
      );
      return {
        outcome: "updated",
        preference: toPreference(preferenceById(owner, String(existing.id)) as Row),
      };
    }
    const active = Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM preferences WHERE owner_id = ? AND deleted_at IS NULL AND purged_at IS NULL",
          owner,
        ) as Row
      ).c,
    );
    if (active >= MAX_ACTIVE_PREFERENCES) {
      return { outcome: "limit_reached", max: MAX_ACTIVE_PREFERENCES };
    }
    const id = newId("PF");
    const revisionId = newId("PV");
    run(
      "INSERT INTO preferences (id, owner_id, scope, key, value_json, origin, task_id, asserted_by, decision_ref, confidence, " +
        "head_revision_id, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      id,
      owner,
      spec.scope,
      spec.key,
      spec.valueText,
      spec.origin,
      spec.taskId,
      spec.assertedBy,
      spec.decisionRef,
      spec.confidence,
      revisionId,
      spec.now,
      spec.now,
    );
    run(
      "INSERT INTO preference_revisions (id, owner_id, preference_id, seq, op, value_json, origin, asserted_by, decision_ref, " +
        "source_note, created_at) VALUES (?, ?, ?, 1, 'set', ?, ?, ?, ?, ?, ?)",
      revisionId,
      owner,
      id,
      spec.valueText,
      spec.origin,
      spec.assertedBy,
      spec.decisionRef,
      spec.sourceNote,
      spec.now,
    );
    return { outcome: "created", preference: toPreference(preferenceById(owner, id) as Row) };
  };

  const checkScopeKeyValue = (
    scope: unknown,
    key: unknown,
    value: unknown,
  ): { ok: true; valueText: string } | { ok: false; code: PreferenceInvalidCode } => {
    if (!isValidPreferenceScope(scope)) {
      return { ok: false, code: "bad_scope" };
    }
    if (!isValidPreferenceKey(key)) {
      return { ok: false, code: "bad_key" };
    }
    const canonical = canonicalPreferenceValue(value);
    return canonical.ok ? { ok: true, valueText: canonical.text } : canonical;
  };

  // ------------------------------------------------------------------ the Agent's one write method

  const preferenceAgentSet = (input: PreferenceAgentSetInput): PreferenceWriteOutcome =>
    transaction((): PreferenceWriteOutcome => {
      const owner = input.principal.ownerId;
      // Structural gate: `stated` cannot be named here, whatever the caller passes (section 11.4).
      const origin = input.origin as string;
      if (origin !== "observed" && origin !== "task_exception") {
        return { outcome: "invalid", code: "origin_not_allowed" };
      }
      const checked = checkScopeKeyValue(input.scope, input.key, input.value);
      if (!checked.ok) {
        return { outcome: "invalid", code: checked.code };
      }
      let taskId: string | null = null;
      if (origin === "task_exception") {
        if (typeof input.taskId !== "string" || input.taskId.length === 0) {
          return { outcome: "invalid", code: "task_required" };
        }
        const task = one(
          "SELECT status FROM nexus_tasks WHERE owner_id = ? AND id = ?",
          owner,
          input.taskId,
        );
        if (!task) {
          return { outcome: "task_not_found" };
        }
        if (isClosed(String(task.status))) {
          return { outcome: "task_closed", status: String(task.status) };
        }
        taskId = input.taskId;
      } else if (input.taskId !== undefined) {
        return { outcome: "invalid", code: "task_forbidden" };
      }
      let confidence: number | null = null;
      let sourceNote: string | null = null;
      if (origin === "observed") {
        if (
          typeof input.confidence !== "number" ||
          !Number.isFinite(input.confidence) ||
          input.confidence <= 0 ||
          input.confidence > 1
        ) {
          return { outcome: "invalid", code: "bad_confidence" };
        }
        confidence = input.confidence;
        const note = typeof input.sourceNote === "string" ? input.sourceNote.trim() : "";
        if (note.length === 0) {
          return { outcome: "invalid", code: "source_note_required" };
        }
        if (Array.from(note).length > MAX_SOURCE_NOTE_CHARS) {
          return { outcome: "invalid", code: "source_note_too_long" };
        }
        sourceNote = note;
      } else if (input.confidence !== undefined) {
        return { outcome: "invalid", code: "bad_confidence" };
      }
      return upsertInTx(owner, {
        scope: input.scope,
        key: input.key,
        valueText: checked.valueText,
        origin,
        assertedBy: "agent",
        taskId,
        confidence,
        decisionRef: null,
        sourceNote,
        now: input.now,
      });
    });

  // ------------------------------------------------------------------ stated: the operator door

  const preferenceOperatorSet = (input: PreferenceOperatorSetInput): PreferenceWriteOutcome =>
    transaction((): PreferenceWriteOutcome => {
      const checked = checkScopeKeyValue(input.scope, input.key, input.value);
      if (!checked.ok) {
        return { outcome: "invalid", code: checked.code };
      }
      return upsertInTx(input.principal.ownerId, {
        scope: input.scope,
        key: input.key,
        valueText: checked.valueText,
        origin: "stated",
        assertedBy: "user",
        taskId: null,
        confidence: null,
        decisionRef: null,
        sourceNote: null,
        now: input.now,
      });
    });

  // ------------------------------------------------------------------ stated: the decision door

  /**
   * Called by the decision kernel INSIDE the resolve transaction when a `set_preference` decision is approved. It writes
   * `preferences` + `preference_revisions` and nothing else: no grant, no execution (section 8.12). The mutation is the one
   * stored in the decision row, re-validated here, so a malformed payload fails the whole resolve instead of half applying.
   */
  const applyStatedInTx = (
    owner: string,
    mutationText: string,
    decisionId: string,
    now: number,
  ):
    | { ok: true; preference: PreferenceRecord; created: boolean }
    | { ok: false; reason: string } => {
    const parsed = parseJson(mutationText) as Partial<PreferenceMutation> | null;
    if (!parsed || parsed.op !== "set") {
      return { ok: false, reason: "bad_mutation" };
    }
    const checked = checkScopeKeyValue(parsed.scope, parsed.key, parsed.value);
    if (!checked.ok) {
      return { ok: false, reason: checked.code };
    }
    const out = upsertInTx(owner, {
      scope: parsed.scope as string,
      key: parsed.key as string,
      valueText: checked.valueText,
      origin: "stated",
      assertedBy: "user",
      taskId: null,
      confidence: null,
      decisionRef: decisionId,
      sourceNote: null,
      now,
    });
    if (out.outcome === "created" || out.outcome === "updated" || out.outcome === "unchanged") {
      return { ok: true, preference: out.preference, created: out.outcome === "created" };
    }
    return { ok: false, reason: out.outcome };
  };

  // ------------------------------------------------------------------ reading

  const preferenceGet = (input: {
    principal: Principal;
    scope: string;
    key: string;
    taskId?: string;
  }): PreferenceGetOutcome => {
    const owner = input.principal.ownerId;
    // The exception is considered only for the Task the caller names, and only while that Task is still open.
    let exceptionTask: string | null = null;
    let ignoredReason: "task_closed" | "task_not_found" | null = null;
    if (typeof input.taskId === "string" && input.taskId.length > 0) {
      const task = one(
        "SELECT status FROM nexus_tasks WHERE owner_id = ? AND id = ?",
        owner,
        input.taskId,
      );
      if (!task) {
        ignoredReason = "task_not_found";
      } else if (isClosed(String(task.status))) {
        ignoredReason = "task_closed";
      } else {
        exceptionTask = input.taskId;
      }
    }
    const rows = all(
      "SELECT * FROM preferences WHERE owner_id = ? AND scope = ? AND key = ? AND deleted_at IS NULL AND purged_at IS NULL " +
        "AND (origin IN ('stated','observed') OR (origin = 'task_exception' AND task_id = ?))",
      owner,
      input.scope,
      input.key,
      exceptionTask ?? "",
    )
      .map(toPreference)
      .toSorted((a, b) => RANK[a.origin] - RANK[b.origin]);
    let ignoredTaskException:
      | { preferenceId: string; reason: "task_closed" | "task_not_found" }
      | undefined;
    if (ignoredReason !== null && typeof input.taskId === "string") {
      const ignored = one(
        "SELECT id FROM preferences WHERE owner_id = ? AND scope = ? AND key = ? AND origin = 'task_exception' AND task_id = ? " +
          "AND deleted_at IS NULL",
        owner,
        input.scope,
        input.key,
        input.taskId,
      );
      if (ignored) {
        ignoredTaskException = { preferenceId: String(ignored.id), reason: ignoredReason };
      }
    }
    const [winner, ...rest] = rows;
    if (!winner) {
      return { outcome: "none" };
    }
    const shadowed: PreferenceShadowed[] = rest.map((row) => ({
      preferenceId: row.id,
      value: row.value,
      origin: row.origin,
      reason: `overridden_by_${winner.origin}`,
    }));
    return {
      outcome: "found",
      resolution: {
        scope: winner.scope,
        key: winner.key,
        value: winner.value,
        origin: winner.origin,
        preferenceId: winner.id,
        revision: winner.revision,
        eligibleForAutomation: winner.origin !== "observed",
        shadowed,
        ...(ignoredTaskException ? { ignoredTaskException } : {}),
      },
    };
  };

  const preferenceList = (input: PreferenceListInput): PreferenceRecord[] => {
    const clauses = ["owner_id = ?", "purged_at IS NULL"];
    const params: (string | number)[] = [input.principal.ownerId];
    if (!input.includeDeleted) {
      clauses.push("deleted_at IS NULL");
    }
    if (input.scope !== undefined) {
      clauses.push("scope = ?");
      params.push(input.scope);
    }
    if (input.origin !== undefined) {
      clauses.push("origin = ?");
      params.push(input.origin);
    }
    if (input.taskId !== undefined) {
      clauses.push("task_id = ?");
      params.push(input.taskId);
    }
    params.push(Math.max(1, Math.min(200, input.limit)));
    return all(
      `SELECT * FROM preferences WHERE ${clauses.join(" AND ")} ORDER BY scope, key, origin, updated_at DESC LIMIT ?`,
      ...params,
    ).map(toPreference);
  };

  const preferenceHistory = (input: {
    principal: Principal;
    preferenceId: string;
  }): PreferenceHistoryOutcome => {
    const owner = input.principal.ownerId;
    const row = preferenceById(owner, input.preferenceId);
    if (!row) {
      return { outcome: "not_found" };
    }
    return {
      outcome: "found",
      preference: toPreference(row),
      revisions: all(
        "SELECT * FROM preference_revisions WHERE owner_id = ? AND preference_id = ? ORDER BY seq",
        owner,
        input.preferenceId,
      ).map(toRevision),
    };
  };

  // ------------------------------------------------------------------ soft delete / hard purge

  const preferenceDelete = (input: {
    principal: Principal;
    preferenceId: string;
    actor: string;
    now: number;
  }): PreferenceDeleteOutcome =>
    transaction((): PreferenceDeleteOutcome => {
      const owner = input.principal.ownerId;
      const row = preferenceById(owner, input.preferenceId);
      if (!row) {
        return { outcome: "not_found" };
      }
      if (row.deleted_at !== null) {
        return { outcome: "already_deleted", preference: toPreference(row) };
      }
      const seq = Number(row.revision) + 1;
      const revisionId = newId("PV");
      run(
        "INSERT INTO preference_revisions (id, owner_id, preference_id, seq, op, value_json, origin, asserted_by, decision_ref, " +
          "source_note, created_at) VALUES (?, ?, ?, ?, 'delete', NULL, ?, ?, NULL, ?, ?)",
        revisionId,
        owner,
        input.preferenceId,
        seq,
        String(row.origin),
        String(row.asserted_by),
        // `observed` revisions must carry a note (CHECK); a delete states who did it.
        `deleted by ${input.actor}`.slice(0, MAX_SOURCE_NOTE_CHARS),
        input.now,
      );
      run(
        "UPDATE preferences SET deleted_at = ?, head_revision_id = ?, revision = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        revisionId,
        seq,
        input.now,
        owner,
        input.preferenceId,
      );
      return {
        outcome: "deleted",
        preference: toPreference(preferenceById(owner, input.preferenceId) as Row),
      };
    });

  /** Really delete every row (any origin, any Task, deleted or not) for one scope+key and leave a hashes-only receipt. */
  const preferencePurge = (input: {
    principal: Principal;
    scope: string;
    key: string;
    requestedBy: string;
    now: number;
  }): PreferencePurgeOutcome =>
    transaction((): PreferencePurgeOutcome => {
      const owner = input.principal.ownerId;
      const rows = all(
        "SELECT id FROM preferences WHERE owner_id = ? AND scope = ? AND key = ?",
        owner,
        input.scope,
        input.key,
      );
      if (rows.length === 0) {
        return { outcome: "not_found" };
      }
      const revisionCount = Number(
        (
          one(
            "SELECT COUNT(*) AS c FROM preference_revisions WHERE owner_id = ? AND preference_id IN " +
              "(SELECT id FROM preferences WHERE owner_id = ? AND scope = ? AND key = ?)",
            owner,
            owner,
            input.scope,
            input.key,
          ) as Row
        ).c,
      );
      run(
        "DELETE FROM preferences WHERE owner_id = ? AND scope = ? AND key = ?",
        owner,
        input.scope,
        input.key,
      );
      const id = newId("PRC");
      const keyHash = sha256Hex(`${input.scope}\n${input.key}`);
      run(
        "INSERT INTO purge_receipts (id, owner_id, subject_kind, preference_key_hash, revision_count, purged_scope, requested_by, " +
          "executed_at) VALUES (?, ?, 'preference', ?, ?, 'preferences', ?, ?)",
        id,
        owner,
        keyHash,
        revisionCount,
        input.requestedBy,
        input.now,
      );
      return {
        outcome: "purged",
        receipt: {
          id,
          preferenceKeyHash: keyHash,
          revisionCount,
          purgedScope: "preferences",
          requestedBy: input.requestedBy,
          executedAt: input.now,
        },
      };
    });

  const listPreferenceReceipts = (input: {
    principal: Principal;
    limit: number;
  }): PreferenceReceiptRow[] =>
    all(
      "SELECT id, preference_key_hash, revision_count, requested_by, executed_at FROM purge_receipts " +
        "WHERE owner_id = ? AND subject_kind = 'preference' ORDER BY executed_at DESC, id LIMIT ?",
      input.principal.ownerId,
      Math.max(1, Math.min(200, input.limit)),
    ).map((row) => ({
      id: String(row.id),
      preferenceKeyHash: String(row.preference_key_hash),
      revisionCount: Number(row.revision_count),
      purgedScope: "preferences" as const,
      requestedBy: String(row.requested_by),
      executedAt: Number(row.executed_at),
    }));

  return {
    kernel: {
      preferenceAgentSet,
      preferenceOperatorSet,
      preferenceGet,
      preferenceList,
      preferenceHistory,
      preferenceDelete,
      preferencePurge,
      listPreferenceReceipts,
    },
    hooks: { applyStatedInTx },
  };
}

export type PreferenceLedger = ReturnType<typeof createPreferenceLedger>;
