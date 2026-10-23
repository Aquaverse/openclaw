// Local path import guard (Vault design 5.6). The path only ever comes from an operator action, never from an Agent or a
// skill. Everything is decided on the OPEN handle, not on the path string, so "check, then the file is swapped" cannot
// smuggle another file in:
//   1. absolute path, no NUL;
//   2. realpath (symlinks resolved) must sit inside a configured import root (also realpath'ed);
//   3. the real path must not sit in a forbidden location (the state directory, credential and system folders);
//   4. lstat must say regular file (no directory, device, FIFO, socket);
//   5. open with O_NOFOLLOW, fstat the SAME handle, require the same device + inode as step 4 and a regular file;
//   6. read through that handle while hashing; if the size or mtime moved by the end, the whole read is void.
import fs from "node:fs";
import path from "node:path";

export type ImportRefusal =
  | "not_absolute"
  | "not_found"
  | "outside_roots"
  | "forbidden_location"
  | "not_regular_file"
  | "too_large"
  | "replaced_while_opening"
  | "unreadable";

export type ImportGuardConfig = {
  /** Directories an import may come from (the Downloads and Documents folders by default; configurable). */
  roots: string[];
  /** Directories that are never importable, even when they sit inside a root (state dir, credentials, system). */
  forbidden: string[];
  maxBytes: number;
  /** Test seam only: runs between the path checks and the open, where a "check, then swap" attack would strike. */
  afterChecks?: () => Promise<void>;
};

export type ImportSource = {
  size: number;
  /** Base name only; the full original path is never kept (it carries a user name and a directory structure). */
  displayName: string;
  /** Yields the bytes; throws `ImportChangedError` after the last chunk when the file changed while it was read. */
  chunks: AsyncIterable<Uint8Array>;
  close(): Promise<void>;
};

export class ImportChangedError extends Error {
  readonly code = "import_changed_during_read";
  constructor() {
    super("the file changed while it was being read");
    this.name = "ImportChangedError";
  }
}

const within = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

const realOrUndefined = async (target: string): Promise<string | undefined> => {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return undefined;
  }
};

export async function openImportSource(
  requested: string,
  config: ImportGuardConfig,
): Promise<{ ok: true; source: ImportSource } | { ok: false; reason: ImportRefusal }> {
  if (typeof requested !== "string" || requested.includes("\0") || !path.isAbsolute(requested)) {
    return { ok: false, reason: "not_absolute" };
  }
  const real = await realOrUndefined(requested);
  if (real === undefined) {
    return { ok: false, reason: "not_found" };
  }
  const roots = (await Promise.all(config.roots.map((root) => realOrUndefined(root)))).filter(
    (root): root is string => root !== undefined,
  );
  if (!roots.some((root) => within(real, root))) {
    return { ok: false, reason: "outside_roots" };
  }
  const forbidden = (
    await Promise.all(
      config.forbidden.map(async (entry) => (await realOrUndefined(entry)) ?? path.resolve(entry)),
    )
  ).filter(Boolean);
  if (forbidden.some((entry) => within(real, entry))) {
    return { ok: false, reason: "forbidden_location" };
  }
  let before: fs.Stats;
  try {
    before = await fs.promises.lstat(real);
  } catch {
    return { ok: false, reason: "not_found" };
  }
  if (!before.isFile()) {
    return { ok: false, reason: "not_regular_file" };
  }
  if (before.size > config.maxBytes) {
    return { ok: false, reason: "too_large" };
  }
  await config.afterChecks?.();
  let handle: fs.promises.FileHandle;
  try {
    const noFollow = fs.constants.O_NOFOLLOW ?? 0;
    handle = await fs.promises.open(real, fs.constants.O_RDONLY | noFollow);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile()) {
      await handle.close();
      return { ok: false, reason: "not_regular_file" };
    }
    if (opened.dev !== before.dev || opened.ino !== before.ino) {
      await handle.close();
      return { ok: false, reason: "replaced_while_opening" };
    }
    if (opened.size > config.maxBytes) {
      await handle.close();
      return { ok: false, reason: "too_large" };
    }
    const startSize = opened.size;
    const startMtime = opened.mtimeMs;
    let closed = false;
    const close = async () => {
      if (!closed) {
        closed = true;
        await handle.close().catch(() => undefined);
      }
    };
    async function* chunks(): AsyncGenerator<Uint8Array> {
      const buffer = Buffer.allocUnsafe(256 * 1024);
      let total = 0;
      try {
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
          if (bytesRead === 0) {
            break;
          }
          total += bytesRead;
          if (total > config.maxBytes) {
            throw new ImportChangedError();
          }
          yield new Uint8Array(buffer.subarray(0, bytesRead));
        }
        const after = await handle.stat();
        if (total !== startSize || after.size !== startSize || after.mtimeMs !== startMtime) {
          throw new ImportChangedError();
        }
      } finally {
        await close();
      }
    }
    return {
      ok: true,
      source: { size: startSize, displayName: path.basename(real), chunks: chunks(), close },
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

/**
 * Locations that are never importable on top of the state directory the caller adds: credential folders under the home
 * directory and the usual system directories. Not a security boundary on its own (the roots are the allow-list); this
 * keeps a mistakenly broad root from exposing keys.
 */
export function defaultForbiddenLocations(home: string): string[] {
  return [
    ...[
      ".ssh",
      ".aws",
      ".gnupg",
      ".kube",
      ".docker",
      ".config/gcloud",
      ".azure",
      "Library/Keychains",
      "Library/Cookies",
    ].map((entry) => path.join(home, entry)),
    "/etc",
    "/dev",
    "/proc",
    "/sys",
    "/private/etc",
    "/System",
    "/Library/Keychains",
  ];
}
