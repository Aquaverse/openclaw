import { describe, expect, it } from "vitest";
import {
  buildClassifierMessages,
  classifyMessage,
  parseClassification,
  type FetchLike,
} from "./classifier.js";

describe("parseClassification", () => {
  it("accepts the structured answer, with or without fences", () => {
    expect(parseClassification('{"tier":"COMPLEX","follow_up":false}')).toEqual({
      tier: "COMPLEX",
      followUp: false,
    });
    expect(parseClassification('```json\n{"tier":"simple","follow_up":true}\n```')).toEqual({
      tier: "SIMPLE",
      followUp: true,
    });
  });

  it("rejects anything else", () => {
    expect(parseClassification('{"tier":"HARD"}')).toBeUndefined();
    expect(parseClassification("COMPLEX")).toBeUndefined();
    expect(parseClassification(undefined)).toBeUndefined();
  });
});

describe("classifyMessage", () => {
  it("sends the message with recent context and a strict schema through the router", async () => {
    let seen:
      | { url: string; headers: Record<string, string>; body: Record<string, unknown> }
      | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      seen = { url, headers: init.headers, body: JSON.parse(init.body) as Record<string, unknown> };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          choices: [{ message: { content: '{"tier":"REASONING","follow_up":false}' } }],
        }),
      };
    };
    await expect(
      classifyMessage({
        baseUrl: "http://127.0.0.1:18791/v1",
        apiKey: "sk-test",
        model: "local-classifier",
        message: "Prove that there are infinitely many primes.",
        recent: ["hello"],
        timeoutMs: 1_000,
        fetchImpl,
      }),
    ).resolves.toEqual({ tier: "REASONING", followUp: false });
    expect(seen?.url).toBe("http://127.0.0.1:18791/v1/chat/completions");
    expect(seen?.headers.Authorization).toBe("Bearer sk-test");
    expect(seen?.body.model).toBe("local-classifier");
    expect(JSON.stringify(seen?.body.messages)).toContain("1. hello");
    expect(JSON.stringify(seen?.body.response_format)).toContain(
      '"enum":["SIMPLE","MEDIUM","COMPLEX","REASONING"]',
    );
  });

  it("fails on HTTP errors and invalid labels", async () => {
    const reply =
      (ok: boolean, content: string): FetchLike =>
      async () => ({
        ok,
        status: ok ? 200 : 401,
        json: async () => ({ choices: [{ message: { content } }] }),
      });
    const params = {
      baseUrl: "http://x/v1",
      model: "m",
      message: "hi",
      recent: [],
      timeoutMs: 1_000,
    };
    await expect(classifyMessage({ ...params, fetchImpl: reply(false, "") })).rejects.toThrow(
      "HTTP 401",
    );
    await expect(classifyMessage({ ...params, fetchImpl: reply(true, "nope") })).rejects.toThrow(
      "no valid label",
    );
  });

  it("clips very long messages", () => {
    const [, user] = buildClassifierMessages("x".repeat(10_000), []);
    expect(user?.content.length).toBeLessThan(2_200);
  });
});
