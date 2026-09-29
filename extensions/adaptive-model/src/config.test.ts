import { describe, expect, it } from "vitest";
import { normalizeAdaptiveModelConfig, readPluginConfigBlock } from "./config.js";

describe("normalizeAdaptiveModelConfig", () => {
  it("fills defaults", () => {
    expect(normalizeAdaptiveModelConfig(undefined)).toEqual({
      adaptiveModel: "litellm-router/adaptive",
      tiers: {},
      exclude: [],
      routerBaseUrl: "http://127.0.0.1:18791/v1",
      classifierModel: "local-classifier",
      timeoutMs: 5_000,
      stickyMinutes: 30,
      shortFollowUpChars: 80,
      recentTurns: 3,
      leanLocalPrompt: true,
    });
  });

  it("keeps valid values and drops invalid ones", () => {
    const config = normalizeAdaptiveModelConfig({
      defaultModel: " vllm/big ",
      tiers: { MEDIUM: "a/b", BOGUS: "c/d", COMPLEX: "" },
      candidates: ["a/b", 3],
      routerBaseUrl: "http://127.0.0.1:1/v1/",
      timeoutMs: 99_999,
    });
    expect(config.defaultModel).toBe("vllm/big");
    expect(config.tiers).toEqual({ MEDIUM: "a/b" });
    expect(config.candidates).toEqual(["a/b"]);
    expect(config.routerBaseUrl).toBe("http://127.0.0.1:1/v1");
    expect(config.timeoutMs).toBe(5_000);
    expect(normalizeAdaptiveModelConfig({ leanLocalPrompt: false }).leanLocalPrompt).toBe(false);
  });

  it("reads the plugin block from the OpenClaw config", () => {
    expect(
      readPluginConfigBlock({ plugins: { entries: { "adaptive-model": { config: { a: 1 } } } } }),
    ).toEqual({ a: 1 });
    expect(readPluginConfigBlock({})).toBeUndefined();
  });
});
