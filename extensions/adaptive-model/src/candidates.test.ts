import { describe, expect, it } from "vitest";
import {
  buildCandidates,
  collectConfiguredModelRefs,
  pickVisionCapable,
  planTiers,
  readFallbackRefs,
} from "./candidates.js";

const config = {
  agents: {
    defaults: {
      model: {
        primary: "litellm-router/adaptive",
        fallbacks: ["vllm/big-cloud", "llama-local-fallback/openclaw-local-fallback"],
      },
      models: {
        "anthropic/claude-opus-5": {},
        "openai-codex/gpt-5.5": {},
        "vllm/big-cloud": {},
      },
    },
  },
  models: {
    providers: {
      vllm: {
        baseUrl: "https://cloud.example/v1",
        models: [{ id: "big-cloud", cost: { input: 3, output: 15 } }, { id: "qwen3-flash" }],
      },
      "llama-local-fallback": {
        baseUrl: "http://127.0.0.1:8687/v1",
        models: [{ id: "openclaw-local-fallback" }],
      },
      "litellm-router": { baseUrl: "http://127.0.0.1:18791/v1", models: [{ id: "adaptive" }] },
    },
  },
};

describe("collectConfiguredModelRefs", () => {
  it("collects primary, fallbacks, picker entries and custom provider models once", () => {
    expect(collectConfiguredModelRefs(config)).toEqual([
      "litellm-router/adaptive",
      "vllm/big-cloud",
      "llama-local-fallback/openclaw-local-fallback",
      "anthropic/claude-opus-5",
      "openai-codex/gpt-5.5",
      "vllm/qwen3-flash",
    ]);
  });

  it("prefers the agent's own fallbacks", () => {
    const withAgent = {
      ...config,
      agents: { ...config.agents, list: [{ id: "work", model: { fallbacks: ["x/y"] } }] },
    };
    expect(readFallbackRefs(withAgent, "work")).toEqual(["x/y"]);
    expect(readFallbackRefs(withAgent, "other")).toEqual(config.agents.defaults.model.fallbacks);
  });
});

describe("buildCandidates + planTiers", () => {
  const catalog = [
    {
      provider: "anthropic",
      id: "claude-opus-5",
      name: "Claude Opus 5",
      reasoning: true,
      input: ["text", "image"],
      providerOrder: 0,
    },
    {
      provider: "openai-codex",
      id: "gpt-5.5",
      name: "GPT-5.5",
      reasoning: true,
      input: ["text", "image"],
      providerOrder: 1,
    },
  ];
  const candidates = buildCandidates({
    refs: collectConfiguredModelRefs(config),
    config,
    catalog,
    adaptiveRef: "litellm-router/adaptive",
  });

  it("drops the adaptive model's own provider and marks the local model", () => {
    expect(candidates.map((c) => c.ref)).toEqual([
      "vllm/big-cloud",
      "llama-local-fallback/openclaw-local-fallback",
      "anthropic/claude-opus-5",
      "openai-codex/gpt-5.5",
      "vllm/qwen3-flash",
    ]);
    expect(candidates.find((c) => c.local)?.ref).toBe(
      "llama-local-fallback/openclaw-local-fallback",
    );
    expect(candidates.find((c) => c.ref === "anthropic/claude-opus-5")).toMatchObject({
      reasoning: true,
      vision: true,
      order: 0,
    });
  });

  it("maps tiers onto the configured models", () => {
    const { plan, notes } = planTiers(candidates, {
      fallbackRefs: readFallbackRefs(config),
    });
    expect(notes).toEqual([]);
    expect(plan).toEqual({
      SIMPLE: "llama-local-fallback/openclaw-local-fallback",
      MEDIUM: "vllm/qwen3-flash",
      COMPLEX: "vllm/big-cloud",
      REASONING: "anthropic/claude-opus-5",
      defaultRef: "vllm/big-cloud",
    });
  });

  it("applies pins and reports unknown ones", () => {
    const { plan, notes } = planTiers(candidates, {
      defaultRef: "openai-codex/gpt-5.5",
      overrides: { MEDIUM: "vllm/big-cloud", SIMPLE: "nope/x" },
    });
    expect(plan.COMPLEX).toBe("openai-codex/gpt-5.5");
    expect(plan.REASONING).toBe("openai-codex/gpt-5.5");
    expect(plan.MEDIUM).toBe("vllm/big-cloud");
    expect(notes).toEqual(["pinned SIMPLE model nope/x is not a candidate"]);
  });

  it("honours exclusions by ref and by provider", () => {
    const filtered = buildCandidates({
      refs: collectConfiguredModelRefs(config),
      config,
      adaptiveRef: "litellm-router/adaptive",
      exclude: ["anthropic", "vllm/qwen3-flash"],
    });
    expect(filtered.map((c) => c.ref)).toEqual([
      "vllm/big-cloud",
      "llama-local-fallback/openclaw-local-fallback",
      "openai-codex/gpt-5.5",
    ]);
  });

  it("switches image requests to a vision-capable model", () => {
    const { plan } = planTiers(candidates, { fallbackRefs: readFallbackRefs(config) });
    expect(pickVisionCapable(plan.SIMPLE, plan, candidates)).toBe("anthropic/claude-opus-5");
    expect(pickVisionCapable("openai-codex/gpt-5.5", plan, candidates)).toBe(
      "openai-codex/gpt-5.5",
    );
  });
});
