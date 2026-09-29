// Per-conversation memory of the adaptive choice, and the stickiness rules
// that keep short follow-ups on the model the conversation is already using.
import { TIER_RANK, type Tier } from "./tiers.js";

export type SessionRoute = {
  tier: Tier;
  ref: string;
  at: number;
  /** The conversation's most recent user messages, oldest first (truncated). */
  recent: string[];
};

const RECENT_MESSAGE_CHARS = 300;

/** Small in-memory LRU keyed by session; lost on Gateway restart by design. */
export class SessionRoutes {
  private readonly routes = new Map<string, SessionRoute>();
  private readonly maxSessions: number;

  constructor(maxSessions = 500) {
    this.maxSessions = maxSessions;
  }

  get(sessionKey: string | undefined, now: number, ttlMs: number): SessionRoute | undefined {
    if (!sessionKey) {
      return undefined;
    }
    const route = this.routes.get(sessionKey);
    if (!route) {
      return undefined;
    }
    if (ttlMs <= 0 || now - route.at > ttlMs) {
      this.routes.delete(sessionKey);
      return undefined;
    }
    return route;
  }

  recentMessages(sessionKey: string | undefined): string[] {
    return (sessionKey && this.routes.get(sessionKey)?.recent) || [];
  }

  remember(
    sessionKey: string | undefined,
    route: { tier: Tier; ref: string; at: number },
    message: string,
    keepRecent: number,
  ): void {
    if (!sessionKey) {
      return;
    }
    const previous = this.routes.get(sessionKey);
    const recent =
      keepRecent > 0
        ? [...(previous?.recent ?? []), message.slice(0, RECENT_MESSAGE_CHARS)].slice(-keepRecent)
        : [];
    this.routes.delete(sessionKey);
    this.routes.set(sessionKey, { ...route, recent });
    while (this.routes.size > this.maxSessions) {
      const oldest = this.routes.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.routes.delete(oldest);
    }
  }
}

export type StickyDecision = {
  tier: Tier;
  reason: "first" | "upgrade" | "same" | "follow-up" | "short-message" | "new-topic";
};

/**
 * Upgrades immediately; downgrades only for a clearly new, self-contained
 * request -- a follow-up or a short message keeps the conversation's tier.
 */
export function applyStickiness(params: {
  classified: Tier;
  followUp: boolean;
  message: string;
  previous?: Pick<SessionRoute, "tier">;
  shortFollowUpChars: number;
}): StickyDecision {
  const { classified, previous } = params;
  if (!previous) {
    return { tier: classified, reason: "first" };
  }
  const delta = TIER_RANK[classified] - TIER_RANK[previous.tier];
  if (delta > 0) {
    return { tier: classified, reason: "upgrade" };
  }
  if (delta === 0) {
    return { tier: classified, reason: "same" };
  }
  if (params.followUp) {
    return { tier: previous.tier, reason: "follow-up" };
  }
  if (params.message.trim().length <= params.shortFollowUpChars) {
    return { tier: previous.tier, reason: "short-message" };
  }
  return { tier: classified, reason: "new-topic" };
}
