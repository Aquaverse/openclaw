// Text for the core approval card (DESIGN section 8.10): requireApproval only has title (80) and description (512).
// Everything comes from the server-built decision; the model's own wording never reaches the card.
import type { DecisionRecord } from "../store/decision-types.js";

export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 512;

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/gu, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

type Facts = {
  task?: { id?: string; entities?: { key: string; value: string }[] };
  candidates?: { summary?: string; reversible?: boolean }[];
};

export function renderApprovalCard(decision: DecisionRecord): {
  title: string;
  description: string;
} {
  const facts = (decision.facts ?? {}) as Facts;
  const candidate = facts.candidates?.[0];
  const entities = (facts.task?.entities ?? [])
    .slice(0, 4)
    .map((entry) => `${entry.key}=${clip(entry.value, 24)}`)
    .join("，");
  const parts = [
    candidate?.summary ?? decision.question,
    entities ? `事项信息：${entities}（模型整理，请核对）` : "",
    decision.effectKind === "issue_action_grant"
      ? `${decision.riskTier}${candidate?.reversible === false ? "，不可撤销" : ""}。批准只授权，之后我还会再调用 nexus_action_commit 才真正执行。`
      : "批准后可在有效期内按上限自动授权同类动作。",
    `决策 ${decision.id}（Nexus 决策页可查看完整内容）`,
  ].filter(Boolean);
  return {
    title: clip(decision.question, TITLE_MAX),
    description: clip(parts.join(" "), DESCRIPTION_MAX),
  };
}
