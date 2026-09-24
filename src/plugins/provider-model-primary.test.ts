/** Verifies primary provider model selection across plugin model metadata. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applyFallbackModel, applyPrimaryModel } from "./provider-model-primary.js";

describe("applyPrimaryModel", () => {
  it("normalizes retired Gemini allowlist keys before writing the primary", () => {
    const cfg = {
      agents: {
        defaults: {
          model: {
            primary: "openai/gpt-5.5",
            fallbacks: ["google/gemini-3-pro-preview"],
          },
          models: {
            "google/gemini-3-pro-preview": {
              alias: "gemini",
              params: { thinking: "high" },
            },
          },
        },
      },
    } as OpenClawConfig;

    const next = applyPrimaryModel(cfg, "google/gemini-3-pro-preview");

    expect(next.agents?.defaults?.model).toEqual({
      primary: "google/gemini-3.1-pro-preview",
      fallbacks: ["google/gemini-3.1-pro-preview"],
    });
    expect(next.agents?.defaults?.models).toEqual({
      "google/gemini-3.1-pro-preview": {
        alias: "gemini",
        params: { thinking: "high" },
      },
    });
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
