// Download of a stored file (or one older version of it) through the gateway connection the console already has: the bytes
// are read in chunks with nexus.vault.read, checked against the recorded SHA-256 when the browser can compute one, and only
// then handed to the browser as a saved file. Nothing is saved when the check fails.
import { tr, type Lang } from "../src/i18n.js";
import type { VaultFileRecord } from "../src/store/vault-types.js";
import {
  downloadFileName,
  fileDownloadable,
  formatBytes,
  VAULT_DOWNLOAD_MAX_BYTES,
} from "../src/vault-ui.js";
import type { ActionContext } from "./actions.ts";
import type { NexusRequest } from "./data.ts";
import { fromBase64 } from "./evidence-view.ts";

/** One RPC reply carries at most this many bytes (the gateway allows 2 MiB; base64 adds a third). */
export const DOWNLOAD_CHUNK_BYTES = 1024 * 1024;

type ReadReply = {
  dataBase64: string;
  size: number;
  eof: boolean;
  contentHash?: string;
};

export type DownloadFailure = "tooBig" | "mismatch" | "short" | "changed";

export class DownloadError extends Error {
  constructor(
    readonly code: DownloadFailure,
    message: string,
    readonly detail: { size?: number } = {},
  ) {
    super(message);
  }
}

export type FetchedFile = {
  bytes: Uint8Array;
  /** The hash the gateway recorded for these bytes, when it reported one. */
  contentHash: string | undefined;
};

/** Reads the whole content (a given version, or the current one) in chunks. Throws DownloadError for a file that is too big. */
export async function fetchFileBytes(
  request: NexusRequest,
  fileId: string,
  options: {
    version?: number;
    maxBytes?: number;
    signal?: AbortSignal;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<FetchedFile> {
  const max = options.maxBytes ?? VAULT_DOWNLOAD_MAX_BYTES;
  let out: Uint8Array | undefined;
  let offset = 0;
  let contentHash: string | undefined;
  for (;;) {
    if (options.signal?.aborted) {
      throw new Error("aborted");
    }
    const reply = await request<ReadReply>("nexus.vault.read", {
      fileId,
      offset,
      length: DOWNLOAD_CHUNK_BYTES,
      ...(options.version !== undefined ? { version: options.version } : {}),
    });
    if (out === undefined) {
      if (reply.size > max) {
        throw new DownloadError("tooBig", "file too big", { size: reply.size });
      }
      out = new Uint8Array(reply.size);
      contentHash = typeof reply.contentHash === "string" ? reply.contentHash : undefined;
    } else if (reply.size !== out.length) {
      // The file was replaced while it was being read: what we hold is a mix of two contents.
      throw new DownloadError("changed", "file changed while downloading");
    }
    const chunk = fromBase64(reply.dataBase64);
    if (offset + chunk.length > out.length) {
      throw new DownloadError("changed", "file changed while downloading");
    }
    out.set(chunk, offset);
    offset += chunk.length;
    options.onProgress?.(offset, out.length);
    if (offset >= out.length) {
      return { bytes: out, contentHash };
    }
    if (reply.eof || chunk.length === 0) {
      throw new DownloadError("short", "the gateway returned fewer bytes than the file holds");
    }
  }
}

/** SHA-256 hex of the bytes, or undefined where the browser has no SubtleCrypto (a plain-http page on a LAN address). */
export async function sha256Hex(bytes: Uint8Array): Promise<string | undefined> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    return undefined;
  }
  const digest = new Uint8Array(await subtle.digest("SHA-256", bytes as BufferSource));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Throws DownloadError("mismatch") when a hash could be computed and differs from the recorded one. */
export async function verifyBytes(bytes: Uint8Array, expected: string | undefined): Promise<void> {
  if (expected === undefined) {
    return;
  }
  const actual = await sha256Hex(bytes);
  if (actual !== undefined && actual !== expected) {
    throw new DownloadError("mismatch", "hash mismatch");
  }
}

/** Hands the bytes to the browser as a saved file. The type is generic on purpose: the file is saved, never opened here. */
export function saveBytes(parent: HTMLElement, name: string, bytes: Uint8Array): void {
  const url = URL.createObjectURL(
    new Blob([bytes as BlobPart], { type: "application/octet-stream" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.hidden = true;
  parent.append(anchor);
  anchor.click();
  anchor.remove();
  // The browser starts reading the blob when the click is handled; revoke later so a slow save is not cut off.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function describeDownloadError(
  lang: Lang,
  error: unknown,
  file: Pick<VaultFileRecord, "size">,
): string {
  if (error instanceof DownloadError) {
    if (error.code === "tooBig") {
      return tr(lang, "files.dl.tooBig", {
        size: formatBytes(error.detail.size ?? file.size),
        max: formatBytes(VAULT_DOWNLOAD_MAX_BYTES),
      });
    }
    if (error.code === "mismatch") {
      return tr(lang, "files.dl.mismatch");
    }
  }
  return tr(lang, "files.dl.failed", {
    message: error instanceof Error ? error.message : String(error),
  });
}

const running = new Set<string>();

/**
 * Downloads one file (or one older version). Progress and the outcome go to `report`, which defaults to the page notice;
 * a second click on the same download while it runs is refused.
 */
export async function downloadFile(
  ctx: ActionContext,
  file: Pick<VaultFileRecord, "id" | "displayName" | "size" | "state">,
  options: {
    version?: number;
    /** The size the user sees for this version (older versions differ from the file's current size). */
    size?: number;
    report?: (notice: { ok: boolean; text: string }) => void;
  } = {},
): Promise<boolean> {
  const report = options.report ?? ctx.notify ?? ctx.changed;
  const key = `${file.id}#${options.version ?? "current"}`;
  if (running.has(key)) {
    report({ ok: false, text: tr(ctx.lang, "files.dl.busy") });
    return false;
  }
  if (options.version === undefined && !fileDownloadable(file)) {
    report({
      ok: false,
      text: tr(ctx.lang, "files.dl.failed", { message: file.state }),
    });
    return false;
  }
  running.add(key);
  const name = downloadFileName(file.displayName, options.version);
  const total = options.size ?? file.size;
  report({ ok: true, text: tr(ctx.lang, "files.dl.start", { name }) });
  let lastShown = 0;
  try {
    const fetched = await fetchFileBytes(ctx.request, file.id, {
      ...(options.version !== undefined ? { version: options.version } : {}),
      signal: ctx.signal,
      onProgress: (done, all) => {
        // A notice per chunk would flicker for small files and cost layout for big ones: about ten updates is enough.
        if (done < all && done - lastShown >= Math.max(all / 10, DOWNLOAD_CHUNK_BYTES)) {
          lastShown = done;
          report({
            ok: true,
            text: tr(ctx.lang, "files.dl.progress", {
              name,
              done: formatBytes(done),
              total: formatBytes(all),
            }),
          });
        }
      },
    });
    await verifyBytes(fetched.bytes, fetched.contentHash);
    if (ctx.signal.aborted) {
      return false;
    }
    saveBytes(ctx.parent, name, fetched.bytes);
    report({
      ok: true,
      text: tr(ctx.lang, "files.dl.done", {
        name,
        size: formatBytes(fetched.bytes.length || total),
      }),
    });
    return true;
  } catch (error) {
    if (!ctx.signal.aborted) {
      report({
        ok: false,
        text: ctx.redact(describeDownloadError(ctx.lang, error, { size: total })),
      });
    }
    return false;
  } finally {
    running.delete(key);
  }
}
