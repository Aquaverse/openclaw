// Text for the core approval card (DESIGN section 8.10): requireApproval only has title (80) and description (512).
// Everything comes from the server-built decision; the model's own wording never reaches the card.
import type { DecisionRecord } from "../store/decision-types.js";

export const TITLE_MAX = 80;
export const DESCRIPTION_MAX = 512;

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/gu, " ").trim());
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

// The card has only allow / deny: the tick-box second confirmation exists on the Nexus decision page alone (DESIGN 8.10).
const HIGH_RISK_NOTE = "高风险：这里点一次即批准；需要二次确认请到 Nexus 决策页。";

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
  const highRisk = decision.riskTier === "R2" || decision.riskTier === "R3";
  const parts = [
    candidate?.summary ?? decision.question,
    entities ? `事项信息：${entities}（模型整理，请核对）` : "",
    decision.effectKind === "issue_action_grant"
      ? `${decision.riskTier}${candidate?.reversible === false ? "，不可撤销" : ""}。批准只授权，之后我还会再调用 nexus_action_commit 才真正执行。${highRisk ? HIGH_RISK_NOTE : ""}`
      : "批准后可在有效期内按上限自动授权同类动作。",
    `决策 ${decision.id}（Nexus 决策页可查看完整内容）`,
  ].filter(Boolean);
  return {
    // R2/R3 (booking, payment): say so in the title, because this card is the same two buttons as every other approval.
    title: clip(
      highRisk ? `【${decision.riskTier}】${decision.question}` : decision.question,
      TITLE_MAX,
    ),
    description: clip(parts.join(" "), DESCRIPTION_MAX),
  };
}
