// Gateway RPC for vault content search and text extraction (Vault design 9.4, F2). Split from vault-rpc.ts to keep that file
// small; the shared helpers arrive through `ctx` so the two files do not import each other at runtime.
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import type { VaultChangedPayload } from "./events.js";
import type { Principal } from "./store/types.js";
import type { VaultExtractionStatus } from "./store/vault-text-types.js";
import type { VaultCollection } from "./store/vault-types.js";
import type { VaultService, VaultStore } from "./vault/vault-service.js";

type Respond = GatewayRequestHandlerOptions["respond"];
type GatewayRequestHandler = (opts: GatewayRequestHandlerOptions) => Promise<void> | void;

export type VaultTextRpcContext = {
  service: Pick<VaultService, "extract">;
  now: () => number;
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
  readCollection: (raw: unknown) => VaultCollection | undefined | "invalid";
  needFileId: (params: Record<string, unknown>, respond: Respond) => string | undefined;
  extractionFor: (
    store: VaultStore,
    principal: Principal,
    files: { id: string; objectId: string }[],
  ) => Promise<Record<string, VaultExtractionStatus>>;
  emit: (principal: Principal, change: Omit<VaultChangedPayload, "ownerId">) => void;
};

export function createVaultTextRpcEntries(ctx: VaultTextRpcContext) {
  const { guarded, reject, readCollection, needFileId, extractionFor, emit, now } = ctx;
  return [
    [
      // Content search (F2). The answer is files, never text; `unindexed` says how many files could not be searched yet.
      "nexus.vault.search",
      guarded(async ({ principal, store, params, respond }) => {
        if (typeof params.query !== "string" || params.query.trim() === "") {
          reject(respond, "nexus_invalid_params", "query is required");
          return;
        }
        const collection = readCollection(params.collection);
        if (collection === "invalid") {
          reject(respond, "nexus_invalid_params", "collection must be inbox|vault|deliverable");
          return;
        }
        if (params.folder !== undefined && typeof params.folder !== "string") {
          reject(respond, "nexus_invalid_params", "folder must be text");
          return;
        }
        const result = await store.vaultTextSearch({
          principal,
          query: params.query,
          ...(collection ? { collection } : {}),
          ...(typeof params.folder === "string" && params.folder.trim() !== ""
            ? { folder: params.folder }
            : {}),
          limit: Math.min(Math.max(Number(params.limit ?? 20) || 20, 1), 200),
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
      // The operator can read the extracted text of their own non-sensitive file (the console preview). The Agent cannot.
      "nexus.vault.text",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const out = await store.vaultTextRead({
          principal,
          fileId,
          allowTrashed: true,
          ...(params.page !== undefined ? { page: Math.max(Number(params.page) || 0, 0) } : {}),
          ...(params.maxChars !== undefined ? { maxChars: Number(params.maxChars) || 20_000 } : {}),
        });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "file not found");
          return;
        }
        respond(true, { ownerId: principal.ownerId, ...out, available: out.outcome === "ok" });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.jobs",
      guarded(async ({ principal, store, params, respond }) => {
        const valid = ["pending", "running", "ready", "failed", "rejected", "cancelled"];
        if (
          params.state !== undefined &&
          !(typeof params.state === "string" && valid.includes(params.state))
        ) {
          reject(respond, "nexus_invalid_params", `state must be ${valid.join("|")}`);
          return;
        }
        const result = await store.vaultJobList({
          principal,
          ...(typeof params.state === "string"
            ? {
                state: params.state as
                  | "pending"
                  | "running"
                  | "ready"
                  | "failed"
                  | "rejected"
                  | "cancelled",
              }
            : {}),
          limit: Math.min(Math.max(Number(params.limit ?? 50) || 50, 1), 200),
        });
        respond(true, { ownerId: principal.ownerId, ...result });
      }),
      "operator.read",
    ],
    [
      "nexus.vault.retryExtract",
      guarded(async ({ principal, store, params, respond }) => {
        const fileId = needFileId(params, respond);
        if (!fileId) {
          return;
        }
        const out = await store.vaultJobRetry({ principal, fileId, now: now() });
        if (out.outcome === "not_found") {
          reject(respond, "nexus_not_found", "file not found");
          return;
        }
        if (out.outcome === "not_retryable") {
          reject(respond, "nexus_conflict", `extraction cannot be retried (${out.state})`, {
            state: out.state,
          });
          return;
        }
        void ctx.service.extract(principal).catch(() => undefined);
        emit(principal, { fileId, action: "extracted" });
        respond(true, { ownerId: principal.ownerId, queued: true });
      }),
      "operator.write",
    ],
    [
      // Run one extraction pass now (the background pass also runs about once a minute and after every import).
      "nexus.vault.extract",
      guarded(async ({ principal, respond }) => {
        const report = await ctx.service.extract(principal);
        respond(true, { ownerId: principal.ownerId, report });
      }),
      "operator.write",
    ],
  ] as const;
}
