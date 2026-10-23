// What an Agent may do with the personal file vault (Vault design 7.1): search, read metadata, and attach a file to a claim
// as evidence. Nothing here writes, moves, deletes or purges a file, and nothing returns a file the user marked sensitive.
// File names and metadata are user-controlled text: they are returned as data and never as instructions.
// The tool layer (src/tools/file-tools.ts) is a thin typed wrapper around these functions so they can be tested without the
// OpenClaw SDK.
import { createHash } from "node:crypto";
import type { Principal } from "../store/types.js";
import {
  VAULT_COLLECTIONS,
  normalizeVaultFolder,
  type VaultCollection,
  type VaultFileRecord,
} from "../store/vault-types.js";
import type { VaultReadOutcome, VaultStore } from "./vault-service.js";

export const AGENT_SEARCH_DEFAULT_LIMIT = 10;
export const AGENT_SEARCH_MAX_LIMIT = 25;
const AGENT_NAME_QUERY_CHARS = 120;
/** Collections searched when the caller names none: the inbox holds unreviewed arrivals and is asked for explicitly. */
const DEFAULT_SEARCH_COLLECTIONS: VaultCollection[] = ["vault", "deliverable"];
const READ_CHUNK = 4 * 1024 * 1024;

export type AgentFailure = {
  ok: false;
  code: string;
  message: string;
  notice: string;
  [extra: string]: unknown;
};

export function agentFail(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): AgentFailure {
  return {
    ok: false,
    code,
    message,
    ...extra,
    notice:
      "This call FAILED and changed nothing. Tell the user it failed; never claim a file was found, read or attached.",
  };
}

const ID = /^[A-Za-z0-9_-]{1,64}$/u;

export function agentFileView(file: VaultFileRecord) {
  return {
    fileId: file.id,
    name: file.displayName,
    folder: file.folder,
    collection: file.collection,
    size: file.size,
    mime: file.mime,
    source: file.source,
    createdAt: file.createdAt,
    updatedAt: file.updatedAt,
    pinned: file.pinnedAt !== null,
    favorite: file.favorite,
  };
}

const SENSITIVE_NOTE =
  "Files the user marked sensitive are never shown to you and are not counted here. If the user needs one, they attach or describe it themselves.";

// ------------------------------------------------------------------ search

export type AgentSearchParams = {
  name?: unknown;
  collection?: unknown;
  folder?: unknown;
  limit?: unknown;
};

export async function agentSearchFiles(
  store: Pick<VaultStore, "vaultList">,
  principal: Principal,
  params: AgentSearchParams,
): Promise<Record<string, unknown>> {
  let collections = DEFAULT_SEARCH_COLLECTIONS;
  if (params.collection !== undefined) {
    if (
      typeof params.collection !== "string" ||
      !(VAULT_COLLECTIONS as readonly string[]).includes(params.collection)
    ) {
      return agentFail(
        "invalid_collection",
        "collection must be one of inbox, vault, deliverable.",
      );
    }
    collections = [params.collection as VaultCollection];
  }
  let nameContains: string | undefined;
  if (params.name !== undefined) {
    if (
      typeof params.name !== "string" ||
      Array.from(params.name).length > AGENT_NAME_QUERY_CHARS
    ) {
      return agentFail(
        "invalid_name",
        `name must be text of at most ${AGENT_NAME_QUERY_CHARS} characters.`,
      );
    }
    nameContains = params.name.trim() === "" ? undefined : params.name.trim();
  }
  let folder: string | undefined;
  if (params.folder !== undefined) {
    const normalized =
      typeof params.folder === "string" ? normalizeVaultFolder(params.folder) : null;
    if (normalized === null) {
      return agentFail(
        "invalid_folder",
        "folder must look like Taxes/2025 (no .. segments, at most 8 levels).",
      );
    }
    folder = normalized;
  }
  let limit = AGENT_SEARCH_DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || (params.limit as number) < 1) {
      return agentFail(
        "invalid_limit",
        `limit must be an integer between 1 and ${AGENT_SEARCH_MAX_LIMIT}.`,
      );
    }
    limit = Math.min(params.limit as number, AGENT_SEARCH_MAX_LIMIT);
  }

  const found: VaultFileRecord[] = [];
  let total = 0;
  for (const collection of collections) {
    const page = await store.vaultList({
      principal,
      collection,
      state: "active",
      includeSensitive: false,
      pinnedFirst: true,
      limit,
      ...(nameContains ? { nameContains } : {}),
      ...(folder !== undefined ? { folder } : {}),
    });
    found.push(...page.items);
    total += page.total;
  }
  found.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  const files = found.slice(0, limit);
  return {
    ok: true,
    files: files.map(agentFileView),
    returned: files.length,
    total,
    complete: files.length === total,
    searched: collections,
    note: `${SENSITIVE_NOTE} Only file names and metadata are searched; file contents are not indexed.`,
  };
}

// ------------------------------------------------------------------ get

/** Shared gate: the file exists for this owner, is active and is not sensitive. */
async function openable(
  store: Pick<VaultStore, "vaultGet">,
  principal: Principal,
  fileId: unknown,
): Promise<{ ok: true; file: VaultFileRecord } | AgentFailure> {
  if (typeof fileId !== "string" || !ID.test(fileId)) {
    return agentFail("invalid_file_id", "fileId is malformed; take it from nexus_file_search.");
  }
  const got = await store.vaultGet({ principal, fileId });
  if (got.outcome === "not_found") {
    return agentFail("not_found", "File not found.");
  }
  const { file } = got;
  if (file.sensitivity === "sensitive") {
    return agentFail(
      "file_sensitive",
      "The user marked this file sensitive, so it is not available to you. Ask the user to describe it or to share the relevant part themselves.",
    );
  }
  if (file.state !== "active") {
    return agentFail("file_not_available", `This file is not available (${file.state}).`);
  }
  return { ok: true, file };
}

export async function agentGetFile(
  store: Pick<VaultStore, "vaultGet">,
  principal: Principal,
  fileId: unknown,
): Promise<Record<string, unknown>> {
  const opened = await openable(store, principal, fileId);
  if (!opened.ok) {
    return opened;
  }
  return {
    ok: true,
    ...agentFileView(opened.file),
    versionCount: opened.file.versionCount,
    contentExtracted: false,
    note: "Only metadata is available. File contents are not extracted in this version; use nexus_file_attach to attach the file to a claim as evidence.",
  };
}

// ------------------------------------------------------------------ attach

/** The slice of the evidence service this needs; the tool layer passes the real service. */
export type AgentEvidence<R> = {
  upload(input: {
    principal: Principal;
    taskId: string;
    name: string;
    mediaType?: string;
    locator: string;
    version: string;
    classification: "personal";
    bytes: Uint8Array;
    actor: string;
  }): Promise<R>;
  attachBlob(input: {
    principal: Principal;
    taskId: string;
    claimId: string;
    blobKey: string;
    expectedHeadEventId?: string;
    actor: string;
    eventSource: "store";
  }): Promise<R>;
  maxEntryBytes: number;
};

export type AgentAttachDeps<R extends { outcome: string }> = {
  store: Pick<VaultStore, "vaultGet">;
  read: (
    principal: Principal,
    input: { fileId: string; offset: number; length: number },
  ) => Promise<VaultReadOutcome>;
  evidence: AgentEvidence<R>;
  /** Maps an evidence service outcome to a tool result (the claim tools' mapping, so both paths read the same). */
  mapEvidence: (result: R) => Record<string, unknown>;
  /** Thrown by the evidence service when the host gives this install no byte store. */
  isBytesUnavailable: (error: unknown) => { reason: string } | undefined;
};

export async function agentAttachFile<R extends { outcome: string; blobKey?: string }>(
  deps: AgentAttachDeps<R>,
  principal: Principal,
  input: {
    taskId: string;
    claimId: unknown;
    fileId: unknown;
    expectedHeadEventId?: unknown;
    actor: string;
  },
): Promise<Record<string, unknown>> {
  if (typeof input.claimId !== "string" || !ID.test(input.claimId)) {
    return agentFail("invalid_claim_id", "claimId is malformed.");
  }
  if (input.expectedHeadEventId !== undefined && typeof input.expectedHeadEventId !== "string") {
    return agentFail("invalid_expected_head", "expectedHeadEventId must be a string.");
  }
  const opened = await openable(deps.store, principal, input.fileId);
  if (!opened.ok) {
    return opened;
  }
  const { file } = opened;
  if (file.size > deps.evidence.maxEntryBytes) {
    return agentFail(
      "file_too_large",
      `This file is larger than the evidence limit for one item (${deps.evidence.maxEntryBytes} bytes), so it was not attached.`,
      { size: file.size, limit: deps.evidence.maxEntryBytes },
    );
  }

  const parts: Uint8Array[] = [];
  let have = 0;
  while (have < file.size) {
    const chunk = await deps.read(principal, {
      fileId: file.id,
      offset: have,
      length: Math.min(READ_CHUNK, file.size - have),
    });
    if (chunk.outcome === "not_found" || chunk.outcome === "not_readable") {
      return agentFail("file_not_available", "This file is not available right now.");
    }
    if (chunk.outcome === "bytes_missing") {
      return agentFail(
        "file_bytes_missing",
        "The stored bytes of this file are missing. Tell the user the file looks damaged; nothing was attached.",
      );
    }
    if (chunk.bytes.byteLength === 0) {
      break;
    }
    parts.push(chunk.bytes);
    have += chunk.bytes.byteLength;
  }
  const bytes = Buffer.concat(parts);
  if (
    bytes.byteLength !== file.size ||
    createHash("sha256").update(bytes).digest("hex") !== file.contentHash
  ) {
    return agentFail(
      "file_bytes_mismatch",
      "The stored bytes do not match this file's record. Tell the user the file looks damaged; nothing was attached.",
    );
  }

  try {
    // Register the bytes on the Task first (no claim yet), then link by blobKey exactly like any other uploaded material:
    // the store decides the relation, so an attached document stays unclassified until the user declares it.
    const registered = await deps.evidence.upload({
      principal,
      taskId: input.taskId,
      name: file.displayName,
      mediaType: file.mime,
      locator: `vault:${file.id}`,
      version: file.contentHash.slice(0, 16),
      classification: "personal",
      bytes,
      actor: input.actor,
    });
    if (registered.outcome !== "registered") {
      return deps.mapEvidence(registered);
    }
    const blobKey = registered.blobKey;
    if (typeof blobKey !== "string") {
      return agentFail("conflict", "The material could not be registered; nothing was attached.");
    }
    const linked = await deps.evidence.attachBlob({
      principal,
      taskId: input.taskId,
      claimId: input.claimId,
      blobKey,
      ...(typeof input.expectedHeadEventId === "string"
        ? { expectedHeadEventId: input.expectedHeadEventId }
        : {}),
      actor: input.actor,
      eventSource: "store",
    });
    const mapped = deps.mapEvidence(linked);
    return mapped.ok === true
      ? { ...mapped, source: { fileId: file.id, name: file.displayName } }
      : mapped;
  } catch (error) {
    const unavailable = deps.isBytesUnavailable(error);
    if (unavailable) {
      return agentFail(
        "evidence_bytes_unavailable",
        "This install does not provide evidence byte storage, so the file was not attached; do not present the related conclusion as proven.",
        { reason: unavailable.reason },
      );
    }
    throw error;
  }
}
