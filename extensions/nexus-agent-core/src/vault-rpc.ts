// Gateway RPC for the personal file vault (Vault design 7.2). Reads are operator.read, edits and uploads operator.write, the
// hard purge is operator.admin and needs the file id typed twice. File bytes travel through these methods (base64), never
// through a model tool parameter; an Agent has its own, much smaller tool surface (src/tools/file-tools.ts).
import os from "node:os";
import path from "node:path";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { EventBridge, VaultChangedPayload } from "./events.js";
import type { Principal } from "./store/types.js";
import type { VaultExtractionStatus } from "./store/vault-text-types.js";
import {
  VAULT_COLLECTIONS,
  VAULT_FILE_STATES,
  VAULT_SENSITIVITIES,
  type VaultCollection,
  type VaultEditOutcome,
  type VaultFileState,
  type VaultSensitivity,
} from "./store/vault-types.js";
import { createVaultHistoryRpcEntries } from "./vault-history-rpc.js";
import { parseFileKind } from "./vault-kind.js";
import { createVaultTextRpcEntries } from "./vault-text-rpc.js";
import { VAULT_UPLOAD_MAX_BYTES } from "./vault-ui.js";
import type { VaultService, VaultStore } from "./vault/vault-service.js";

/** One RPC upload carries the whole file as base64; larger files come in through importPath. */
export const VAULT_RPC_UPLOAD_MAX_BYTES = VAULT_UPLOAD_MAX_BYTES;
export { VAULT_RPC_READ_MAX_BYTES } from "./vault-history-rpc.js";
export const VAULT_OPERATOR_ACTOR = "operator:console";

/** A leading `~` or `~/` means the home directory of the gateway user; everything else is passed through unchanged. */
export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export type VaultRpcDeps = {
  getStore: () => Promise<VaultStore>;
  service: Pick<
    VaultService,
    | "ingest"
    | "importPath"
    | "read"
    | "purge"
    | "maintain"
    | "extract"
    | "replace"
    | "restoreVersion"
  >;
  events: Pick<EventBridge, "vaultChanged">;
  resolvePrincipal: () => Principal | undefined;
  /** The configured single-file limit; an upload above min(this, VAULT_RPC_UPLOAD_MAX_BYTES) is refused before decoding. */
  maxFileBytes: () => number;
  now?: () => number;
};

type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;
type Respond = GatewayRequestHandlerOptions["respond"];

const ID = /^[A-Za-z0-9_-]{1,64}$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

function reject(
  respond: Respond,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
) {
  respond(false, undefined, {
    code,
    message,
    ...(Object.keys(extra).length ? { details: extra } : {}),
  });
}

function readId(raw: unknown): string | undefined {
  return typeof raw === "string" && ID.test(raw) ? raw : undefined;
}

/** Strict base64 with a size cap that is checked from the encoded length BEFORE any allocation. */
export function decodeVaultBase64(
  raw: unknown,
  maxBytes: number,
): Uint8Array | "invalid" | "too_large" {
  if (typeof raw !== "string" || raw.length === 0 || raw.length % 4 !== 0 || !BASE64.test(raw)) {
    return "invalid";
  }
  const padding = raw.endsWith("==") ? 2 : raw.endsWith("=") ? 1 : 0;
  if ((raw.length / 4) * 3 - padding > maxBytes) {
    return "too_large";
  }
  return Buffer.from(raw, "base64");
}

function readCollection(raw: unknown): VaultCollection | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  return typeof raw === "string" && (VAULT_COLLECTIONS as readonly string[]).includes(raw)
    ? (raw as VaultCollection)
    : "invalid";
}

export function createVaultRpcHandlers(deps: VaultRpcDeps) {
  const now = deps.now ?? Date.now;
  const guarded =
    (
      run: (args: {
        principal: Principal;
        store: VaultStore;
        params: Record<string, unknown>;
        respond: Respond;
      }) => Promise<void>,
    ): GatewayRequestHandler =>
    async ({ params, respond }) => {
      const principal = deps.resolvePrincipal();
      if (!principal) {
        reject(respond, "nexus_no_principal", "cannot resolve the owner");
        return;
      }
      try {
        await run({ principal, store: await deps.getStore(), params: params ?? {}, respond });
      } catch (error) {
        reject(
          respond,
          "nexus_store_error",
          error instanceof Error ? error.message : String(error),
        );
      }
    };

  const emit = (principal: Principal, change: Omit<VaultChangedPayload, "ownerId">) => {
    deps.events.vaultChanged({ ownerId: principal.ownerId, ...change });
  };

  /** Extraction state per file id, for the console's badge. Sensitive files report `skipped` and nothing else. */
  const extractionFor = async (
    store: VaultStore,
    principal: Principal,
    files: { id: string; objectId: string }[],
  ): Promise<Record<string, VaultExtractionStatus>> => {
    if (files.length === 0) {
      return {};
    }
    const { byObject } = await store.vaultExtractionStatus({
      principal,
      objectIds: [...new Set(files.map((file) => file.objectId))],
    });
    const out: Record<string, VaultExtractionStatus> = {};
    for (const file of files) {
      const status = byObject[file.objectId];
      if (status) {
        out[file.id] = status;
      }
    }
    return out;
  };

  const needFileId = (params: Record<string, unknown>, respond: Respond): string | undefined => {
    const fileId = readId(params.fileId);
    if (!fileId) {
      reject(respond, "nexus_invalid_params", "fileId is required");
    }
    return fileId;
  };

  /** Answers for every lifecycle edit; returns true when the edit applied. */
  const answerEdit = (
    respond: Respond,
    principal: Principal,
    out: VaultEditOutcome,
    action: VaultChangedPayload["action"],
  ): void => {
    switch (out.outcome) {
      case "not_found":
        reject(respond, "nexus_not_found", "file not found");
        return;
      case "wrong_state":
        reject(
          respond,
          "nexus_conflict",
          `not allowed in this state (${out.state}, ${out.collection})`,
          {
            state: out.state,
            collection: out.collection,
          },
        );
        return;
      case "invalid":
        reject(respond, "nexus_invalid_params", `${out.reason} is not valid`);
        return;
      case "ok":
        emit(principal, { fileId: out.file.id, action, collection: out.file.collection });
        respond(true, { ownerId: principal.ownerId, file: out.file });
    }
  };

  /** Edits that take only a file id. */
  const simpleEdit = (
    method: string,
    action: VaultChangedPayload["action"],
    call: (
      store: VaultStore,
      principal: Principal,
      fileId: string,
      t: number,
    ) => Promise<VaultEditOutcome>,
  ) =>
    [
      method,
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        answerEdit(respond, principal, await call(store, principal, fileId, now()), action);
      }),
      "operator.write",
    ] as const;

  return [
    [
      "nexus.vault.list",
      guarded(async ({ principal, store, params, respond }) => {
        const collection = readCollection(params.collection);
        if (collection === "invalid") {
          reject(respond, "nexus_invalid_params", "collection must be inbox|vault|deliverable");
          return;
        }
        if (
          params.state !== undefined &&
          !(
            typeof params.state === "string" &&
            (VAULT_FILE_STATES as readonly string[]).includes(params.state)
          )
        ) {
          reject(respond, "nexus_invalid_params", "state must be active|trashed|purging|damaged");
          return;
        }
        if (params.folder !== undefined && typeof params.folder !== "string") {
          reject(respond, "nexus_invalid_params", "folder must be text");
          return;
        }
        if (params.nameContains !== undefined && typeof params.nameContains !== "string") {
          reject(respond, "nexus_invalid_params", "nameContains must be text");
          return;
        }
        const kind = parseFileKind(params.kind);
        if (params.kind !== undefined && kind === undefined) {
          reject(respond, "nexus_invalid_params", "kind must be text|image|pdf|office|other");
          return;
        }
        if (params.favorite !== undefined && typeof params.favorite !== "boolean") {
          reject(respond, "nexus_invalid_params", "favorite must be true or false");
          return;
        }
        if (
          params.sensitivity !== undefined &&
          !(
            typeof params.sensitivity === "string" &&
            (VAULT_SENSITIVITIES as readonly string[]).includes(params.sensitivity)
          )
        ) {
          reject(respond, "nexus_invalid_params", "sensitivity must be normal|sensitive");
          return;
        }
        const result = await store.vaultList({
          principal,
          ...(collection ? { collection } : {}),
          ...(kind ? { kind } : {}),
          ...(params.favorite === true ? { favoriteOnly: true } : {}),
          ...(typeof params.sensitivity === "string"
            ? { sensitivity: params.sensitivity as VaultSensitivity }
            : {}),
          ...(typeof params.state === "string" ? { state: params.state as VaultFileState } : {}),
          ...(typeof params.folder === "string" ? { folder: params.folder } : {}),
          ...(typeof params.nameContains === "string" ? { nameContains: params.nameContains } : {}),
          pinnedFirst: params.pinnedFirst !== false,
          limit: Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200),
          offset: Math.max(Number(params.offset ?? 0) || 0, 0),
        });
        respond(true, {
          ownerId: principal.ownerId,
          ...result,
          extraction: await extractionFor(store, principal, result.items),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.get",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const got = await store.vaultGet({ principal, fileId });
        if (got.outcome === "not_found") {
          reject(respond, "nexus_not_found", "file not found");
          return;
        }
        respond(true, {
          ownerId: principal.ownerId,
          file: got.file,
          extraction: (await extractionFor(store, principal, [got.file]))[got.file.id] ?? null,
        });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.stats",
      guarded(async ({ principal, store, respond }) => {
        respond(true, {
          ownerId: principal.ownerId,
          ...(await store.vaultStats({ principal })),
          text: await store.vaultTextStats({ principal }),
        });
      }),
      "operator.read",
    ],
    ...createVaultHistoryRpcEntries({
      service: deps.service,
      uploadLimit: () => Math.min(deps.maxFileBytes(), VAULT_RPC_UPLOAD_MAX_BYTES),
      decode: decodeVaultBase64,
      answerIngest,
      actor: VAULT_OPERATOR_ACTOR,
      guarded,
      reject,
      needFileId,
    }),
    ...createVaultTextRpcEntries({
      service: deps.service,
      now,
      guarded,
      reject,
      readCollection,
      needFileId,
      extractionFor,
      emit,
    }),
    [
      "nexus.vault.purgeStatus",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        respond(true, {
          ownerId: principal.ownerId,
          status: await store.vaultPurgeStatus({ principal, fileId }),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.purgeReceipts",
      guarded(async ({ principal, store, params, respond }) => {
        const limit = Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200);
        respond(true, {
          ownerId: principal.ownerId,
          ...(await store.vaultPurgeReceipts({ principal, limit })),
        });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.upload",
      guarded(async ({ principal, params, respond }) => {
        const collection = readCollection(params.collection);
        if (collection === "invalid") {
          reject(respond, "nexus_invalid_params", "collection must be inbox|vault|deliverable");
          return;
        }
        if (typeof params.name !== "string") {
          reject(respond, "nexus_invalid_params", "name is required");
          return;
        }
        if (params.folder !== undefined && typeof params.folder !== "string") {
          reject(respond, "nexus_invalid_params", "folder must be text");
          return;
        }
        const limit = Math.min(deps.maxFileBytes(), VAULT_RPC_UPLOAD_MAX_BYTES);
        const bytes = decodeVaultBase64(params.dataBase64, limit);
        if (bytes === "too_large") {
          reject(respond, "nexus_quota_exceeded", "upload exceeds the single-file limit", {
            scope: "file",
            limit,
          });
          return;
        }
        if (bytes === "invalid") {
          reject(
            respond,
            "nexus_invalid_params",
            "dataBase64 must be non-empty, strictly valid base64",
          );
          return;
        }
        const out = await deps.service.ingest(principal, {
          displayName: params.name,
          bytes,
          expectedSize: bytes.byteLength,
          source: "upload",
          ...(collection ? { collection } : {}),
          ...(typeof params.folder === "string" ? { folder: params.folder } : {}),
          importedBy: VAULT_OPERATOR_ACTOR,
        });
        answerIngest(respond, principal, out);
      }),
      "operator.write",
    ],
    [
      "nexus.vault.importPath",
      guarded(async ({ principal, params, respond }) => {
        const collection = readCollection(params.collection);
        if (collection === "invalid") {
          reject(respond, "nexus_invalid_params", "collection must be inbox|vault|deliverable");
          return;
        }
        if (
          typeof params.path !== "string" ||
          params.path.length === 0 ||
          params.path.length > 4096
        ) {
          reject(respond, "nexus_invalid_params", "path is required");
          return;
        }
        if (params.folder !== undefined && typeof params.folder !== "string") {
          reject(respond, "nexus_invalid_params", "folder must be text");
          return;
        }
        if (params.displayName !== undefined && typeof params.displayName !== "string") {
          reject(respond, "nexus_invalid_params", "displayName must be text");
          return;
        }
        const out = await deps.service.importPath(principal, {
          path: expandHome(params.path),
          importedBy: VAULT_OPERATOR_ACTOR,
          ...(collection ? { collection } : {}),
          ...(typeof params.folder === "string" ? { folder: params.folder } : {}),
          ...(typeof params.displayName === "string" ? { displayName: params.displayName } : {}),
        });
        if (out.outcome === "refused") {
          reject(respond, "nexus_import_refused", `import refused: ${out.reason}`, {
            reason: out.reason,
          });
          return;
        }
        answerIngest(respond, principal, out);
      }),
      "operator.write",
    ],
    [
      "nexus.vault.keep",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        if (params.folder !== undefined && typeof params.folder !== "string") {
          reject(respond, "nexus_invalid_params", "folder must be text");
          return;
        }
        answerEdit(
          respond,
          principal,
          await store.vaultKeep({
            principal,
            fileId,
            now: now(),
            ...(typeof params.folder === "string" ? { folder: params.folder } : {}),
          }),
          "kept",
        );
      }),
      "operator.write",
    ],
    simpleEdit("nexus.vault.discard", "discarded", (store, principal, fileId, t) =>
      store.vaultDiscard({ principal, fileId, now: t }),
    ),
    simpleEdit("nexus.vault.trash", "trashed", (store, principal, fileId, t) =>
      store.vaultTrash({ principal, fileId, now: t }),
    ),
    simpleEdit("nexus.vault.restore", "restored", (store, principal, fileId, t) =>
      store.vaultRestore({ principal, fileId, now: t }),
    ),
    [
      "nexus.vault.rename",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        if (typeof params.displayName !== "string") {
          reject(respond, "nexus_invalid_params", "displayName is required");
          return;
        }
        answerEdit(
          respond,
          principal,
          await store.vaultRename({
            principal,
            fileId,
            now: now(),
            displayName: params.displayName,
          }),
          "renamed",
        );
      }),
      "operator.write",
    ],
    [
      "nexus.vault.move",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        if (typeof params.folder !== "string") {
          reject(respond, "nexus_invalid_params", "folder is required (empty text = top level)");
          return;
        }
        answerEdit(
          respond,
          principal,
          await store.vaultMove({ principal, fileId, now: now(), folder: params.folder }),
          "moved",
        );
      }),
      "operator.write",
    ],
    [
      "nexus.vault.pin",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        if (
          (params.pinned !== undefined && typeof params.pinned !== "boolean") ||
          (params.favorite !== undefined && typeof params.favorite !== "boolean") ||
          (params.pinned === undefined && params.favorite === undefined)
        ) {
          reject(respond, "nexus_invalid_params", "pinned and/or favorite (booleans) is required");
          return;
        }
        answerEdit(
          respond,
          principal,
          await store.vaultPin({
            principal,
            fileId,
            now: now(),
            ...(typeof params.pinned === "boolean" ? { pinned: params.pinned } : {}),
            ...(typeof params.favorite === "boolean" ? { favorite: params.favorite } : {}),
          }),
          "pinned",
        );
      }),
      "operator.write",
    ],
    [
      "nexus.vault.setSensitivity",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        if (
          typeof params.sensitivity !== "string" ||
          !(VAULT_SENSITIVITIES as readonly string[]).includes(params.sensitivity)
        ) {
          reject(respond, "nexus_invalid_params", "sensitivity must be normal|sensitive");
          return;
        }
        answerEdit(
          respond,
          principal,
          await store.vaultSetSensitivity({
            principal,
            fileId,
            now: now(),
            sensitivity: params.sensitivity as "normal" | "sensitive",
            by: "operator",
          }),
          "sensitivity",
        );
      }),
      "operator.write",
    ],
    [
      "nexus.vault.maintain",
      guarded(async ({ principal, respond }) => {
        respond(true, {
          ownerId: principal.ownerId,
          report: await deps.service.maintain(principal),
        });
      }),
      "operator.write",
    ],
    [
      "nexus.vault.purge",
      guarded(async ({ principal, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        if (params.confirmFileId !== fileId) {
          reject(
            respond,
            "nexus_invalid_params",
            "purge is irreversible: confirmFileId must repeat fileId exactly",
          );
          return;
        }
        const out = await deps.service.purge(principal, fileId, VAULT_OPERATOR_ACTOR);
        switch (out.outcome) {
          case "not_found":
            reject(respond, "nexus_not_found", "file not found");
            return;
          case "invalid_state":
            reject(respond, "nexus_conflict", `a file in state ${out.state} cannot be purged`, {
              state: out.state,
            });
            return;
          case "worker_active":
            reject(respond, "nexus_conflict", "a purge of this file is already running", {
              purgeId: out.purgeId,
              leaseUntil: out.leaseUntil,
            });
            return;
          case "lost_lease":
            reject(
              respond,
              "nexus_conflict",
              "the purge was taken over by another worker; check purgeStatus",
              {
                purgeId: out.purgeId,
              },
            );
            return;
          case "cleanup_pending":
            // Not an error: the purge is recorded and resumes on the next maintenance pass.
            respond(true, {
              ownerId: principal.ownerId,
              outcome: "cleanup_pending",
              purgeId: out.purgeId,
              blockers: out.blockers,
            });
            return;
          case "purged":
            respond(true, { ownerId: principal.ownerId, outcome: "purged", receipt: out.receipt });
        }
      }),
      "operator.admin",
    ],
  ] as const;

  function answerIngest(
    respond: Respond,
    principal: Principal,
    out: Awaited<ReturnType<VaultRpcDeps["service"]["ingest"]>>,
  ): void {
    switch (out.outcome) {
      case "ok":
        // The service already published vault_changed for the new entry.
        respond(true, {
          ownerId: principal.ownerId,
          file: out.file,
          deduplicated: out.deduplicated,
          ...(out.replaced ? { replaced: out.replaced } : {}),
        });
        return;
      case "invalid":
        reject(respond, "nexus_invalid_params", `${out.reason} is not valid`);
        return;
      case "quota_exceeded":
        reject(respond, "nexus_quota_exceeded", "the vault quota would be exceeded", {
          scope: out.scope,
          limit: out.limit,
          used: out.used,
          requested: out.requested,
        });
        return;
      case "disk_low":
        reject(respond, "nexus_disk_low", "not enough free disk space for this file", {
          freeBytes: out.freeBytes,
          requiredBytes: out.requiredBytes,
        });
        return;
      case "writer_unregistered":
        reject(
          respond,
          "nexus_store_error",
          "the vault writer is not registered yet; retry shortly",
        );
        return;
      case "write_failed":
        reject(respond, "nexus_store_error", out.message);
    }
  }
}
