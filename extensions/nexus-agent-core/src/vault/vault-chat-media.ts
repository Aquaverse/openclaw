// Chat attachments as a vault ingest (Vault design 4, `source: "chat"`). Extracted from the service because it is the one
// write path that starts from a file the vault did not create: the host's media store already holds the bytes, its reaper
// may delete them later, and the message it came from is what makes the entry worth keeping.
import fs from "node:fs";
import path from "node:path";
import type { Principal } from "../store/types.js";
import { realOrUndefined, within } from "./vault-import.js";
import type {
  VaultConfig,
  VaultImportOutcome,
  VaultIngestInput,
  VaultIngestOutcome,
} from "./vault-service.js";

/** Bounded: a session key can be long, and a reference is a line of UI text, not an address book. */
const CHAT_REF_MAX = 200;

/** `<sessionKey>#<messageId>`: which conversation a chat-attached file came from, and which message carried it. */
export const chatSourceRef = (sessionKey: string, messageId: string): string =>
  `${sessionKey}#${messageId}`.slice(0, CHAT_REF_MAX);

export type ChatMediaDeps = {
  ingest: (principal: Principal, input: VaultIngestInput) => Promise<VaultIngestOutcome>;
  config: () => VaultConfig;
};

/**
 * A file that travelled with a chat message, in either direction. The media store keeps its own copy under a path its
 * reaper may delete, so the vault takes an independent hold: a hard link when the two live on the same volume (no extra
 * bytes, and unlinking the media side cannot take the vault's copy), a copy otherwise. The entry lands in the library
 * itself, not the inbox: a file the user sent or received is a file they expect to still be there next month, while the
 * inbox is for arrivals nobody has looked at yet. `sourceRef` remembers the message it came from.
 *
 * The path is checked against `chatMediaRoot` after both are resolved, so a hook payload cannot point at an arbitrary
 * file: outside the media directory the request is refused, not silently imported.
 */
export function createChatMediaIngest(deps: ChatMediaDeps): (
  principal: Principal,
  input: {
    path: string;
    displayName: string;
    sessionKey: string;
    messageId: string;
    importedBy: string;
  },
) => Promise<VaultImportOutcome> {
  return async (principal, input) => {
    const cfg = deps.config();
    if (cfg.chatMediaRoot === undefined) {
      return { outcome: "refused", reason: "outside_roots" };
    }
    if (!path.isAbsolute(input.path) || input.path.includes("\0")) {
      return { outcome: "refused", reason: "not_absolute" };
    }
    const root = await realOrUndefined(cfg.chatMediaRoot);
    if (root === undefined) {
      return { outcome: "refused", reason: "outside_roots" };
    }
    const real = await realOrUndefined(input.path);
    if (real === undefined) {
      return { outcome: "refused", reason: "not_found" };
    }
    if (!within(real, root)) {
      return { outcome: "refused", reason: "outside_roots" };
    }
    let stat: fs.Stats;
    try {
      stat = await fs.promises.lstat(real);
    } catch {
      return { outcome: "refused", reason: "not_found" };
    }
    if (!stat.isFile()) {
      return { outcome: "refused", reason: "not_regular_file" };
    }
    const maxBytes = Math.min(cfg.import.maxBytes, cfg.limits.maxFileBytes);
    if (stat.size > maxBytes) {
      return { outcome: "refused", reason: "too_large" };
    }
    return deps.ingest(principal, {
      displayName: input.displayName,
      // Only read when the link is refused; the usual path never touches these bytes.
      bytes: fs.createReadStream(real),
      expectedSize: stat.size,
      source: "chat",
      sourceRef: chatSourceRef(input.sessionKey, input.messageId),
      adoptPath: real,
      collection: "vault",
      importedBy: input.importedBy,
    });
  };
}
