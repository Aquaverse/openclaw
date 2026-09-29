import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("openclaw/plugin-sdk/agent-runtime", () => ({
  getPreparedModelCatalogSnapshot: () => ({
    entries: [
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
        input: ["text"],
        providerOrder: 1,
      },
    ],
    routeVariants: [],
  }),
}));

import plugin from "./index.js";

type Handler = (
  event: { prompt: string; attachments?: { kind: string }[] },
  ctx: Record<string, unknown>,
) => Promise<{ providerOverride?: string; modelOverride?: string } | undefined>;

const config = {
  agents: {
    defaults: {
      model: {
        primary: "litellm-router/adaptive",
        fallbacks: ["vllm/big-cloud", "llama-local-fallback/openclaw-local-fallback"],
      },
      models: { "anthropic/claude-opus-5": {}, "openai-codex/gpt-5.5": {} },
    },
  },
  models: {
    providers: {
      vllm: {
        baseUrl: "https://cloud.example/v1",
        models: [{ id: "big-cloud" }, { id: "qwen3-flash" }],
      },
      "llama-local-fallback": {
        baseUrl: "http://127.0.0.1:8687/v1",
        models: [{ id: "openclaw-local-fallback" }],
      },
      "litellm-router": { baseUrl: "http://127.0.0.1:18791/v1", models: [{ id: "adaptive" }] },
    },
  },
};

function setup(unavailableProvider = "openai-codex") {
  const stateDir = mkdtempSync(path.join(tmpdir(), "adaptive-model-"));
  mkdirSync(path.join(stateDir, "litellm"));
  writeFileSync(path.join(stateDir, "litellm", "master.key"), "sk-router\n");
  let handler: Handler | undefined;
  let promptBuild: PromptBuildHandler | undefined;
  const logs: string[] = [];
  const api = {
    pluginConfig: {},
    logger: {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
      error: () => {},
      debug: () => {},
    },
    runtime: {
      config: { current: () => config },
      state: { resolveStateDir: () => stateDir },
      modelAuth: {
        resolveApiKeyForProvider: async ({ provider }: { provider: string }) => {
          if (provider === unavailableProvider) {
            throw new Error("no auth");
          }
          return { apiKey: "x", source: "test", mode: "api-key" };
        },
      },
    },
    on: (name: string, fn: unknown) => {
      if (name === "before_model_resolve") {
        handler = fn as Handler;
      }
      if (name === "before_prompt_build") {
        promptBuild = fn as PromptBuildHandler;
      }
    },
  };
  (plugin as unknown as { register: (a: unknown) => void }).register(api);
  if (!handler || !promptBuild) {
    throw new Error("hooks not registered");
  }
  return { handler, promptBuild, logs };
}

function classifierReplies(...labels: (string | Error)[]) {
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: { body: string; headers: Record<string, string> }) => {
      bodies.push({
        ...(JSON.parse(init.body) as Record<string, unknown>),
        auth: init.headers.Authorization,
      });
      const next = labels.shift();
      if (next instanceof Error || next === undefined) {
        throw next ?? new Error("unexpected call");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: next } }] }),
      };
    }),
  );
  return bodies;
}

type PromptBuildHandler = (
  event: { prompt: string; messages: unknown[] },
  ctx: Record<string, unknown>,
) => { systemPrompt?: string; toolsAllow?: string[] } | undefined;

const adaptiveCtx = { sessionKey: "s1", modelProviderId: "litellm-router", modelId: "adaptive" };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("adaptive-model hook", () => {
  it("leaves an explicitly selected model alone", async () => {
    const { handler } = setup();
    const bodies = classifierReplies();
    await expect(
      handler(
        { prompt: "hi" },
        { sessionKey: "s1", modelProviderId: "vllm", modelId: "big-cloud" },
      ),
    ).resolves.toBeUndefined();
    expect(bodies).toEqual([]);
  });

  it("routes by tier, keeps short follow-ups on the stronger model and re-routes new topics", async () => {
    const { handler } = setup();
    const bodies = classifierReplies(
      '{"tier":"SIMPLE","follow_up":false}',
      '{"tier":"COMPLEX","follow_up":false}',
      '{"tier":"SIMPLE","follow_up":true}',
      '{"tier":"SIMPLE","follow_up":false}',
    );
    await expect(handler({ prompt: "你好" }, adaptiveCtx)).resolves.toEqual({
      providerOverride: "llama-local-fallback",
      modelOverride: "openclaw-local-fallback",
    });
    await expect(
      handler({ prompt: "Refactor this module and add tests" }, adaptiveCtx),
    ).resolves.toEqual({
      providerOverride: "vllm",
      modelOverride: "big-cloud",
    });
    await expect(handler({ prompt: "好的，继续" }, adaptiveCtx)).resolves.toEqual({
      providerOverride: "vllm",
      modelOverride: "big-cloud",
    });
    await expect(
      handler(
        {
          prompt:
            "By the way, what is the capital of France? Just curious, nothing to do with the code.",
        },
        adaptiveCtx,
      ),
    ).resolves.toEqual({
      providerOverride: "llama-local-fallback",
      modelOverride: "openclaw-local-fallback",
    });
    expect(bodies[0]?.auth).toBe("Bearer sk-router");
    expect(JSON.stringify(bodies[2]?.messages)).toContain("Refactor this module");
  });

  it("uses the strongest reasoning model that has credentials", async () => {
    classifierReplies(
      '{"tier":"REASONING","follow_up":false}',
      '{"tier":"REASONING","follow_up":false}',
    );
    await expect(setup().handler({ prompt: "Prove it" }, adaptiveCtx)).resolves.toEqual({
      providerOverride: "anthropic",
      modelOverride: "claude-opus-5",
    });
    await expect(setup("anthropic").handler({ prompt: "Prove it" }, adaptiveCtx)).resolves.toEqual({
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.5",
    });
  });

  it("moves image requests to a vision-capable model", async () => {
    const { handler } = setup();
    classifierReplies('{"tier":"SIMPLE","follow_up":false}');
    await expect(
      handler({ prompt: "what is this?", attachments: [{ kind: "image" }] }, adaptiveCtx),
    ).resolves.toEqual({ providerOverride: "anthropic", modelOverride: "claude-opus-5" });
  });

  it("falls back to the router without history, and to the conversation's tier with it", async () => {
    const { handler, logs } = setup();
    classifierReplies(new Error("down"), '{"tier":"COMPLEX","follow_up":false}', new Error("down"));
    await expect(handler({ prompt: "hi" }, adaptiveCtx)).resolves.toBeUndefined();
    await expect(handler({ prompt: "Build me a parser" }, adaptiveCtx)).resolves.toEqual({
      providerOverride: "vllm",
      modelOverride: "big-cloud",
    });
    await expect(handler({ prompt: "and now?" }, adaptiveCtx)).resolves.toEqual({
      providerOverride: "vllm",
      modelOverride: "big-cloud",
    });
    expect(logs.some((line) => line.includes("classification failed (down)"))).toBe(true);
  });

  it("gives local turns a short chat-only prompt without tools, and only those", async () => {
    const { handler, promptBuild } = setup();
    classifierReplies(
      '{"tier":"SIMPLE","follow_up":false}',
      '{"tier":"COMPLEX","follow_up":false}',
    );
    const localRun = { ...adaptiveCtx, runId: "r1" };
    await handler({ prompt: "你好" }, localRun);
    const onLocal = promptBuild(
      { prompt: "你好", messages: [] },
      { runId: "r1", modelProviderId: "llama-local-fallback", modelId: "openclaw-local-fallback" },
    );
    expect(onLocal?.toolsAllow).toEqual([]);
    expect(onLocal?.systemPrompt).toContain("no tools");
    // The same run after falling back to a cloud model gets the normal prompt.
    expect(
      promptBuild(
        { prompt: "你好", messages: [] },
        { runId: "r1", modelProviderId: "vllm", modelId: "big-cloud" },
      ),
    ).toBeUndefined();
    await handler(
      { prompt: "Refactor this module and add tests" },
      { ...adaptiveCtx, runId: "r2" },
    );
    expect(
      promptBuild(
        { prompt: "x", messages: [] },
        { runId: "r2", modelProviderId: "vllm", modelId: "big-cloud" },
      ),
    ).toBeUndefined();
    // An explicitly selected local model keeps the full agent prompt.
    expect(
      promptBuild(
        { prompt: "x", messages: [] },
        {
          runId: "r3",
          modelProviderId: "llama-local-fallback",
          modelId: "openclaw-local-fallback",
        },
      ),
    ).toBeUndefined();
  });
});
