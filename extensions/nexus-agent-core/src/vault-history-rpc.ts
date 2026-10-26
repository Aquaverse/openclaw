// Gateway RPC for one file's bytes and history: reading (the current or an older version), the stored versions, and the tasks
// that hold it as evidence. Split from vault-rpc.ts to keep that file small; the shared helpers arrive through `ctx` so the two files do not import each other at runtime.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { Principal } from "./store/types.js";
import type { VaultIngestOutcome, VaultService, VaultStore } from "./vault/vault-service.js";

/** One read reply carries at most this many bytes (base64 adds a third on the wire). */
export const VAULT_RPC_READ_MAX_BYTES = 2 * 1024 * 1024;

type Respond = GatewayRequestHandlerOptions["respond"];
type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

export type VaultHistoryRpcContext = {
  service: Pick<VaultService, "read" | "replace" | "restoreVersion">;
  /** The single-file size an RPC write may carry, and the strict base64 decoder shared with upload. */
  uploadLimit: () => number;
  decode: (raw: unknown, maxBytes: number) => Uint8Array | "invalid" | "too_large";
  /** Answers the outcomes a write shares with upload (ok, quota, disk, writer, write_failed). */
  answerIngest: (respond: Respond, principal: Principal, out: VaultIngestOutcome) => void;
  actor: string;
  guarded: (
    run: (args: {
      principal: Principal;
      store: VaultStore;
      params: Record<string, unknown>;
      respond: Respond;
    }) => Promise<void>,
  ) => GatewayRequestHandler;
  reject: (
    respond: Respond,
    code: string,
    message: string,
    extra?: Record<string, unknown>,
  ) => void;
  needFileId: (params: Record<string, unknown>, respond: Respond) => string | undefined;
};

/** The `version` parameter of nexus.vault.read: a positive integer, absent for the current version, else "invalid". */
export function readVersion(raw: unknown): number | undefined | "invalid" {
  if (raw === undefined) {
    return undefined;
  }
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 ? raw : "invalid";
}

export function createVaultHistoryRpcEntries(ctx: VaultHistoryRpcContext) {
  const { guarded, reject, needFileId } = ctx;
  const { service, decode, answerIngest } = ctx;
  return [
    [
      "nexus.vault.read",
      guarded(async ({ principal, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        // `version` reads an older stored version (the version list's seq); absent reads the current one.
        const seq = readVersion(params.version);
        if (seq === "invalid") {
          reject(respond, "nexus_invalid_params", "version must be a positive integer");
          return;
        }
        const out = await service.read(principal, {
          fileId,
          ...(seq !== undefined ? { seq } : {}),
          allowTrashed: true,
          offset: Number(params.offset ?? 0) || 0,
          length: Math.min(
            Number(params.length ?? VAULT_RPC_READ_MAX_BYTES) || VAULT_RPC_READ_MAX_BYTES,
            VAULT_RPC_READ_MAX_BYTES,
          ),
        });
        switch (out.outcome) {
          case "not_found":
            reject(respond, "nexus_not_found", "file not found");
            return;
          case "not_readable":
            reject(respond, "nexus_conflict", `file cannot be read (${out.state})`, {
              state: out.state,
            });
            return;
          case "bytes_missing":
            reject(respond, "nexus_store_error", "the stored bytes of this file are missing");
            return;
          case "ok":
            respond(true, {
              ownerId: principal.ownerId,
              fileId,
              name: out.displayName,
              mime: out.mime,
              size: out.size,
              sensitivity: out.sensitivity,
              contentHash: out.contentHash,
              eof: out.eof,
              dataBase64: Buffer.from(out.bytes).toString("base64"),
            });
        }
      }),
      "operator.read",
    ],
    [
      "nexus.vault.versions",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const out = await store.vaultVersions({ principal, fileId });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "file not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, fileId, versions: out.versions });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.links",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const out = await store.vaultLinks({ principal, fileId });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "file not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, fileId, total: out.total, links: out.links });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.replace",
      guarded(async ({ principal, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const limit = ctx.uploadLimit();
        const bytes = decode(params.dataBase64, limit);
        if (bytes === "too_large") {
          reject(respond, "nexus_quota_exceeded", "the new content exceeds the single-file limit", {
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
        const out = await service.replace(principal, {
          fileId,
          bytes,
          expectedSize: bytes.byteLength,
          importedBy: ctx.actor,
        });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "file not found");
          return;
        }
        if (out.outcome === "not_active") {
          reject(
            respond,
            "nexus_conflict",
            `only an active file can get new content (${out.state})`,
            {
              state: out.state,
            },
          );
          return;
        }
        answerIngest(respond, principal, out);
      }),
      "operator.write",
    ],
    [
      "nexus.vault.restoreVersion",
      guarded(async ({ principal, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const seq = readVersion(params.version);
        if (seq === undefined || seq === "invalid") {
          reject(respond, "nexus_invalid_params", "version must be a positive integer");
          return;
        }
        const out = await service.restoreVersion(principal, { fileId, seq });
        switch (out.outcome) {
          case "not_found":
            reject(respond, "nexus_not_found", "file not found");
            return;
          case "version_not_found":
            reject(respond, "nexus_not_found", "that version no longer exists");
            return;
          case "wrong_state":
            reject(
              respond,
              "nexus_conflict",
              `only an active file can be restored (${out.state})`,
              {
                state: out.state,
              },
            );
            return;
          case "unchanged":
            respond(true, { ownerId: principal.ownerId, file: out.file, unchanged: true });
            return;
          case "restored":
            respond(true, {
              ownerId: principal.ownerId,
              file: out.file,
              unchanged: false,
              restoredFrom: seq,
              seq: out.seq,
            });
        }
      }),
      "operator.write",
    ],
  ] as const;
}
