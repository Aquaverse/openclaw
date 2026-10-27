// The hook side of the creation chat: which user messages of a turn belong to the user's words, and which message is only
// the page's opener. Pure functions (no store, no SDK) so they can be tested with plain objects.
import { createHash } from "node:crypto";
import { tr, type Lang, type MsgKey } from "../i18n.js";

export type UserTurn = { key: string; text: string };

const hash = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 24);

function textOf(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const parts = content
      .map((part) =>
        typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
          ? (part as { text?: unknown }).text
          : undefined,
      )
      .filter((part): part is string => typeof part === "string");
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  return undefined;
}

/**
 * The user's own turns in a `before_prompt_build` event: the prepared history (`messages`) plus the current prompt. A key is
 * the message id when the host gives one, else a hash of the text; the store keeps each key once, so the hook may run again
 * for the same turn (retry, compaction) without duplicating anything.
 */
export function userTurnsFrom(event: unknown): UserTurn[] {
  const source = (event ?? {}) as {
    messages?: unknown;
    prompt?: unknown;
    currentUserMessageId?: unknown;
  };
  const turns: UserTurn[] = [];
  if (Array.isArray(source.messages)) {
    for (const message of source.messages) {
      if (typeof message !== "object" || message === null) {
        continue;
      }
      const m = message as Record<string, unknown>;
      if (m.role !== "user") {
        continue;
      }
      const text = textOf(m.content)?.trim();
      if (!text) {
        continue;
      }
      const id = [m.id, m.messageId].find((value) => typeof value === "string" && value !== "");
      turns.push({ key: typeof id === "string" ? `id:${id}` : `h:${hash(text)}`, text });
    }
  }
  const prompt = typeof source.prompt === "string" ? source.prompt.trim() : "";
  if (prompt && !turns.some((turn) => turn.text === prompt)) {
    const id = typeof source.currentUserMessageId === "string" ? source.currentUserMessageId : "";
    turns.push({ key: id ? `id:${id}` : `h:${hash(prompt)}`, text: prompt });
  }
  return turns;
}

const OPENER_KEYS: MsgKey[] = [
  "goal.opener.finance",
  "goal.opener.interests",
  "goal.opener.something_else",
];
const LANGS: Lang[] = ["zh", "en"];
const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The sub-goal opener names the parent goal, so it matches by shape. */
const SUB_OPENERS = LANGS.map(
  (lang) =>
    new RegExp(
      `^${escapeRegex(tr(lang, "goal.opener.sub", { title: "\u0000" })).replace("\u0000", "[\\s\\S]{1,300}")}$`,
      "u",
    ),
);

/** The Goals page starts each creation chat with a fixed sentence; it is not part of the user's words. */
export function isCreationOpener(text: string): boolean {
  const trimmed = text.trim();
  if (OPENER_KEYS.some((key) => LANGS.some((lang) => tr(lang, key) === trimmed))) {
    return true;
  }
  return SUB_OPENERS.some((pattern) => pattern.test(trimmed));
}
