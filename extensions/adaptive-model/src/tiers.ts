// Complexity tiers shared by the classifier, the tier plan and stickiness.
export const TIERS = ["SIMPLE", "MEDIUM", "COMPLEX", "REASONING"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_RANK: Readonly<Record<Tier, number>> = {
  SIMPLE: 0,
  MEDIUM: 1,
  COMPLEX: 2,
  REASONING: 3,
};

export function isTier(value: unknown): value is Tier {
  return typeof value === "string" && (TIERS as readonly string[]).includes(value);
}

/** Splits "provider/model" at the first slash; model ids may contain slashes. */
export function splitModelRef(ref: string): { provider: string; model: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) {
    return undefined;
  }
  return { provider: trimmed.slice(0, slash), model: trimmed.slice(slash + 1) };
}
