// Collects the models OpenClaw is configured with and maps complexity tiers onto them.
import { splitModelRef, type Tier } from "./tiers.js";

/** Providers the installer registers for the local llama.cpp model. */
export const LOCAL_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "llama-local-fallback",
  "llama-existing",
]);

/** The subset of a model catalog row this plugin reads. */
export type CatalogEntryLike = {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: readonly string[];
  providerOrder?: number;
};

export type Candidate = {
  ref: string;
  provider: string;
  model: string;
  name: string;
  local: boolean;
  reasoning: boolean;
  vision: boolean;
  /** Configured input+output price; null when unknown. */
  cost: number | null;
  /** Provider-owned strongest-first order; null when unknown. */
  order: number | null;
};

export type TierPlan = Partial<Record<Tier, string>> & { defaultRef?: string };

const LIGHT_NAME = /(mini|flash|haiku|lite|small|nano|tiny|turbo|air|(^|[^0-9])[1-9](\.\d)?b\b)/iu;
const REASONING_NAME = /(reason|thinking|(^|[^a-z])r1([^0-9]|$)|(^|[^a-z])o[134](-|$)|qwq|opus)/iu;
const LOOPBACK_URL = /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?(\/|$)/iu;

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function pushRef(out: string[], seen: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const ref = value.trim();
  if (!splitModelRef(ref) || seen.has(ref)) {
    return;
  }
  seen.add(ref);
  out.push(ref);
}

function collectAgentModelRefs(agentConfig: unknown, out: string[], seen: Set<string>): void {
  const agent = asRecord(agentConfig);
  const model = agent.model;
  if (typeof model === "string") {
    pushRef(out, seen, model);
  } else {
    const selection = asRecord(model);
    pushRef(out, seen, selection.primary);
    for (const fallback of asArray(selection.fallbacks)) {
      pushRef(out, seen, fallback);
    }
  }
  for (const ref of Object.keys(asRecord(agent.models))) {
    pushRef(out, seen, ref);
  }
}

/** The agent's fallback chain, in order (the default cloud model is usually first). */
export function readFallbackRefs(config: unknown, agentId?: string): string[] {
  const agents = asRecord(asRecord(config).agents);
  const own = asArray(agents.list).find((entry) => asRecord(entry).id === agentId);
  for (const source of [own, agents.defaults]) {
    const model = asRecord(source).model;
    if (model && typeof model === "object") {
      const fallbacks = asArray(asRecord(model).fallbacks).filter(
        (ref): ref is string => typeof ref === "string",
      );
      if (fallbacks.length > 0) {
        return fallbacks;
      }
    }
  }
  return [];
}

/**
 * Every model the config names: the agent's primary and fallbacks, the model
 * picker entries (agents.*.models) and all custom provider models.
 */
export function collectConfiguredModelRefs(config: unknown, agentId?: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const root = asRecord(config);
  const agents = asRecord(root.agents);
  const own = asArray(agents.list).find((entry) => asRecord(entry).id === agentId);
  if (own) {
    collectAgentModelRefs(own, out, seen);
  }
  collectAgentModelRefs(agents.defaults, out, seen);
  for (const [providerId, provider] of Object.entries(asRecord(asRecord(root.models).providers))) {
    for (const model of asArray(asRecord(provider).models)) {
      const id = asRecord(model).id;
      if (typeof id === "string" && id.trim()) {
        pushRef(out, seen, `${providerId}/${id.trim()}`);
      }
    }
  }
  return out;
}

function providerConfig(config: unknown, providerId: string): Record<string, unknown> {
  const providers = asRecord(asRecord(asRecord(config).models).providers);
  return asRecord(providers[providerId] ?? providers[providerId.toLowerCase()]);
}

export function buildCandidates(params: {
  refs: readonly string[];
  config: unknown;
  catalog?: readonly CatalogEntryLike[];
  adaptiveRef: string;
  exclude?: readonly string[];
}): Candidate[] {
  const adaptive = splitModelRef(params.adaptiveRef);
  const exclude = new Set(params.exclude ?? []);
  const out: Candidate[] = [];
  for (const ref of params.refs) {
    const parts = splitModelRef(ref);
    if (!parts || ref === params.adaptiveRef || parts.provider === adaptive?.provider) {
      continue;
    }
    if (exclude.has(ref) || exclude.has(parts.provider)) {
      continue;
    }
    const provider = providerConfig(params.config, parts.provider);
    const modelConfig = asRecord(
      asArray(provider.models).find((entry) => asRecord(entry).id === parts.model),
    );
    const entry = params.catalog?.find(
      (row) => row.provider === parts.provider && row.id === parts.model,
    );
    const input = (entry?.input ?? asArray(modelConfig.input)) as readonly unknown[];
    const cost = asRecord(modelConfig.cost);
    const price = (Number(cost.input) || 0) + (Number(cost.output) || 0);
    const baseUrl = typeof provider.baseUrl === "string" ? provider.baseUrl : "";
    const name =
      entry?.name ?? (typeof modelConfig.name === "string" ? modelConfig.name : parts.model);
    out.push({
      ref,
      provider: parts.provider,
      model: parts.model,
      name,
      local: LOCAL_PROVIDER_IDS.has(parts.provider) || LOOPBACK_URL.test(baseUrl),
      reasoning:
        entry?.reasoning === true ||
        modelConfig.reasoning === true ||
        REASONING_NAME.test(parts.model),
      vision: input.includes("image"),
      cost: price > 0 ? price : null,
      order: typeof entry?.providerOrder === "number" ? entry.providerOrder : null,
    });
  }
  return out;
}

/**
 * Maps tiers onto candidates. SIMPLE: the local model. COMPLEX: the default
 * model (explicit, else the agent's first non-local fallback). MEDIUM: a
 * cheaper model when one is identifiable (lower configured price, else a
 * "light" name). REASONING: the default when it reasons, else the strongest
 * reasoning-capable model. Pins in `overrides` win when they name a candidate.
 */
export function planTiers(
  candidates: readonly Candidate[],
  options: {
    defaultRef?: string;
    fallbackRefs?: readonly string[];
    overrides?: Partial<Record<Tier, string>>;
  } = {},
): { plan: TierPlan; notes: string[] } {
  const notes: string[] = [];
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  const remote = candidates.filter((candidate) => !candidate.local);
  const local = candidates.find((candidate) => candidate.local);
  const pick = (ref: string | undefined) => (ref && byRef.has(ref) ? ref : undefined);

  let defaultRef = pick(options.defaultRef);
  if (options.defaultRef && !defaultRef) {
    notes.push(`default model ${options.defaultRef} is not a candidate`);
  }
  defaultRef ??=
    options.fallbackRefs?.map(pick).find((ref) => ref && !byRef.get(ref)?.local) ??
    remote[0]?.ref ??
    local?.ref;
  const dflt = defaultRef ? byRef.get(defaultRef) : undefined;

  const cheaper = remote
    .filter(
      (c) =>
        c.ref !== defaultRef &&
        c.cost !== null &&
        (dflt === undefined || dflt.cost === null || c.cost < dflt.cost),
    )
    .toSorted((a, b) => (a.cost ?? 0) - (b.cost ?? 0));
  const light = remote.find((c) => c.ref !== defaultRef && LIGHT_NAME.test(c.model));
  const medium = cheaper[0]?.ref ?? light?.ref ?? defaultRef;

  let reasoning = defaultRef;
  if (!dflt?.reasoning) {
    const strongest = remote
      .filter((c) => c.reasoning)
      .toSorted(
        (a, b) =>
          (a.order ?? Number.MAX_SAFE_INTEGER) - (b.order ?? Number.MAX_SAFE_INTEGER) ||
          (b.cost ?? 0) - (a.cost ?? 0),
      )[0];
    reasoning = strongest?.ref ?? defaultRef;
  }

  const plan: TierPlan = {
    SIMPLE: local?.ref ?? medium,
    MEDIUM: medium,
    COMPLEX: defaultRef,
    REASONING: reasoning,
    ...(defaultRef ? { defaultRef } : {}),
  };
  for (const [tier, ref] of Object.entries(options.overrides ?? {}) as [Tier, string][]) {
    if (pick(ref)) {
      plan[tier] = ref;
    } else {
      notes.push(`pinned ${tier} model ${ref} is not a candidate`);
    }
  }
  return { plan, notes };
}

/**
 * The model for a request with image attachments: the planned one when it
 * accepts images, else the strongest-planned model that does.
 */
export function pickVisionCapable(
  chosenRef: string | undefined,
  plan: TierPlan,
  candidates: readonly Candidate[],
): string | undefined {
  const byRef = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
  const order = [
    chosenRef,
    plan.COMPLEX,
    plan.REASONING,
    plan.MEDIUM,
    ...candidates.map((c) => c.ref),
  ];
  return order.find((ref) => ref !== undefined && byRef.get(ref)?.vision === true);
}
