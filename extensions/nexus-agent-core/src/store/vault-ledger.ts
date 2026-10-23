/* oxlint-disable max-lines -- TODO: split this oversized file (one kernel/service unit per file for now). */
// Personal file vault kernel (Vault design sections 4-6), Stage 5. Runs inside the SQLite worker; every method is ONE
// synchronous transaction and every statement filters on owner_id. What is specific here:
//   * the write protocol R / W / P / C is split so no transaction ever spans file I/O: the service (src/vault/vault-service.ts)
//     does the bytes between `vaultReserve`, `vaultMarkWritten`, `vaultPlanPromote` / `vaultMarkPromoted` and `vaultCommit`;
//   * `vaultCommit` never trusts what P saw: it re-queries the live object for the content hash inside its own write
//     transaction, so two writers of the same bytes end with ONE object and two files, and the loser never sits in `promoted`;
//   * object ids are server-issued random ids (also the physical file name); the content hash is only a same-owner dedup key;
//   * files never own bytes: `vault_versions` rows are the reference count, objects are reclaimed only when no version row is
//     left (reclaim and hard purge live in the second half of this file).
import { sha256Hex } from "../canonical.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import {
  normalizeVaultFolder,
  normalizeVaultName,
  MAX_VAULT_LIST_LIMIT,
  VAULT_COLLECTIONS,
  type VaultCollection,
  type VaultCommitInput,
  type VaultCommitOutcome,
  type VaultDiscardInput,
  type VaultEditOutcome,
  type VaultFailReservationInput,
  type VaultFailReservationOutcome,
  type VaultFileRecord,
  type VaultFileState,
  type VaultFindByHashInput,
  type VaultFindByHashResult,
  type VaultGetInput,
  type VaultGetOutcome,
  type VaultKeepInput,
  type VaultListInput,
  type VaultListResult,
  type VaultMarkPromotedInput,
  type VaultMarkPromotedOutcome,
  type VaultMarkWrittenInput,
  type VaultMarkWrittenOutcome,
  type VaultMoveInput,
  type VaultPinInput,
  type VaultPlanPromoteInput,
  type VaultPlanPromoteOutcome,
  type VaultReadRefInput,
  type VaultReadRefOutcome,
  type VaultRenameInput,
  type VaultReserveInput,
  type VaultReserveOutcome,
  type VaultReservationState,
  type VaultRestoreInput,
  type VaultSensitivity,
  type VaultSensitivityBy,
  type VaultSetSensitivityInput,
  type VaultSource,
  type VaultStatsResult,
  type VaultTrashInput,
} from "./vault-types.js";

type Row = Record<string, unknown>;

const HASH = /^[0-9a-f]{64}$/;
const COMMIT_RETRIES = 3;

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);

const FILE_SELECT =
  "SELECT f.id, f.object_id, f.display_name, f.folder, f.collection, f.state, f.source, f.source_ref, f.sensitivity, " +
  "f.sensitivity_by, f.imported_by, f.created_at, f.updated_at, f.trashed_at, f.expires_at, o.size, o.mime, o.content_hash, " +
  "(SELECT COUNT(*) FROM vault_versions v WHERE v.owner_id = f.owner_id AND v.file_id = f.id) AS version_count, " +
  "u.pinned_at, u.favorite, u.last_opened_at " +
  "FROM vault_files f JOIN vault_objects o ON o.owner_id = f.owner_id AND o.id = f.object_id " +
  "LEFT JOIN vault_user_state u ON u.owner_id = f.owner_id AND u.file_id = f.id";

export function toVaultFile(row: Row): VaultFileRecord {
  return {
    id: String(row.id),
    objectId: String(row.object_id),
    displayName: String(row.display_name),
    folder: String(row.folder),
    collection: String(row.collection) as VaultCollection,
    state: String(row.state) as VaultFileState,
    source: String(row.source) as VaultSource,
    sourceRef: str(row.source_ref),
    sensitivity: String(row.sensitivity) as VaultSensitivity,
    sensitivityBy: String(row.sensitivity_by) as VaultSensitivityBy,
    importedBy: String(row.imported_by),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    trashedAt: num(row.trashed_at),
    expiresAt: num(row.expires_at),
    size: Number(row.size),
    mime: String(row.mime),
    contentHash: String(row.content_hash),
    versionCount: Number(row.version_count),
    pinnedAt: num(row.pinned_at),
    favorite: Number(row.favorite ?? 0) === 1,
    lastOpenedAt: num(row.last_opened_at),
  };
}

function isLiveHashViolation(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("UNIQUE constraint failed") &&
    message.includes("vault_objects.owner_id") &&
    message.includes("vault_objects.content_hash")
  );
}

export function createVaultLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const { one, all, run, newId } = internals;

  /**
   * Physical identifiers must not collide across owners (the directory is shared), so they are long (two random segments);
   * the reservation id doubles as the staging file name and the object id as the final one.
   */
  const longKey = (prefix: string): string => `${prefix}${newId("")}${newId("")}`;

  const reservationRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM vault_reservations WHERE owner_id = ? AND id = ?", owner, id);

  const fileRecord = (owner: string, fileId: string): VaultFileRecord | null => {
    const row = one(`${FILE_SELECT} WHERE f.owner_id = ? AND f.id = ?`, owner, fileId);
    return row ? toVaultFile(row) : null;
  };

  /** Physical bytes held by live + reclaiming objects of the owner (tombstones hold none). */
  const ownerObjectBytes = (owner: string): number =>
    Number(
      (
        one(
          "SELECT COALESCE(SUM(size), 0) AS b FROM vault_objects WHERE owner_id = ? AND state IN ('live','reclaiming')",
          owner,
        ) as Row
      ).b,
    );

  /** Bytes promised by reservations that have not settled; `exceptId` leaves one out (the one being updated). */
  const ownerReservedBytes = (owner: string, exceptId?: string): number =>
    Number(
      (
        one(
          "SELECT COALESCE(SUM(COALESCE(byte_size, expected_size, 0)), 0) AS b FROM vault_reservations " +
            "WHERE owner_id = ? AND state IN ('reserved','written','promoted') AND id <> ?",
          owner,
          exceptId ?? "",
        ) as Row
      ).b,
    );

  // ------------------------------------------------------------------ R: reserve

  const vaultReserve = (input: VaultReserveInput): VaultReserveOutcome =>
    transaction((): VaultReserveOutcome => {
      const owner = input.principal.ownerId;
      const incarnation = one(
        "SELECT incarnation_id FROM process_incarnations WHERE incarnation_id = ? AND gone_at IS NULL",
        input.incarnationId,
      );
      if (!incarnation) {
        return { outcome: "writer_unregistered" };
      }
      const expected =
        input.expectedSize === null || input.expectedSize === undefined
          ? null
          : Math.max(0, Math.floor(input.expectedSize));
      if (expected !== null && expected > input.limits.maxFileBytes) {
        return {
          outcome: "quota_exceeded",
          scope: "file",
          limit: input.limits.maxFileBytes,
          used: 0,
          requested: expected,
        };
      }
      const used = ownerObjectBytes(owner) + ownerReservedBytes(owner);
      const requested = expected ?? 0;
      if (used + requested > input.limits.ownerQuotaBytes || used >= input.limits.ownerQuotaBytes) {
        return {
          outcome: "quota_exceeded",
          scope: "owner",
          limit: input.limits.ownerQuotaBytes,
          used,
          requested,
        };
      }
      const id = longKey("VR");
      const newObjectId = longKey("");
      const expiresAt = input.now + input.ttlMs;
      run(
        "INSERT INTO vault_reservations (owner_id, id, new_object_id, staging_path_key, expected_size, content_hash, byte_size, " +
          "result_object_id, writer_attempt_id, writer_incarnation, state, created_at, updated_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, 'reserved', ?, ?, ?)",
        owner,
        id,
        newObjectId,
        id,
        expected,
        input.writerAttemptId,
        input.incarnationId,
        input.now,
        input.now,
        expiresAt,
      );
      return { outcome: "reserved", reservation: { id, newObjectId, stagingKey: id, expiresAt } };
    });

  // ------------------------------------------------------------------ W: bytes are on disk

  const vaultMarkWritten = (input: VaultMarkWrittenInput): VaultMarkWrittenOutcome =>
    transaction((): VaultMarkWrittenOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const state = String(row.state) as VaultReservationState;
      if (state !== "reserved") {
        return { outcome: "wrong_state", state };
      }
      if (
        !HASH.test(input.contentHash) ||
        !Number.isSafeInteger(input.byteSize) ||
        input.byteSize < 0
      ) {
        return { outcome: "invalid" };
      }
      if (input.byteSize > input.limits.maxFileBytes) {
        return {
          outcome: "quota_exceeded",
          scope: "file",
          limit: input.limits.maxFileBytes,
          used: 0,
          requested: input.byteSize,
        };
      }
      const used = ownerObjectBytes(owner) + ownerReservedBytes(owner, input.reservationId);
      if (used + input.byteSize > input.limits.ownerQuotaBytes) {
        return {
          outcome: "quota_exceeded",
          scope: "owner",
          limit: input.limits.ownerQuotaBytes,
          used,
          requested: input.byteSize,
        };
      }
      run(
        "UPDATE vault_reservations SET state = 'written', content_hash = ?, byte_size = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state = 'reserved'",
        input.contentHash,
        input.byteSize,
        input.now,
        owner,
        input.reservationId,
      );
      return { outcome: "written" };
    });

  /** Only `reserved` / `written` can be failed here: a `promoted` file is owned by recovery (it may have a physical file). */
  const vaultFailReservation = (input: VaultFailReservationInput): VaultFailReservationOutcome =>
    transaction((): VaultFailReservationOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const changed = run(
        "UPDATE vault_reservations SET state = 'failed', updated_at = ? WHERE owner_id = ? AND id = ? AND state IN ('reserved','written')",
        input.now,
        owner,
        input.reservationId,
      );
      return changed > 0
        ? { outcome: "failed" }
        : { outcome: "wrong_state", state: String(row.state) as VaultReservationState };
    });

  // ------------------------------------------------------------------ P: promote

  const liveObjectByHash = (owner: string, contentHash: string): Row | undefined =>
    one(
      "SELECT id FROM vault_objects WHERE owner_id = ? AND content_hash = ? AND state = 'live'",
      owner,
      contentHash,
    );

  const vaultPlanPromote = (input: VaultPlanPromoteInput): VaultPlanPromoteOutcome =>
    transaction((): VaultPlanPromoteOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const state = String(row.state) as VaultReservationState;
      if (state !== "written") {
        return { outcome: "wrong_state", state };
      }
      const winner = liveObjectByHash(owner, String(row.content_hash));
      if (winner) {
        return { outcome: "reuse", objectId: String(winner.id) };
      }
      return {
        outcome: "promote",
        newObjectId: String(row.new_object_id),
        stagingKey: String(row.staging_path_key),
      };
    });

  const vaultMarkPromoted = (input: VaultMarkPromotedInput): VaultMarkPromotedOutcome =>
    transaction((): VaultMarkPromotedOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const changed = run(
        "UPDATE vault_reservations SET state = 'promoted', updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'written'",
        input.now,
        owner,
        input.reservationId,
      );
      return changed > 0
        ? { outcome: "promoted" }
        : { outcome: "wrong_state", state: String(row.state) as VaultReservationState };
    });

  // ------------------------------------------------------------------ C: commit (dedup-aware)

  const commitOnce = (input: VaultCommitInput): VaultCommitOutcome =>
    transaction((): VaultCommitOutcome => {
      const owner = input.principal.ownerId;
      const row = reservationRow(owner, input.reservationId);
      if (!row) {
        return { outcome: "not_found" };
      }
      const state = String(row.state) as VaultReservationState;
      // 1. only written / promoted can commit; anything else is a safe repeat
      if (state !== "written" && state !== "promoted") {
        return { outcome: "noop", state };
      }
      const name = normalizeVaultName(input.file.displayName);
      if (name === null) {
        return { outcome: "invalid", reason: "name" };
      }
      const folder = normalizeVaultFolder(input.file.folder ?? "");
      if (folder === null) {
        return { outcome: "invalid", reason: "folder" };
      }
      if (!VAULT_COLLECTIONS.includes(input.file.collection)) {
        return { outcome: "invalid", reason: "collection" };
      }
      // 2. ask again who the winner is: what P saw may be stale
      const winner = liveObjectByHash(owner, String(row.content_hash));
      let objectId: string;
      let newObject: boolean;
      let loser: { newObjectId: string; stagingKey: string } | null = null;
      if (winner) {
        // 3. reuse the winner; a promoted reservation's own physical file becomes the failed side
        objectId = String(winner.id);
        newObject = false;
        if (state === "promoted") {
          loser = {
            newObjectId: String(row.new_object_id),
            stagingKey: String(row.staging_path_key),
          };
        }
      } else {
        // 4. no winner: only a promoted reservation has a physical file to account for
        if (state === "written") {
          return { outcome: "need_promote" };
        }
        objectId = String(row.new_object_id);
        newObject = true;
        run(
          "INSERT INTO vault_objects (owner_id, id, reservation_id, content_hash, size, mime, state, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?)",
          owner,
          objectId,
          input.reservationId,
          String(row.content_hash),
          Number(row.byte_size),
          input.mime,
          input.now,
          input.now,
        );
      }
      const fileId = newId("VF");
      const inbox = input.file.collection === "inbox";
      run(
        "INSERT INTO vault_files (owner_id, id, object_id, display_name, folder, collection, state, source, source_ref, " +
          "sensitivity, sensitivity_by, imported_by, created_at, updated_at, trashed_at, expires_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, NULL, ?)",
        owner,
        fileId,
        objectId,
        name,
        folder,
        input.file.collection,
        input.file.source,
        input.file.sourceRef ?? null,
        input.file.sensitivity ?? "normal",
        input.file.sensitivityBy ?? "rule",
        input.file.importedBy,
        input.now,
        input.now,
        inbox ? input.now + input.inboxRetentionMs : null,
      );
      run(
        "INSERT INTO vault_versions (owner_id, file_id, seq, object_id, created_at) VALUES (?, ?, 1, ?, ?)",
        owner,
        fileId,
        objectId,
        input.now,
      );
      run(
        "UPDATE vault_reservations SET state = 'committed', result_object_id = ?, updated_at = ? " +
          "WHERE owner_id = ? AND id = ? AND state IN ('written','promoted')",
        objectId,
        input.now,
        owner,
        input.reservationId,
      );
      return { outcome: "committed", fileId, objectId, newObject, loser };
    });

  const vaultCommit = (input: VaultCommitInput): VaultCommitOutcome => {
    // 5. a violation of the live-hash index cannot happen inside one connection's write transaction; if it ever does
    //    (second connection, defect) the whole transaction rolled back and the retry necessarily lands in the reuse branch.
    for (let attempt = 1; ; attempt += 1) {
      try {
        return commitOnce(input);
      } catch (error) {
        if (!isLiveHashViolation(error) || attempt >= COMMIT_RETRIES) {
          throw error;
        }
      }
    }
  };

  // ------------------------------------------------------------------ reads

  const vaultGet = (input: VaultGetInput): VaultGetOutcome => {
    const file = fileRecord(input.principal.ownerId, input.fileId);
    return file ? { outcome: "ok", file } : { outcome: "not_found" };
  };

  const vaultList = (input: VaultListInput): VaultListResult => {
    const owner = input.principal.ownerId;
    const where: string[] = ["f.owner_id = ?"];
    const params: (string | number)[] = [owner];
    where.push("f.state = ?");
    params.push(input.state ?? "active");
    if (input.collection) {
      where.push("f.collection = ?");
      params.push(input.collection);
    }
    if (input.folder !== undefined) {
      const folder = normalizeVaultFolder(input.folder);
      if (folder === null) {
        return { items: [], total: 0 };
      }
      where.push("f.folder = ?");
      params.push(folder);
    }
    if (input.nameContains && input.nameContains.trim() !== "") {
      where.push("instr(lower(f.display_name), lower(?)) > 0");
      params.push(input.nameContains.trim());
    }
    if (input.includeSensitive === false) {
      where.push("f.sensitivity = 'normal'");
    }
    const limit = Math.min(Math.max(Math.floor(input.limit ?? 50), 1), MAX_VAULT_LIST_LIMIT);
    const offset = Math.max(Math.floor(input.offset ?? 0), 0);
    const total = Number(
      (
        one(
          `SELECT COUNT(*) AS c FROM vault_files f WHERE ${where.join(" AND ")}`,
          ...params,
        ) as Row
      ).c,
    );
    const order = input.pinnedFirst
      ? "(u.pinned_at IS NULL), u.pinned_at DESC, f.updated_at DESC, f.id"
      : "f.updated_at DESC, f.id";
    const rows = all(
      `${FILE_SELECT} WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
      ...params,
      limit,
      offset,
    );
    return { items: rows.map(toVaultFile), total };
  };

  const vaultStats = (input: { principal: Principal }): VaultStatsResult => {
    const owner = input.principal.ownerId;
    const files: Record<string, number> = {};
    for (const row of all(
      "SELECT collection, state, COUNT(*) AS c FROM vault_files WHERE owner_id = ? GROUP BY collection, state",
      owner,
    )) {
      files[`${String(row.collection)}:${String(row.state)}`] = Number(row.c);
    }
    const objects = Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM vault_objects WHERE owner_id = ? AND state IN ('live','reclaiming')",
          owner,
        ) as Row
      ).c,
    );
    return {
      files,
      objectBytes: ownerObjectBytes(owner),
      reservedBytes: ownerReservedBytes(owner),
      objects,
    };
  };

  const vaultFindByHash = (input: VaultFindByHashInput): VaultFindByHashResult => {
    const owner = input.principal.ownerId;
    const object = liveObjectByHash(owner, input.contentHash);
    if (!object) {
      return { objectId: null, files: [] };
    }
    const rows = all(
      "SELECT id, display_name, folder, collection, state FROM vault_files " +
        "WHERE owner_id = ? AND object_id = ? AND state IN ('active','trashed') ORDER BY created_at, id",
      owner,
      String(object.id),
    );
    return {
      objectId: String(object.id),
      files: rows.map((row) => ({
        id: String(row.id),
        displayName: String(row.display_name),
        folder: String(row.folder),
        collection: String(row.collection) as VaultCollection,
        state: String(row.state) as VaultFileState,
      })),
    };
  };

  const vaultReadRef = (input: VaultReadRefInput): VaultReadRefOutcome =>
    transaction((): VaultReadRefOutcome => {
      const owner = input.principal.ownerId;
      const file = fileRecord(owner, input.fileId);
      if (!file) {
        return { outcome: "not_found" };
      }
      const readable =
        file.state === "active" || (input.allowTrashed === true && file.state === "trashed");
      if (!readable) {
        return { outcome: "not_readable", state: file.state };
      }
      if (input.touchAt !== undefined) {
        run(
          "INSERT INTO vault_user_state (owner_id, file_id, last_opened_at) VALUES (?, ?, ?) " +
            "ON CONFLICT (owner_id, file_id) DO UPDATE SET last_opened_at = excluded.last_opened_at",
          owner,
          input.fileId,
          input.touchAt,
        );
      }
      return {
        outcome: "ok",
        fileId: file.id,
        objectId: file.objectId,
        size: file.size,
        mime: file.mime,
        displayName: file.displayName,
        contentHash: file.contentHash,
        sensitivity: file.sensitivity,
      };
    });

  // ------------------------------------------------------------------ lifecycle edits (state machine, Vault design 4.3)

  type EditSpec = {
    principal: Principal;
    fileId: string;
    now: number;
  };
  /** Shared shape: load, check the allowed state, apply, return the fresh record. */
  const edit = (
    spec: EditSpec,
    allowed: (file: VaultFileRecord) => boolean,
    apply: (file: VaultFileRecord, owner: string) => void,
  ): VaultEditOutcome =>
    transaction((): VaultEditOutcome => {
      const owner = spec.principal.ownerId;
      const file = fileRecord(owner, spec.fileId);
      if (!file) {
        return { outcome: "not_found" };
      }
      if (!allowed(file)) {
        return { outcome: "wrong_state", state: file.state, collection: file.collection };
      }
      apply(file, spec.principal.ownerId);
      return { outcome: "ok", file: fileRecord(owner, spec.fileId) as VaultFileRecord };
    });

  /** inbox -> vault: the user keeps it (an explicit act; nothing enters the vault by itself). */
  const vaultKeep = (input: VaultKeepInput): VaultEditOutcome => {
    let folder = "";
    if (input.folder !== undefined) {
      const normalized = normalizeVaultFolder(input.folder);
      if (normalized === null) {
        return { outcome: "invalid", reason: "folder" };
      }
      folder = normalized;
    }
    return edit(
      input,
      (file) => file.state === "active" && file.collection === "inbox",
      (file, owner) => {
        run(
          "UPDATE vault_files SET collection = 'vault', expires_at = NULL, folder = ?, updated_at = ? " +
            "WHERE owner_id = ? AND id = ? AND state = 'active' AND collection = 'inbox'",
          input.folder === undefined ? file.folder : folder,
          input.now,
          owner,
          file.id,
        );
      },
    );
  };

  const trashFile = (spec: EditSpec, onlyInbox: boolean): VaultEditOutcome =>
    edit(
      spec,
      (file) => file.state === "active" && (!onlyInbox || file.collection === "inbox"),
      (file, owner) => {
        run(
          "UPDATE vault_files SET state = 'trashed', trashed_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'active'",
          spec.now,
          spec.now,
          owner,
          file.id,
        );
      },
    );

  /** inbox -> trashed (the user discards it, or it is cleaned up after expiry). */
  const vaultDiscard = (input: VaultDiscardInput): VaultEditOutcome => trashFile(input, true);
  const vaultTrash = (input: VaultTrashInput): VaultEditOutcome => trashFile(input, false);

  const vaultRestore = (input: VaultRestoreInput): VaultEditOutcome =>
    edit(
      input,
      (file) => file.state === "trashed",
      (file, owner) => {
        run(
          "UPDATE vault_files SET state = 'active', trashed_at = NULL, updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'trashed'",
          input.now,
          owner,
          file.id,
        );
      },
    );

  const vaultRename = (input: VaultRenameInput): VaultEditOutcome => {
    const name = normalizeVaultName(input.displayName);
    if (name === null) {
      return { outcome: "invalid", reason: "name" };
    }
    return edit(
      input,
      (file) => file.state === "active",
      (file, owner) => {
        run(
          "UPDATE vault_files SET display_name = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'active'",
          name,
          input.now,
          owner,
          file.id,
        );
      },
    );
  };

  const vaultMove = (input: VaultMoveInput): VaultEditOutcome => {
    const folder = normalizeVaultFolder(input.folder);
    if (folder === null) {
      return { outcome: "invalid", reason: "folder" };
    }
    return edit(
      input,
      (file) => file.state === "active",
      (file, owner) => {
        run(
          "UPDATE vault_files SET folder = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND state = 'active'",
          folder,
          input.now,
          owner,
          file.id,
        );
      },
    );
  };

  const vaultSetSensitivity = (input: VaultSetSensitivityInput): VaultEditOutcome =>
    edit(
      input,
      (file) => file.state === "active" || file.state === "trashed",
      (file, owner) => {
        run(
          "UPDATE vault_files SET sensitivity = ?, sensitivity_by = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
          input.sensitivity,
          input.by,
          input.now,
          owner,
          file.id,
        );
      },
    );

  /** Pin / favorite live in their own table (they never affect access). Omitted fields are left as they are. */
  const vaultPin = (input: VaultPinInput): VaultEditOutcome =>
    edit(
      input,
      (file) => file.state === "active",
      (file, owner) => {
        run(
          "INSERT INTO vault_user_state (owner_id, file_id) VALUES (?, ?) ON CONFLICT (owner_id, file_id) DO NOTHING",
          owner,
          file.id,
        );
        if (input.pinned !== undefined) {
          run(
            "UPDATE vault_user_state SET pinned_at = ? WHERE owner_id = ? AND file_id = ?",
            input.pinned ? input.now : null,
            owner,
            file.id,
          );
        }
        if (input.favorite !== undefined) {
          run(
            "UPDATE vault_user_state SET favorite = ? WHERE owner_id = ? AND file_id = ?",
            input.favorite ? 1 : 0,
            owner,
            file.id,
          );
        }
      },
    );

  return {
    vaultReserve,
    vaultMarkWritten,
    vaultFailReservation,
    vaultPlanPromote,
    vaultMarkPromoted,
    vaultCommit,
    vaultGet,
    vaultList,
    vaultStats,
    vaultFindByHash,
    vaultReadRef,
    vaultKeep,
    vaultDiscard,
    vaultTrash,
    vaultRestore,
    vaultRename,
    vaultMove,
    vaultSetSensitivity,
    vaultPin,
  };
}

export type VaultLedger = ReturnType<typeof createVaultLedger>;
// kept for the second half of this file (hash helpers are shared with reclaim and purge)
export const vaultReceiptFileHash = (ownerId: string, fileId: string): string =>
  sha256Hex(`vault-file:${ownerId}:${fileId}`);
