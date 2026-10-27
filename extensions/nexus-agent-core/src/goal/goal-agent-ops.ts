import { metricReached } from "../store/goal-rows.js";
// What an Agent may do with goals (Goals design 9.1): search, read, create inside a creation grant, propose, record progress and
// link a Task or file. Nothing here confirms, completes, renames, deletes or purges a goal, and nothing writes user words.
// The tool layer (src/tools/goal-tools.ts) is a thin typed wrapper around these functions so they can be tested without the SDK.
import {
  GOAL_LIMITS,
  isOpenGoalCategory,
  type GoalDetailRecord,
  type GoalRecord,
  type GoalSummaryRecord,
} from "../store/goal-types.js";
import type { Principal } from "../store/types.js";
import { normalizeTaskId } from "../tools/task-tools.js";
import type { GoalService } from "./goal-service.js";

export const GOAL_SEARCH_DEFAULT_LIMIT = 10;
export const GOAL_SEARCH_MAX_LIMIT = 25;
const AGENT_ENTRIES_SHOWN = 20;
const ID = /^[A-Za-z0-9_-]{1,64}$/u;

export type AgentFailure = {
  ok: false;
  code: string;
  message: string;
  notice: string;
  [extra: string]: unknown;
};

export function agentFail(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): AgentFailure {
  return {
    ok: false,
    code,
    message,
    ...extra,
    notice:
      "This call FAILED and changed nothing. Tell the user it failed; never say a goal was saved, confirmed or updated.",
  };
}

const SENSITIVE_NOTE =
  "This goal is marked sensitive: only its title is shown in search. Do not repeat amounts or details outside this conversation.";

/** List view. A sensitive goal shows its title and category only. */
export function goalListView(goal: GoalSummaryRecord | GoalRecord) {
  const base = {
    goalId: goal.id,
    title: goal.title,
    category: goal.category,
    status: goal.status,
    parentId: goal.parentId,
    sensitive: goal.sensitivity === "sensitive",
  };
  if (goal.sensitivity === "sensitive") {
    return base;
  }
  return { ...base, currentState: goal.currentState, summary: goal.summary };
}

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const isBlank = (value: unknown): boolean => typeof value === "string" && value.trim() === "";

function optionalText(
  params: Record<string, unknown>,
  name: string,
): { ok: true; value: string | undefined } | AgentFailure {
  const raw = params[name];
  if (raw === undefined || isBlank(raw)) {
    return { ok: true, value: undefined };
  }
  if (typeof raw !== "string") {
    return agentFail(`invalid_${name}`, `${name} must be text.`);
  }
  return { ok: true, value: raw };
}

// ------------------------------------------------------------------ read

export async function agentSearchGoals(
  service: Pick<GoalService, "list">,
  principal: Principal,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let status: "open" | "active" | "completed" | "proposed" = "open";
  if (params.status !== undefined && !isBlank(params.status)) {
    if (!["open", "active", "completed", "proposed"].includes(String(params.status))) {
      return agentFail("invalid_status", "status is one of open, active, proposed, completed.");
    }
    status = params.status as typeof status;
  }
  let limit = GOAL_SEARCH_DEFAULT_LIMIT;
  if (params.limit !== undefined) {
    if (!Number.isInteger(params.limit) || (params.limit as number) < 1) {
      return agentFail("invalid_limit", `limit is an integer from 1 to ${GOAL_SEARCH_MAX_LIMIT}.`);
    }
    limit = Math.min(params.limit as number, GOAL_SEARCH_MAX_LIMIT);
  }
  const query = optionalText(params, "query");
  if (!query.ok) {
    return query;
  }
  const out = await service.list(principal, {
    status,
    limit,
    ...(query.value ? { query: query.value.slice(0, 120) } : {}),
    ...(typeof params.category === "string" && !isBlank(params.category)
      ? { category: params.category as GoalRecord["category"] }
      : {}),
  });
  return {
    ok: true,
    goals: out.goals.map(goalListView),
    returned: out.goals.length,
    total: out.total,
    complete: out.goals.length === out.total,
    note: "Status proposed means waiting for the user's approval in the console; it is not yet a goal the user has accepted.",
  };
}

function detailView(detail: GoalDetailRecord) {
  const goal = detail.goal;
  const sensitive = goal.sensitivity === "sensitive";
  return {
    goalId: goal.id,
    title: goal.title,
    category: goal.category,
    status: goal.status,
    origin: goal.origin,
    sensitive,
    ...(sensitive ? { note: SENSITIVE_NOTE } : {}),
    userWords: goal.userWords,
    summary: goal.summary,
    currentState: goal.currentState,
    parent: detail.parent,
    subGoals: detail.children.map((child) => ({
      goalId: child.id,
      title: child.title,
      status: child.status,
    })),
    entries: detail.entries
      .filter((entry) => entry.retractedAt === null)
      .slice(0, AGENT_ENTRIES_SHOWN)
      .map((entry) => {
        const view = {
          entryId: entry.id,
          kind: entry.kind,
          author: entry.author,
          text: entry.text,
          effectiveAt: entry.effectiveAt,
          taskId: entry.taskId,
        };
        return entry.pointer
          ? Object.assign(view, {
              taskStatus: entry.pointer.taskStatus,
              claimState: entry.pointer.claimState,
              pointerGone: entry.pointer.taskGone || entry.pointer.claimGone,
            })
          : view;
      }),
    links: detail.links.map((link) => ({
      kind: link.kind,
      refId: link.refId,
      gone: link.targetGone,
      ...(link.task ? { taskStatus: link.task.status } : {}),
    })),
    // Read-only for the Agent: the user fills the figures in the console, and a claim metric follows its claim.
    metrics: detail.metrics.map((metric) => ({
      metricId: metric.id,
      name: metric.name,
      unit: metric.unit,
      direction: metric.direction,
      target: metric.target,
      current: metric.current,
      asOf: metric.asOf,
      source: metric.source === "manual" ? "self_reported" : "claim",
      ...(metric.pointer ? { claimState: metric.pointer.claimState } : {}),
      // A claim figure only counts toward the target once the claim is supported or verified.
      targetReached:
        metricReached(metric) &&
        (metric.source === "manual" ||
          metric.pointer?.claimState === "SUPPORTED" ||
          metric.pointer?.claimState === "VERIFIED"),
    })),
  };
}

export async function agentGetGoal(
  service: Pick<GoalService, "get">,
  principal: Principal,
  goalId: unknown,
): Promise<Record<string, unknown>> {
  if (typeof goalId !== "string" || !ID.test(goalId)) {
    return agentFail("invalid_goal_id", "goalId is malformed; take it from nexus_goal_search.");
  }
  const detail = await service.get(principal, goalId, AGENT_ENTRIES_SHOWN);
  if (!detail || detail.goal.lifecycle !== "live") {
    return agentFail("not_found", "Goal not found.");
  }
  return { ok: true, ...detailView(detail) };
}

// ------------------------------------------------------------------ write

const SERVER_REFUSED =
  "The server refuses ID, card, account and similar numbers in a goal. Leave the number out, tell the user you did not save it, and ask them not to share such numbers here.";

function writeFailure(outcome: {
  outcome: string;
  [key: string]: unknown;
}): AgentFailure | undefined {
  switch (outcome.outcome) {
    case "sensitive_value":
      return agentFail("sensitive_value", SERVER_REFUSED, { kind: outcome.kind });
    case "invalid":
      return agentFail(
        "invalid",
        `A field is not acceptable (${String(outcome.code)}); shorten or fix it.`,
        {
          field: outcome.code,
        },
      );
    case "not_found":
      return agentFail("not_found", "Goal not found.");
    case "not_live":
      return agentFail("not_available", "This goal is deleted and cannot be changed.");
    case "bad_state":
      return agentFail(
        "goal_not_active",
        `This goal is ${String(outcome.status)}; you can add progress only to an active goal. If it is waiting for approval, tell the user to approve it in the console.`,
      );
    case "limit_reached":
      return agentFail(
        "limit_reached",
        `The limit of ${String(outcome.max)} ${String(outcome.kind)} items is reached; tell the user.`,
      );
    case "parent_invalid":
      return agentFail(
        "parent_invalid",
        `The parent goal cannot take a sub-goal (${String(outcome.reason)}).`,
      );
    default:
      return undefined;
  }
}

export async function agentCreateGoal(
  service: Pick<GoalService, "create">,
  principal: Principal,
  sessionKey: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const title = textOf(params.title);
  if (title === undefined || title.trim() === "") {
    return agentFail("invalid_title", "title is required: the goal in the user's own words.");
  }
  const summary = optionalText(params, "summary");
  const currentState = optionalText(params, "currentState");
  if (!summary.ok) {
    return summary;
  }
  if (!currentState.ok) {
    return currentState;
  }
  let notes: string[] | undefined;
  if (params.notes !== undefined) {
    if (
      !Array.isArray(params.notes) ||
      params.notes.length > 10 ||
      params.notes.some((note) => typeof note !== "string")
    ) {
      return agentFail("invalid_notes", "notes is a list of at most 10 short texts.");
    }
    notes = (params.notes as string[]).map((note) => note.trim()).filter((note) => note.length > 0);
  }
  const out = await service.create(principal, {
    sessionKey,
    fields: {
      title,
      ...(summary.value ? { summary: summary.value } : {}),
      ...(currentState.value ? { currentState: currentState.value } : {}),
    },
    ...(notes ? { notes } : {}),
  });
  if (out.outcome === "created") {
    return {
      ok: true,
      goalId: out.goal.id,
      status: out.goal.status,
      note: "The goal is saved as active on the user's Goals page. The creation permission is now used up. Tell the user it is saved, then suggest one small first step and ask about the current situation.",
    };
  }
  if (out.outcome === "exists") {
    return {
      ok: true,
      goalId: out.goal.id,
      status: out.goal.status,
      alreadySaved: true,
      note: "This chat already saved this goal. Do not create another; add progress with nexus_goal_entry_add.",
    };
  }
  if (out.outcome === "similar") {
    return agentFail(
      "similar_goal",
      "The user already has a similar goal. Do not create another; use nexus_goal_entry_add on it, or ask the user how they want to proceed.",
      { goal: goalListView(out.goal) },
    );
  }
  if (out.outcome === "no_grant") {
    return agentFail(
      "no_creation_permission",
      "You can only create a goal in a chat the user opened from the Goals page. Here, call nexus_goal_propose instead; the user approves it in the console.",
    );
  }
  if (out.outcome === "limit_reached") {
    return agentFail(
      "goal_limit",
      `The user already has ${String(out.max)} active goals. Tell them to complete or delete one first.`,
    );
  }
  const failure = writeFailure(out as { outcome: string });
  return failure ?? agentFail("failed", `Not saved (${out.outcome}).`);
}

export async function agentProposeGoal(
  service: Pick<GoalService, "propose">,
  principal: Principal,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const title = textOf(params.title);
  if (title === undefined || title.trim() === "") {
    return agentFail("invalid_title", "title is required: the goal in the user's own words.");
  }
  if (!isOpenGoalCategory(params.category)) {
    return agentFail("invalid_category", "category is one of finance, interests, something_else.");
  }
  const summary = optionalText(params, "summary");
  const currentState = optionalText(params, "currentState");
  const parentId = optionalText(params, "parentId");
  if (!summary.ok) {
    return summary;
  }
  if (!currentState.ok) {
    return currentState;
  }
  if (!parentId.ok) {
    return parentId;
  }
  let questions: string[] | undefined;
  if (params.questions !== undefined) {
    if (
      !Array.isArray(params.questions) ||
      params.questions.length > GOAL_LIMITS.questions ||
      params.questions.some((q) => typeof q !== "string")
    ) {
      return agentFail(
        "invalid_questions",
        `questions is a list of at most ${GOAL_LIMITS.questions} one-sentence texts.`,
      );
    }
    questions = (params.questions as string[]).filter((q) => q.trim() !== "");
  }
  const out = await service.propose(principal, {
    category: params.category,
    fields: {
      title,
      ...(summary.value ? { summary: summary.value } : {}),
      ...(currentState.value ? { currentState: currentState.value } : {}),
    },
    ...(questions ? { questions } : {}),
    ...(parentId.value ? { parentId: parentId.value } : {}),
  });
  if (out.outcome === "proposed" || (out.outcome === "exists" && out.goal.status === "proposed")) {
    return {
      ok: true,
      goalId: out.goal.id,
      status: out.goal.status,
      note: "The goal is waiting for the user's approval on the Goals page. It is NOT saved as an active goal yet. Tell the user it is waiting for their approval; do not act on it as if it were active.",
    };
  }
  if (out.outcome === "similar" || out.outcome === "exists") {
    return agentFail(
      "similar_goal",
      "The user already has a similar goal. Add progress to it with nexus_goal_entry_add instead of proposing another.",
      { goal: goalListView(out.goal) },
    );
  }
  const failure = writeFailure(out as { outcome: string });
  return failure ?? agentFail("failed", `Not proposed (${out.outcome}).`);
}

export async function agentAddEntry(
  service: Pick<GoalService, "addEntry">,
  principal: Principal,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof params.goalId !== "string" || !ID.test(params.goalId)) {
    return agentFail("invalid_goal_id", "goalId is malformed; take it from nexus_goal_search.");
  }
  const text = textOf(params.text);
  if (text === undefined || text.trim() === "") {
    return agentFail("invalid_text", "text is required.");
  }
  if (params.kind !== undefined && params.kind !== "note" && params.kind !== "milestone") {
    return agentFail("invalid_kind", "kind is note or milestone.");
  }
  const taskId = optionalText(params, "taskId");
  const claimId = optionalText(params, "claimId");
  if (!taskId.ok) {
    return taskId;
  }
  if (!claimId.ok) {
    return claimId;
  }
  const out = await service.addEntry(principal, {
    goalId: params.goalId,
    kind: (params.kind as "note" | "milestone" | undefined) ?? "note",
    text,
    author: "agent",
    ...(taskId.value ? { taskId: normalizeTaskId(taskId.value) ?? taskId.value } : {}),
    ...(claimId.value ? { claimId: claimId.value } : {}),
  });
  if (out.outcome === "added") {
    return {
      ok: true,
      entryId: out.entry.id,
      note: "Recorded as an Agent note. It does not change the goal's status; only the user completes a goal.",
    };
  }
  if (out.outcome === "task_not_found" || out.outcome === "claim_not_found") {
    return agentFail(out.outcome, "That Task or claim does not exist for this user.");
  }
  const failure = writeFailure(out as { outcome: string });
  return failure ?? agentFail("failed", `Not recorded (${out.outcome}).`);
}

export async function agentLinkGoal(
  service: Pick<GoalService, "addLink">,
  principal: Principal,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof params.goalId !== "string" || !ID.test(params.goalId)) {
    return agentFail("invalid_goal_id", "goalId is malformed; take it from nexus_goal_search.");
  }
  if (params.kind !== "task" && params.kind !== "vault_file") {
    return agentFail("invalid_kind", "kind is task or vault_file.");
  }
  const refId =
    params.kind === "task"
      ? normalizeTaskId(params.refId)
      : typeof params.refId === "string" && ID.test(params.refId)
        ? params.refId
        : undefined;
  if (refId === undefined) {
    return agentFail("invalid_ref", "refId is the Task id (like T0ABC123) or the file id.");
  }
  const out = await service.addLink(principal, { goalId: params.goalId, kind: params.kind, refId });
  if (out.outcome === "linked" || out.outcome === "unchanged") {
    return { ok: true, linkId: out.link.id, alreadyLinked: out.outcome === "unchanged" };
  }
  if (out.outcome === "target_not_found") {
    return agentFail("target_not_found", "That Task or file does not exist for this user.");
  }
  if (out.outcome === "target_unavailable") {
    return agentFail("target_unavailable", `That target cannot be linked (${out.reason}).`);
  }
  if (out.outcome === "capability_unavailable") {
    return agentFail("unavailable", "Files are not enabled, so a file cannot be linked.");
  }
  if (out.outcome === "task_linked_elsewhere") {
    return agentFail("task_linked_elsewhere", "That Task already belongs to another goal.", {
      goalId: out.goalId,
    });
  }
  const failure = writeFailure(out as { outcome: string });
  return failure ?? agentFail("failed", `Not linked (${out.outcome}).`);
}
