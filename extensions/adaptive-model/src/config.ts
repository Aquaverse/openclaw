// Normalizes plugins.entries.adaptive-model.config into a complete settings object.
import { isTier, type Tier } from "./tiers.js";

export const PLUGIN_ID = "adaptive-model";
export const DEFAULT_ADAPTIVE_MODEL = "litellm-router/adaptive";
export const DEFAULT_ROUTER_BASE_URL = "http://127.0.0.1:18791/v1";
export const DEFAULT_CLASSIFIER_MODEL = "local-classifier";
export const DEFAULT_TIMEOUT_MS = 5_000;
export const DEFAULT_STICKY_MINUTES = 30;
export const DEFAULT_SHORT_FOLLOW_UP_CHARS = 80;
export const DEFAULT_RECENT_TURNS = 3;

export type AdaptiveModelConfig = {
  adaptiveModel: string;
  defaultModel?: string;
  tiers: Partial<Record<Tier, string>>;
  candidates?: string[];
  exclude: string[];
  routerBaseUrl: string;
  routerKeyFile?: string;
  classifierModel: string;
  timeoutMs: number;
  stickyMinutes: number;
  shortFollowUpChars: number;
  recentTurns: number;
  leanLocalPrompt: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
        .map((entry) => entry.trim())
    : [];
}

function integerInRange(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

export function normalizeAdaptiveModelConfig(raw: unknown): AdaptiveModelConfig {
  const record = asRecord(raw);
  const tiers: Partial<Record<Tier, string>> = {};
  for (const [tier, ref] of Object.entries(asRecord(record.tiers))) {
    const value = optionalString(ref);
    if (isTier(tier) && value) {
      tiers[tier] = value;
    }
  }
  const candidates = stringList(record.candidates);
  const defaultModel = optionalString(record.defaultModel);
  const routerKeyFile = optionalString(record.routerKeyFile);
  return {
    adaptiveModel: optionalString(record.adaptiveModel) ?? DEFAULT_ADAPTIVE_MODEL,
    ...(defaultModel ? { defaultModel } : {}),
    tiers,
    ...(candidates.length > 0 ? { candidates } : {}),
    exclude: stringList(record.exclude),
    routerBaseUrl: (optionalString(record.routerBaseUrl) ?? DEFAULT_ROUTER_BASE_URL).replace(
      /\/+$/u,
      "",
    ),
    ...(routerKeyFile ? { routerKeyFile } : {}),
    classifierModel: optionalString(record.classifierModel) ?? DEFAULT_CLASSIFIER_MODEL,
    timeoutMs: integerInRange(record.timeoutMs, 500, 20_000, DEFAULT_TIMEOUT_MS),
    stickyMinutes: integerInRange(record.stickyMinutes, 0, 1_440, DEFAULT_STICKY_MINUTES),
    shortFollowUpChars: integerInRange(
      record.shortFollowUpChars,
      0,
      2_000,
      DEFAULT_SHORT_FOLLOW_UP_CHARS,
    ),
    recentTurns: integerInRange(record.recentTurns, 0, 10, DEFAULT_RECENT_TURNS),
    leanLocalPrompt: record.leanLocalPrompt !== false,
  };
}

/** Reads this plugin's config block from a (live) OpenClaw config object. */
export function readPluginConfigBlock(config: unknown): unknown {
  const entries = asRecord(asRecord(asRecord(config).plugins).entries);
  return asRecord(entries[PLUGIN_ID]).config;
}
