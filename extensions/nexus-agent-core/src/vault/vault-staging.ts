// W of the vault write protocol: bytes to `staging/<reservation>`, hashed on the way (Vault design 5.2).
//
// Extracted from the service so the protocol's "where do the bytes come from" question lives in one place: either a stream
// the caller hands in, or — when a chat attachment already sits on the same volume — a hard link to that file, which costs
// no bytes and is hashed where it now sits.
import { createHash } from "node:crypto";
import type { VaultFileStore } from "./vault-file-store.js";
import type { VaultBytes } from "./vault-service.js";

export const HEAD_BYTES = 4096;

/** The file is bigger than the per-file limit; `seen` is what was counted before giving up. */
export class TooLargeError extends Error {
  constructor(readonly seen: number) {
    super("file is larger than the single-file limit");
  }
}

const isAsyncIterable = (value: unknown): value is AsyncIterable<Uint8Array> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value;

async function* chunksOf(bytes: VaultBytes): AsyncGenerator<Uint8Array> {
  if (bytes instanceof Uint8Array) {
    yield bytes;
  } else if (isAsyncIterable(bytes)) {
    for await (const chunk of bytes) {
      yield chunk;
    }
  } else {
    for (const chunk of bytes) {
      yield chunk;
    }
  }
}

/**
 * Fill `stagingKey` with the bytes, returning the content hash, the size and the first `HEAD_BYTES` (for mime sniffing).
 *
 * With `adoptPath` the bytes are not read at all when the filesystem can hard-link the source: the vault then owns a second
 * name for the same inode. `bytes` stays the fallback for another volume or a refused link.
 */
export async function writeStaging(
  files: VaultFileStore,
  stagingKey: string,
  bytes: VaultBytes,
  maxBytes: number,
  adoptPath?: string | null,
): Promise<{ hash: string; size: number; head: Uint8Array }> {
  if (adoptPath !== undefined && adoptPath !== null) {
    const linked = await files.linkStaging(stagingKey, adoptPath);
    if (linked !== undefined) {
      if (linked.size > maxBytes) {
        await files.remove(stagingKey).catch(() => undefined);
        throw new TooLargeError(linked.size);
      }
      return { ...linked, head: await files.readRange(stagingKey, 0, HEAD_BYTES) };
    }
  }
  const writer = await files.createStaging(stagingKey);
  const digest = createHash("sha256");
  const head = Buffer.alloc(HEAD_BYTES);
  let headLength = 0;
  let size = 0;
  try {
    for await (const chunk of chunksOf(bytes)) {
      size += chunk.byteLength;
      if (size > maxBytes) {
        throw new TooLargeError(size);
      }
      if (headLength < HEAD_BYTES) {
        const take = Math.min(HEAD_BYTES - headLength, chunk.byteLength);
        head.set(chunk.subarray(0, take), headLength);
        headLength += take;
      }
      digest.update(chunk);
      await writer.write(chunk);
    }
    await writer.finish();
  } catch (error) {
    await writer.abort();
    throw error;
  }
  return { hash: digest.digest("hex"), size, head: new Uint8Array(head.subarray(0, headLength)) };
}
