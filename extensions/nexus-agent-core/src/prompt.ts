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
