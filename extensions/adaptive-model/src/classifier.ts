// Asks the local model, through the LiteLLM router's OpenAI-compatible API,
// how demanding a message is. It only labels the message; it never answers it.
import { TIERS, isTier, type Tier } from "./tiers.js";

export type Classification = { tier: Tier; followUp: boolean };

export type FetchLike = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

const MESSAGE_HEAD_CHARS = 1_500;
const MESSAGE_TAIL_CHARS = 500;

export const CLASSIFIER_SYSTEM_PROMPT = [
  "You label a user's message for a model router. Reply with JSON only.",
  "tier:",
  "- SIMPLE: greetings, small talk, thanks, a short factual question, translating or rewording a sentence.",
  "- MEDIUM: everyday tasks: explanations, summaries, short emails or documents, small code snippets.",
  "- COMPLEX: multi-step or long work: writing or debugging real code, analysing long text or data, planning, tasks that need tools or several steps.",
  "- REASONING: hard problems that need careful step-by-step reasoning: math, proofs, tricky logic, architecture or strategy decisions.",
  "follow_up: true when the message only continues the earlier conversation instead of starting a new, self-contained request",
  '(e.g. "continue", "ok, do it", "why?", "fix the second point", "继续", "好的", "第二点再改一下", "为什么").',
  "Judge a follow-up by the earlier requests: it needs as much capability as the task it continues.",
].join("\n");

function clip(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MESSAGE_HEAD_CHARS + MESSAGE_TAIL_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MESSAGE_HEAD_CHARS)}\n…\n${trimmed.slice(-MESSAGE_TAIL_CHARS)}`;
}

export function buildClassifierMessages(message: string, recent: readonly string[]) {
  const context =
    recent.length > 0
      ? `Earlier requests in this conversation (oldest first):\n${recent
          .map((text, index) => `${index + 1}. ${text.replace(/\s+/gu, " ").trim()}`)
          .join("\n")}\n\n`
      : "";
  return [
    { role: "system", content: CLASSIFIER_SYSTEM_PROMPT },
    { role: "user", content: `${context}Message to label:\n${clip(message)}` },
  ];
}

/** Parses the classifier's reply; tolerates code fences and surrounding text. */
export function parseClassification(content: unknown): Classification | undefined {
  if (typeof content !== "string") {
    return undefined;
  }
  const match = /\{[\s\S]*\}/u.exec(content);
  if (!match) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return undefined;
  }
  const record = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const tier = typeof record.tier === "string" ? record.tier.trim().toUpperCase() : undefined;
  if (!isTier(tier)) {
    return undefined;
  }
  return { tier, followUp: record.follow_up === true };
}

export async function classifyMessage(params: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  message: string;
  recent: readonly string[];
  timeoutMs: number;
  fetchImpl?: FetchLike;
}): Promise<Classification> {
  const fetchImpl = params.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }
  const response = await fetchImpl(`${params.baseUrl}/chat/completions`, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(params.timeoutMs),
    body: JSON.stringify({
      model: params.model,
      temperature: 0,
      max_tokens: 48,
      messages: buildClassifierMessages(params.message, params.recent),
      // llama-server turns the schema into a grammar, so a small model can
      // only answer with a valid label.
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "route",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["tier", "follow_up"],
            properties: {
              tier: { type: "string", enum: [...TIERS] },
              follow_up: { type: "boolean" },
            },
          },
        },
      },
    }),
  });
  if (!response.ok) {
    throw new Error(`classifier HTTP ${response.status}`);
  }
  const body = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
  };
  const result = parseClassification(body.choices?.[0]?.message?.content);
  if (!result) {
    throw new Error("classifier returned no valid label");
  }
  return result;
}
