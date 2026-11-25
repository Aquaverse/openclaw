import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelSupportsPiiReplace, resolvePiiReplaceRequestMetadata } from "./pii-replace.js";

describe("modelSupportsPiiReplace", () => {
  const config: OpenClawConfig = {
    models: {
      providers: {
        vllm: {
          baseUrl: "https://example.test/v1",
          api: "openai-completions",
          models: [
            { id: "enabled", name: "Enabled", params: { supportsPiiReplace: true } },
            { id: "plain", name: "Plain" },
          ],
        },
      },
    },
  };

  it("requires the capability on the exact configured model", () => {
    expect(modelSupportsPiiReplace({ config, provider: "vllm", model: "enabled" })).toBe(true);
    expect(modelSupportsPiiReplace({ config, provider: "vllm", model: "plain" })).toBe(false);
    expect(modelSupportsPiiReplace({ config, provider: "other", model: "enabled" })).toBe(false);
  });

  it.each([
    ["enabled", undefined, undefined],
    ["enabled", true, { pii_replace: true }],
    ["enabled", false, { pii_replace: false }],
    ["plain", true, undefined],
  ] as const)("projects %s with preference %s to %s", (model, piiReplace, expected) => {
    expect(
      resolvePiiReplaceRequestMetadata({ config, provider: "vllm", model, piiReplace }),
    ).toEqual(expected);
  });
});
