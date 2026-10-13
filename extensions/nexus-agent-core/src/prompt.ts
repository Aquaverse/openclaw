// Prompt injection for open Tasks (DESIGN section 7.1). Pure functions: the hook may run on every attempt
// (retries, compaction), so the same store state must always render the same text.
import type { TaskRecord } from "./store/types.js";

export const NEXUS_TASK_PROTOCOL = [
  "[Nexus 事项协议]",
  "Nexus 的 Task 是用户手上一件要持续几轮、甚至几天才办完的事（订机票、争议扣费……）。",
  "- 调 nexus_task_create 之前，先看下面的「进行中的事项」清单；不确定是不是同一件事，先问用户。",
  "- 新建流程：nexus_task_reserve 领令牌 → nexus_task_create。返回 created:false 并带 duplicate_override_token 时，",
  "  说明存在相近事项：先向用户确认，确认是新任务后用同一个 token 重试。",
  "- nexus_task_get / update / note 必须带明确的 taskId；没有 id 时用 nexus_task_search 找候选，不要猜。",
  "- 搜索返回 needs_user_confirmation 时，去问用户，不要自行选一个。",
  "- 你不能把事项标成成功、取消或删除；这些由 Nexus 的其他机制或用户操作完成。",
  "- entities / goal / note 只写用户明确说过的信息；出发地、预算、证件等没说过的，不要猜、不要补，缺什么就问用户。",
  "- 工具返回 ok:false 就是没成功：如实告诉用户失败，不要说已创建，更不要自己编任务号；按提示重试或问用户。",
  "- 登记事项只是记录，不是开始办理：创建或更新 Task 之后，不要因此启动子代理或自行去订票、付款；先把进展告诉用户并问下一步。",
].join("\n");

/** Appended to the protocol only when `decisionsEnabled` (Stage 2). */
export const NEXUS_ACTION_PROTOCOL = [
  "[Nexus 动作协议]",
  "对外动作（联系供应商、预订、付款）不要直接做，也不要用别的工具绕过；一律走 Nexus：",
  "- 先 nexus_action_prepare 登记动作（只是记录，不会执行）。toolName 只能是 fake_vendor_message / fake_booking / fake_payment；参数只写用户说过的内容。",
  "- 联系供应商（R1）：先 nexus_action_authorize(actionId)；返回 no_policy 时用 nexus_decision_request 征得用户同意，再 authorize。",
  "- 预订、付款（R2/R3）：用 nexus_decision_request 请用户批准（参数只有 taskId 和 effect.actionIds，不要写 kind）；批准之前什么都不会发生，不要说「已经订好」。",
  "- 只有拿到 executionId 才能 nexus_action_commit(executionId)；不要自己编 executionId，也不要重复提交。",
  "- commit 返回 pending_confirmation 或 unknown：结果未确认，不要重试，也不要对用户说成功或失败，如实说「等待确认」。",
  "- 用户拒绝是终局：不要换个办法重试同一件事，问用户想怎么办。",
  "- 决策请求返回 pending：把需要用户确认这件事告诉用户，然后停下，不要继续往下做。",
].join("\n");

/** Appended only when `claimsEnabled` (Stage 3). */
export const NEXUS_CLAIM_PROTOCOL = [
  "[Nexus 断言协议]",
  "要对用户说「已经办成了」之前，先把这句话登记成 claim，并挂上证据：",
  '- nexus_claim_add(taskId, subject, predicate="executed", value={actionId}, completion="SUPPORTED")：只能是 ASSERTED 或 UNKNOWN，状态由证据推导，你不能自己写 SUPPORTED。',
  '- commit 返回 succeeded 后，用 nexus_evidence_add(taskId, claimId, ref={kind:"execution", id:executionId}) 挂证据；返回的 stateAfter 不是 SUPPORTED 就不要说成功。',
  '- 想结束事项时才用 nexus_task_update(status="succeeded")；被 completion_unmet 拒绝说明证据不够，如实告诉用户缺什么，不要再试一遍糊弄过去。',
  "- nexus_claim_verify 只读：用它看 store 实际确认了什么，而不是看你以为确认了什么。",
].join("\n");

const MAX_TITLE = 60;
const MAX_NOTE = 80;

function clip(text: string, max: number): string {
  const chars = [...text.replace(/\s+/gu, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

/** One line per Task, newest activity first (the store already orders them). */
export function renderOpenTasks(tasks: readonly TaskRecord[]): string {
  const lines = tasks.map((task) => {
    const summary = task.summary ? ` — ${clip(task.summary, MAX_NOTE)}` : "";
    return `#${task.id} ${clip(task.title, MAX_TITLE)}  ${task.status}${summary}`;
  });
  return ["[Nexus 进行中的事项]", ...lines].join("\n");
}
