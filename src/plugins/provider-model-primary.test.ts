import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyFallbackModel, applyPrimaryModel } from "./provider-model-primary.js";

type Defaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type PrimaryCase = {
  name: string;
  defaults: Defaults;
  model: string;
  options?: Parameters<typeof applyPrimaryModel>[2];
  expectedModel: Defaults["model"];
  expectedModels: Defaults["models"];
};

const cases: PrimaryCase[] = [
  {
    name: "normalizes retired Gemini allowlist keys and fallbacks before writing the primary",
    defaults: {
      model: { primary: "openai/gpt-5.5", fallbacks: ["google/gemini-3-pro-preview"] },
      models: {
        "google/gemini-3-pro-preview": { alias: "gemini", params: { thinking: "high" } },
      },
    },
    model: "google/gemini-3-pro-preview",
    expectedModel: {
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    },
    expectedModels: {
      "google/gemini-3.1-pro-preview": { alias: "gemini", params: { thinking: "high" } },
    },
  },
  {
    name: "normalizes a preserved retired Google Gemini primary",
    defaults: { model: { primary: "google/gemini-3-pro-preview" } },
    model: "openrouter/auto",
    options: { preserveExistingPrimary: true },
    expectedModel: { primary: "google/gemini-3.1-pro-preview" },
    expectedModels: { "openrouter/auto": {} },
  },
  {
    name: "preserves an existing primary and keeps fallbacks",
    defaults: {
      model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.4"] },
    },
    model: "openrouter/auto",
    options: { preserveExistingPrimary: true },
    expectedModel: {
      primary: "anthropic/claude-opus-4-6",
      fallbacks: ["openai/gpt-5.4"],
    },
    expectedModels: { "openrouter/auto": {} },
  },
  {
    name: "normalizes retired Google Gemini default models before writing config",
    defaults: { models: { "anthropic/claude-sonnet-4-6": {} } },
    model: "google/gemini-3-pro-preview",
    expectedModel: { primary: "google/gemini-3.1-pro-preview" },
    expectedModels: {
      "anthropic/claude-sonnet-4-6": {},
      "google/gemini-3.1-pro-preview": {},
    },
  },
];

describe("applyPrimaryModel", () => {
  it.each(cases)("$name", ({ defaults, model, options, expectedModel, expectedModels }) => {
    const next = applyPrimaryModel({ agents: { defaults } }, model, options);
    expect(next.agents?.defaults?.model).toEqual(expectedModel);
    expect(next.agents?.defaults?.models).toEqual(expectedModels);
  });
});

describe("applyFallbackModel", () => {
  it("appends a fallback without changing the primary model", () => {
    const cfg = {
      agents: { defaults: { model: "vllm/publicModelDefault" } },
    } as OpenClawConfig;

    const next = applyFallbackModel(cfg, "llama-local-fallback/openclaw-local-fallback");

    expect(next.agents?.defaults?.model).toEqual({
      primary: "vllm/publicModelDefault",
      fallbacks: ["llama-local-fallback/openclaw-local-fallback"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "llama-local-fallback/openclaw-local-fallback": {},
    });
  });

  it("is idempotent for an existing fallback or primary", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "vllm/publicModelDefault",
            fallbacks: ["llama-local-fallback/openclaw-local-fallback"],
          },
        },
      },
    } as OpenClawConfig;

    const again = applyFallbackModel(cfg, "llama-local-fallback/openclaw-local-fallback");
    expect(again.agents?.defaults?.model).toEqual({
      primary: "vllm/publicModelDefault",
      fallbacks: ["llama-local-fallback/openclaw-local-fallback"],
    });

    const primary = applyFallbackModel(cfg, "vllm/publicModelDefault");
    expect(primary.agents?.defaults?.model).toEqual({
      primary: "vllm/publicModelDefault",
      fallbacks: ["llama-local-fallback/openclaw-local-fallback"],
    });
  });

  it("becomes the primary when no primary is configured", () => {
    const next = applyFallbackModel(
      {} as OpenClawConfig,
      "llama-local-fallback/openclaw-local-fallback",
    );

    expect(next.agents?.defaults?.model).toEqual({
      primary: "llama-local-fallback/openclaw-local-fallback",
    });
  });
});
