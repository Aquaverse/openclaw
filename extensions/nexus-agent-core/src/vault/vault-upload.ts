// Resumable, chunked file upload over the gateway's HTTP port (F3). The Control UI's own RPC upload carries a whole file as
// base64 in one frame (16 MiB at most); this route lets a phone or a script send a large file in pieces and pick up where it
// stopped after a dropped connection:
//
//   POST   <base>/sessions                  {name, size, sha256?, folder?, collection?, source?}  -> 201 {uploadId, chunkBytes, offset: 0}
//   GET    <base>/sessions/<id>             -> {offset, size}              (HEAD works too; ask this after a failure)
//   PUT    <base>/sessions/<id>?offset=N    raw bytes of at most chunkBytes -> {offset}   (409 + the real offset on a mismatch)
//   POST   <base>/sessions/<id>/complete    -> 200 {file}                  (checks size and sha256, then enters the vault)
//   DELETE <base>/sessions/<id>             abandon the upload
//
// The route is mounted with `auth: "gateway"` and checks the operator scope itself (write for every change). Bytes wait in
// `<vault>/uploads/` until `complete`, which hands them to the normal vault write protocol (quota, dedup, mime sniffing,
// sensitivity rule, extraction): an upload session has no way into the vault that skips any of that.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Principal } from "../store/types.js";
import {
  normalizeVaultFolder,
  normalizeVaultName,
  VAULT_COLLECTIONS,
  type VaultCollection,
  type VaultSource,
} from "../store/vault-types.js";
import type { VaultIngestInput, VaultIngestOutcome } from "./vault-service.js";

export const VAULT_UPLOAD_BASE_PATH = "/plugins/nexus-agent-core/vault-upload";
export const VAULT_UPLOAD_CHUNK_BYTES = 4 * 1024 * 1024;
export const VAULT_UPLOAD_SESSION_TTL_MS = 24 * 3600 * 1000;
export const VAULT_UPLOAD_MAX_SESSIONS = 4;
const JSON_BODY_MAX = 8 * 1024;
const SESSION_ID = /^US[0-9a-f]{32}$/;
const SOURCES: readonly VaultSource[] = ["upload", "mobile"];
const WRITE_SCOPES = new Set(["operator.write", "operator.admin"]);
const READ_SCOPES = new Set(["operator.read", "operator.write", "operator.admin"]);
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

type Meta = {
  id: string;
  ownerId: string;
  name: string;
  size: number;
  sha256: string | null;
  folder: string;
  collection: VaultCollection | null;
  source: VaultSource;
  createdAt: number;
  expiresAt: number;
};

export type VaultUploadDeps = {
  /** Directory for session files; created on first use (0700). */
  dir: string;
  ingest: (principal: Principal, input: VaultIngestInput) => Promise<VaultIngestOutcome>;
  freeBytes: () => Promise<number | undefined>;
  resolvePrincipal: () => Principal | undefined;
  readScopes: () => readonly string[];
  /** The single-file limit of the vault; a session larger than this is refused up front. */
  maxFileBytes: () => number;
  minFreeBytes: () => number;
  basePath?: string;
  chunkBytes?: number;
  sessionTtlMs?: number;
  maxSessions?: number;
  now?: () => number;
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export function createVaultUploadHandler(deps: VaultUploadDeps) {
  const basePath = deps.basePath ?? VAULT_UPLOAD_BASE_PATH;
  const chunkBytes = deps.chunkBytes ?? VAULT_UPLOAD_CHUNK_BYTES;
  const ttl = deps.sessionTtlMs ?? VAULT_UPLOAD_SESSION_TTL_MS;
  const maxSessions = deps.maxSessions ?? VAULT_UPLOAD_MAX_SESSIONS;
  const now = deps.now ?? Date.now;
  const metaPath = (id: string) => path.join(deps.dir, `${id}.json`);
  const partPath = (id: string) => path.join(deps.dir, `${id}.part`);
  const locks = new Map<string, Promise<unknown>>();

  /** One request at a time per session: a retried chunk can never interleave with the one it repeats. */
  const exclusive = async <T>(id: string, run: () => Promise<T>): Promise<T> => {
    const previous = locks.get(id) ?? Promise.resolve();
    const current = previous.then(run, run);
    locks.set(id, current);
    try {
      return await current;
    } finally {
      if (locks.get(id) === current) {
        locks.delete(id);
      }
    }
  };

  const ensureDir = async () => {
    await fs.promises.mkdir(deps.dir, { recursive: true, mode: DIR_MODE });
  };

  const readMeta = async (id: string): Promise<Meta | undefined> => {
    try {
      return JSON.parse(await fs.promises.readFile(metaPath(id), "utf8")) as Meta;
    } catch {
      return undefined;
    }
  };

  const removeSession = async (id: string) => {
    await fs.promises.rm(partPath(id), { force: true });
    await fs.promises.rm(metaPath(id), { force: true });
  };

  const listMetas = async (): Promise<Meta[]> => {
    let names: string[];
    try {
      names = await fs.promises.readdir(deps.dir);
    } catch {
      return [];
    }
    const metas: Meta[] = [];
    for (const name of names) {
      const id = name.endsWith(".json") ? name.slice(0, -5) : undefined;
      if (id && SESSION_ID.test(id)) {
        const meta = await readMeta(id);
        if (meta) {
          metas.push(meta);
        }
      }
    }
    return metas;
  };

  /** Removes expired sessions and part files nobody owns. Safe to call at any time. */
  async function sweep(): Promise<number> {
    let removed = 0;
    let names: string[];
    try {
      names = await fs.promises.readdir(deps.dir);
    } catch {
      return 0;
    }
    const ids = new Set<string>();
    for (const name of names) {
      const id = name.replace(/\.(json|part|tmp)$/, "");
      if (SESSION_ID.test(id)) {
        ids.add(id);
      }
    }
    for (const id of ids) {
      const meta = await readMeta(id);
      let expired = meta !== undefined && meta.expiresAt <= now();
      if (!meta) {
        // No readable metadata: an orphan part file, or a create that died half way. Give it the full TTL, then drop it.
        const stat = await fs.promises.stat(partPath(id)).catch(() => undefined);
        expired = !stat || stat.mtimeMs + ttl <= now();
      }
      if (expired) {
        await exclusive(id, () => removeSession(id));
        removed += 1;
      }
    }
    return removed;
  }

  // ------------------------------------------------------------------ request plumbing

  const readBody = async (req: IncomingMessage, max: number): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      total += buffer.length;
      if (total > max) {
        throw new HttpError(413, "chunk_too_large", `a request body is at most ${max} bytes`);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks, total);
  };

  const readJson = async (req: IncomingMessage): Promise<Record<string, unknown>> => {
    const raw = (await readBody(req, JSON_BODY_MAX)).toString("utf8");
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    throw new HttpError(400, "invalid_json", "the body must be a JSON object");
  };

  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (typeof origin !== "string") {
      return true; // not a browser cross-origin request
    }
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  };

  const hashFile = async (file: string): Promise<string> => {
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) {
      hash.update(chunk as Buffer);
    }
    return hash.digest("hex");
  };

  // ------------------------------------------------------------------ operations

  async function createSession(
    principal: Principal,
    body: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const name = typeof body.name === "string" ? normalizeVaultName(body.name) : null;
    if (name === null) {
      throw new HttpError(400, "invalid_name", "name must be a plain file name");
    }
    const folder = normalizeVaultFolder(typeof body.folder === "string" ? body.folder : "");
    if (folder === null) {
      throw new HttpError(400, "invalid_folder", "folder is not valid");
    }
    const size = body.size;
    if (typeof size !== "number" || !Number.isInteger(size) || size < 1) {
      throw new HttpError(400, "invalid_size", "size must be a whole number of bytes, at least 1");
    }
    const limit = deps.maxFileBytes();
    if (size > limit) {
      throw new HttpError(413, "too_large", `the largest file is ${limit} bytes`, { limit });
    }
    let sha256: string | null = null;
    if (body.sha256 !== undefined && body.sha256 !== null) {
      if (typeof body.sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(body.sha256)) {
        throw new HttpError(400, "invalid_sha256", "sha256 must be 64 hex characters");
      }
      sha256 = body.sha256.toLowerCase();
    }
    let collection: VaultCollection | null = null;
    if (body.collection !== undefined && body.collection !== null && body.collection !== "") {
      if (
        typeof body.collection !== "string" ||
        !(VAULT_COLLECTIONS as readonly string[]).includes(body.collection)
      ) {
        throw new HttpError(
          400,
          "invalid_collection",
          "collection must be inbox|vault|deliverable",
        );
      }
      collection = body.collection as VaultCollection;
    }
    const source = body.source ?? "upload";
    if (typeof source !== "string" || !(SOURCES as readonly string[]).includes(source)) {
      throw new HttpError(400, "invalid_source", "source must be upload|mobile");
    }
    await ensureDir();
    await sweep();
    const mine = (await listMetas()).filter((meta) => meta.ownerId === principal.ownerId);
    if (mine.length >= maxSessions) {
      throw new HttpError(429, "too_many_uploads", `at most ${maxSessions} uploads at a time`, {
        limit: maxSessions,
      });
    }
    const free = await deps.freeBytes();
    const required = size + deps.minFreeBytes();
    if (free !== undefined && free < required) {
      throw new HttpError(507, "disk_low", "not enough free disk space", {
        freeBytes: free,
        requiredBytes: required,
      });
    }
    const id = `US${randomBytes(16).toString("hex")}`;
    const meta: Meta = {
      id,
      ownerId: principal.ownerId,
      name,
      size,
      sha256,
      folder,
      collection,
      source: source as VaultSource,
      createdAt: now(),
      expiresAt: now() + ttl,
    };
    await fs.promises.writeFile(partPath(id), "", { flag: "wx", mode: FILE_MODE });
    const tmp = path.join(deps.dir, `${id}.tmp`);
    await fs.promises.writeFile(tmp, JSON.stringify(meta), { mode: FILE_MODE });
    await fs.promises.rename(tmp, metaPath(id));
    return { uploadId: id, offset: 0, size, chunkBytes, expiresAt: meta.expiresAt };
  }

  const ownedSession = async (principal: Principal, id: string): Promise<Meta> => {
    const meta = SESSION_ID.test(id) ? await readMeta(id) : undefined;
    // Another owner's session reads exactly like a missing one.
    if (!meta || meta.ownerId !== principal.ownerId) {
      throw new HttpError(404, "not_found", "no such upload");
    }
    if (meta.expiresAt <= now()) {
      await exclusive(id, () => removeSession(id));
      throw new HttpError(410, "expired", "this upload expired; start a new one");
    }
    return meta;
  };

  const sizeOf = async (id: string): Promise<number> => {
    try {
      return (await fs.promises.stat(partPath(id))).size;
    } catch {
      throw new HttpError(404, "not_found", "no such upload");
    }
  };

  async function status(principal: Principal, id: string): Promise<Record<string, unknown>> {
    const meta = await ownedSession(principal, id);
    return {
      uploadId: id,
      offset: await sizeOf(id),
      size: meta.size,
      chunkBytes,
      expiresAt: meta.expiresAt,
    };
  }

  async function putChunk(
    principal: Principal,
    id: string,
    offset: number,
    req: IncomingMessage,
  ): Promise<Record<string, unknown>> {
    const meta = await ownedSession(principal, id);
    const body = await readBody(req, chunkBytes);
    if (body.length === 0) {
      throw new HttpError(400, "empty_chunk", "send at least one byte");
    }
    return exclusive(id, async () => {
      const current = await sizeOf(id);
      if (offset !== current) {
        throw new HttpError(409, "offset_mismatch", "the upload is at a different offset", {
          offset: current,
        });
      }
      if (current + body.length > meta.size) {
        throw new HttpError(413, "past_declared_size", "that would go past the declared size", {
          offset: current,
          size: meta.size,
        });
      }
      const handle = await fs.promises.open(partPath(id), "r+");
      try {
        await handle.write(body, 0, body.length, current);
      } finally {
        await handle.close();
      }
      return { uploadId: id, offset: current + body.length, size: meta.size };
    });
  }

  async function complete(principal: Principal, id: string): Promise<Record<string, unknown>> {
    const meta = await ownedSession(principal, id);
    return exclusive(id, async () => {
      const have = await sizeOf(id);
      if (have !== meta.size) {
        throw new HttpError(409, "incomplete", "not all bytes arrived yet", {
          offset: have,
          size: meta.size,
        });
      }
      if (meta.sha256 !== null && (await hashFile(partPath(id))) !== meta.sha256) {
        await removeSession(id);
        throw new HttpError(
          422,
          "checksum_mismatch",
          "the bytes do not match the sha256; upload again",
        );
      }
      const stream = fs.createReadStream(partPath(id));
      let outcome: VaultIngestOutcome;
      try {
        outcome = await deps.ingest(principal, {
          displayName: meta.name,
          bytes: stream as AsyncIterable<Uint8Array>,
          expectedSize: meta.size,
          source: meta.source,
          folder: meta.folder,
          ...(meta.collection ? { collection: meta.collection } : {}),
          importedBy: "operator:http-upload",
        });
      } finally {
        stream.destroy();
      }
      switch (outcome.outcome) {
        case "ok": {
          await removeSession(id);
          const file = outcome.file;
          return {
            file: {
              id: file.id,
              displayName: file.displayName,
              folder: file.folder,
              collection: file.collection,
              size: file.size,
              mime: file.mime,
              sensitivity: file.sensitivity,
            },
            reference: `#${file.id}`,
            deduplicated: outcome.deduplicated,
          };
        }
        case "invalid":
          await removeSession(id);
          throw new HttpError(400, `invalid_${outcome.reason}`, `${outcome.reason} is not valid`);
        case "quota_exceeded":
          throw new HttpError(413, "quota_exceeded", "the vault is full or the file is too large", {
            scope: outcome.scope,
            limit: outcome.limit,
            used: outcome.used,
          });
        case "disk_low":
          throw new HttpError(507, "disk_low", "not enough free disk space", {
            freeBytes: outcome.freeBytes,
            requiredBytes: outcome.requiredBytes,
          });
        case "writer_unregistered":
          throw new HttpError(503, "not_ready", "the vault is starting; try again in a moment");
        default:
          throw new HttpError(500, "write_failed", outcome.message);
      }
    });
  }

  async function abort(principal: Principal, id: string): Promise<Record<string, unknown>> {
    await ownedSession(principal, id);
    await exclusive(id, () => removeSession(id));
    return { uploadId: id, aborted: true };
  }

  // ------------------------------------------------------------------ the handler

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const send = (code: number, body: Record<string, unknown>) => {
      const text = JSON.stringify(body);
      res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(text),
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      res.end(req.method === "HEAD" ? undefined : text);
      return true;
    };
    const url = new URL(req.url ?? "", "http://nexus.invalid");
    const pathname = url.pathname;
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      return false;
    }
    try {
      const method = req.method ?? "GET";
      const writing = !(method === "GET" || method === "HEAD");
      const scopes = deps.readScopes();
      if (!scopes.some((scope) => (writing ? WRITE_SCOPES : READ_SCOPES).has(scope))) {
        throw new HttpError(
          403,
          "forbidden",
          writing ? "operator.write scope required" : "operator.read scope required",
        );
      }
      if (writing && !sameOrigin(req)) {
        throw new HttpError(403, "cross_origin", "cross-origin uploads are not allowed");
      }
      const principal = deps.resolvePrincipal();
      if (!principal) {
        throw new HttpError(403, "no_principal", "cannot resolve the owner");
      }
      const rest = pathname
        .slice(basePath.length)
        .split("/")
        .filter((segment) => segment !== "");
      if (rest[0] !== "sessions") {
        throw new HttpError(404, "not_found", "not found");
      }
      const id = rest[1];
      if (rest.length === 1) {
        if (method !== "POST") {
          throw new HttpError(405, "method_not_allowed", "POST creates an upload");
        }
        const type = (req.headers["content-type"] ?? "").toLowerCase();
        if (!type.startsWith("application/json")) {
          throw new HttpError(415, "unsupported_media_type", "send application/json");
        }
        return send(201, await createSession(principal, await readJson(req)));
      }
      if (id === undefined || !SESSION_ID.test(id)) {
        throw new HttpError(404, "not_found", "no such upload");
      }
      if (rest.length === 2) {
        if (method === "GET" || method === "HEAD") {
          return send(200, await status(principal, id));
        }
        if (method === "PUT") {
          const raw = url.searchParams.get("offset");
          if (raw === null || !/^\d{1,15}$/.test(raw)) {
            throw new HttpError(400, "invalid_offset", "offset is required");
          }
          const type = (req.headers["content-type"] ?? "").toLowerCase();
          if (!type.startsWith("application/octet-stream")) {
            throw new HttpError(415, "unsupported_media_type", "send application/octet-stream");
          }
          return send(200, await putChunk(principal, id, Number(raw), req));
        }
        if (method === "DELETE") {
          return send(200, await abort(principal, id));
        }
        throw new HttpError(405, "method_not_allowed", "GET, PUT or DELETE");
      }
      if (rest.length === 3 && rest[2] === "complete") {
        if (method !== "POST") {
          throw new HttpError(405, "method_not_allowed", "POST completes an upload");
        }
        return send(200, await complete(principal, id));
      }
      throw new HttpError(404, "not_found", "not found");
    } catch (error) {
      if (error instanceof HttpError) {
        return send(error.status, {
          ok: false,
          code: error.code,
          message: error.message,
          ...error.extra,
        });
      }
      return send(500, {
        ok: false,
        code: "upload_failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return { handler, sweep };
}

export type VaultUploadHandler = ReturnType<typeof createVaultUploadHandler>;
