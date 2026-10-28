// The hook side of the creation chat: which user messages of a turn belong to the user's words, and which message is only
// the page's opener. Pure functions (no store, no SDK) so they can be tested with plain objects.
import { createHash } from "node:crypto";
import { tr, type Lang, type MsgKey } from "../i18n.js";
import type { Principal } from "../store/types.js";
import {
  GOAL_CREATION_REMINDER,
  goalCreationGuide,
  goalReviewNudge,
  NEXUS_GOAL_PROTOCOL,
} from "./goal-prompt.js";
import type { GoalService } from "./goal-service.js";

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

export type GoalTurnContext = {
  /** System text for this turn: always the goals protocol, plus the creation guide in a creation chat. */
  protocols: string[];
  /** Short notes placed beside the user's message (the creation reminder, or the review reminder; never both). */
  context: string[];
};

/**
 * What the goals module adds to one user turn (the `before_prompt_build` hook). In a chat the Goals page opened (it holds a
 * single-use creation grant for this session) the guide for the category is added and what the user types is kept as the
 * words of the goal; in any other chat, goals the user asked to look back on that have come due are named once. A store
 * failure costs the extras, never the turn: the protocol text is returned regardless.
 */
export async function goalTurnContext(
  goals: Pick<GoalService, "activeGrant" | "captureReply" | "get" | "reviewNudge">,
  principal: Principal,
  sessionKey: string | undefined,
  event: unknown,
  logger?: { warn: (message: string) => void },
): Promise<GoalTurnContext> {
  const out: GoalTurnContext = { protocols: [NEXUS_GOAL_PROTOCOL], context: [] };
  if (!sessionKey) {
    return out;
  }
  try {
    const grant = await goals.activeGrant(principal, sessionKey);
    if (grant) {
      for (const turn of userTurnsFrom(event)) {
        if (!isCreationOpener(turn.text)) {
          await goals.captureReply(principal, {
            sessionKey,
            messageKey: turn.key,
            text: turn.text,
          });
        }
      }
      const parent = grant.parentId ? await goals.get(principal, grant.parentId, 1) : undefined;
      out.protocols.push(goalCreationGuide(grant.category, parent?.goal.title));
      out.context.push(GOAL_CREATION_REMINDER);
    } else {
      const nudge = goalReviewNudge(await goals.reviewNudge(principal));
      if (nudge) {
        out.context.push(nudge);
      }
    }
  } catch (error) {
    logger?.warn(
      `nexus-agent-core: goal turn context skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return out;
}
