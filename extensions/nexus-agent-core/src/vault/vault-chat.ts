// Chat attachments into the file vault (Vault design 4, `source: "chat"`), in both directions.
//
// A message carries descriptor facts, not bytes: the host stages each attachment under its media directory and mentions the
// local path. The hook that observes a message is therefore the only place where "a file arrived with this conversation" is
// both known and still on disk. Everything here is best effort — a failure must never disturb the conversation, so the hook
// returns immediately and reports at most a warning.
//
// Two guards keep the intake honest:
//   * only facts that already have a local path are taken (`mediaStagingPending` messages are skipped: their bytes are not
//     local yet, and the vault is not the place to wait for them);
//   * the same (session, message, index) is ingested once, so a re-delivered event cannot add a second copy.
//
// The same applies to a reply: `reply_payload_sending` names the files the agent is about to send, and they are taken in
// through the identical path so a file the user received is filed next to one they sent.
import path from "node:path";
import type { Principal } from "../store/types.js";
import type { VaultService } from "./vault-service.js";

/** The part of a hook media fact this module reads; every field is untrusted input. */
type MediaFact = {
  path?: unknown;
  fileName?: unknown;
  name?: unknown;
  kind?: unknown;
};

export type ChatIntakeDeps = {
  vault: Pick<VaultService, "ingestChatMedia">;
  /** Undefined when the plugin has no resolved owner yet: the intake then does nothing rather than guessing one. */
  resolvePrincipal: () => Principal | undefined;
  /** Who is recorded as having brought the file in; the owner, never the sender of the message. */
  importedBy: string;
  logger?: { warn: (message: string) => void };
  /** A single message can carry a photo album; this caps how much one event can queue. */
  maxPerMessage?: number;
};

const DEFAULT_MAX_PER_MESSAGE = 10;
/** How many (session, message, index) triples are remembered to suppress re-delivery. */
const SEEN_LIMIT = 512;
const NAME_MAX = 255;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/** The path a fact points at, if it has one that could name a file on this machine. */
function localPath(fact: MediaFact): string | undefined {
  const value = text(fact.path);
  return value !== undefined && path.isAbsolute(value) ? value : undefined;
}

/** The name to show: what the message called it, else the file's own base name. */
function displayName(fact: MediaFact, file: string): string {
  const named = text(fact.fileName) ?? text(fact.name) ?? path.basename(file);
  return named.slice(0, NAME_MAX);
}

/** A bounded record of identities already taken in, so a re-delivery never adds a second copy of the same file. */
function seenTracker(capacity: number): (key: string) => boolean {
  const seen = new Set<string>();
  const order: string[] = [];
  return (key) => {
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    order.push(key);
    if (order.length > capacity) {
      const dropped = order.shift();
      if (dropped !== undefined) {
        seen.delete(dropped);
      }
    }
    return true;
  };
}

/**
 * Watches `message_received` events and puts each attachment that already has a local file into the vault.
 * Returns a handler that never throws and never blocks the caller.
 */
export function createChatIntake(deps: ChatIntakeDeps): (event: unknown) => void {
  const remember = seenTracker(SEEN_LIMIT);
  const limit = deps.maxPerMessage ?? DEFAULT_MAX_PER_MESSAGE;
  const warn = (message: string) => deps.logger?.warn(message);

  const ingest = async (event: Record<string, unknown>): Promise<void> => {
    // The host withholds `media` until staging completes; `originalMedia` is then the not-yet-local list, not a fallback.
    if (event.mediaStagingPending === true) {
      return;
    }
    const facts = event.media;
    if (!Array.isArray(facts) || facts.length === 0) {
      return;
    }
    const sessionKey = text(event.sessionKey) ?? "";
    const messageId = text(event.messageId) ?? "";
    if (sessionKey === "" && messageId === "") {
      // Without a message identity a re-delivery cannot be recognised, and `sourceRef` would say nothing useful.
      return;
    }
    const principal = deps.resolvePrincipal();
    if (principal === undefined) {
      return;
    }
    let taken = 0;
    for (const [index, raw] of facts.entries()) {
      // Remembered before the cap is applied: an attachment skipped because this message carried too many must not slip in
      // on a re-delivery of the same message, or one message would end up contributing more than `limit` files.
      if (!remember(`${sessionKey}#${messageId}#${index}`)) {
        continue;
      }
      if (taken >= limit) {
        continue;
      }
      if (raw === null || typeof raw !== "object") {
        continue;
      }
      const fact = raw as MediaFact;
      const file = localPath(fact);
      if (file === undefined) {
        continue;
      }
      taken += 1;
      try {
        const outcome = await deps.vault.ingestChatMedia(principal, {
          path: file,
          displayName: displayName(fact, file),
          sessionKey,
          messageId,
          importedBy: deps.importedBy,
        });
        if (outcome.outcome !== "ok") {
          // Refusals are expected (a file over the limit, a format the vault will not keep); only note them.
          warn(`vault: chat attachment not taken in (${JSON.stringify(outcome).slice(0, 200)})`);
        }
      } catch (error) {
        warn(`vault: chat attachment failed: ${String(error)}`);
      }
    }
  };

  return voidHook(ingest, warn, "chat intake");
}

/** The hook body: starts the work and returns at once, so a delivery never waits on the vault. */
function voidHook(
  ingest: (event: Record<string, unknown>) => Promise<void>,
  warn: (message: string) => void,
  label: string,
): (event: unknown) => void {
  return (event: unknown): void => {
    if (event === null || typeof event !== "object") {
      return;
    }
    void ingest(event as Record<string, unknown>).catch((error: unknown) => {
      warn(`vault: ${label} failed: ${String(error)}`);
    });
  };
}

/** The part of a reply payload this module reads: the files the agent sends with its answer. */
type ReplyPayloadFacts = {
  mediaUrl?: unknown;
  mediaUrls?: unknown;
};

const REMOTE = /^(?:https?|data|media|blob):/iu;

/** A `file:` URL as a path this machine can open; anything that is not local media is skipped. */
function localReplyPath(value: unknown): string | undefined {
  const raw = text(value);
  if (raw === undefined) {
    return undefined;
  }
  if (raw.startsWith("file:")) {
    try {
      return decodeURIComponent(new URL(raw).pathname);
    } catch {
      return undefined;
    }
  }
  // A URL of any other scheme names a file the vault does not hold; fetching it is not this hook's business.
  return REMOTE.test(raw) ? undefined : path.isAbsolute(raw) ? raw : undefined;
}

/**
 * Watches `reply_payload_sending` and files the local files the agent sends with a reply, so "what the assistant gave me"
 * is in the library next to "what I gave it". Only the final payload counts: tool and block payloads are the same reply in
 * pieces and would otherwise file one file several times.
 */
export function createReplyIntake(deps: ChatIntakeDeps): (event: unknown) => void {
  const remember = seenTracker(SEEN_LIMIT);
  const limit = deps.maxPerMessage ?? DEFAULT_MAX_PER_MESSAGE;
  const warn = (message: string) => deps.logger?.warn(message);

  const ingest = async (event: Record<string, unknown>): Promise<void> => {
    if (event.kind !== "final") {
      return;
    }
    const payload = event.payload;
    if (payload === null || typeof payload !== "object") {
      return;
    }
    const bag = payload as ReplyPayloadFacts;
    const listed = Array.isArray(bag.mediaUrls) ? bag.mediaUrls : [];
    const urls = [...listed, bag.mediaUrl].filter((value) => value !== undefined);
    if (urls.length === 0) {
      return;
    }
    const sessionKey = text(event.sessionKey) ?? "";
    const runId = text(event.runId);
    // A reply has no message id of its own at this point; the run is what ties the files back to the answer that carried
    // them, and `sent` keeps the reference readable when even that is missing.
    const messageId = runId === undefined ? "sent" : `sent:${runId}`;
    const principal = deps.resolvePrincipal();
    if (principal === undefined) {
      return;
    }
    let taken = 0;
    for (const [index, raw] of urls.entries()) {
      const file = localReplyPath(raw);
      if (file === undefined) {
        continue;
      }
      // The path is part of the identity: one reply may send the same name twice from different places.
      if (!remember(`out#${sessionKey}#${messageId}#${index}#${file}`)) {
        continue;
      }
      if (taken >= limit) {
        continue;
      }
      taken += 1;
      try {
        const outcome = await deps.vault.ingestChatMedia(principal, {
          path: file,
          displayName: path.basename(file).slice(0, NAME_MAX),
          sessionKey,
          messageId,
          importedBy: deps.importedBy,
        });
        if (outcome.outcome !== "ok") {
          warn(`vault: reply attachment not taken in (${JSON.stringify(outcome).slice(0, 200)})`);
        }
      } catch (error) {
        warn(`vault: reply attachment failed: ${String(error)}`);
      }
    }
  };

  return voidHook(ingest, warn, "reply intake");
}
