import { describe, expect, it } from "vitest";
import { buildPublicModelProjection } from "./models-list-public-projection.js";

describe("model catalog PII replacement capability", () => {
  it("projects only the safe capability bit and never route metadata", () => {
    const projected = buildPublicModelProjection({
      provider: "vllm",
      id: "private-model",
      name: "Private model",
      baseUrl: "https://private.example/v1",
      params: { supportsPiiReplace: true, privateSetting: "hidden" },
    });
    expect(projected).toMatchObject({ supportsPiiReplace: true });
    expect(projected).not.toHaveProperty("baseUrl");
    expect(projected).not.toHaveProperty("params");
  });
});
