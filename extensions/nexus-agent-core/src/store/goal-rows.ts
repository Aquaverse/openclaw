// Row mapping and pure validation shared by the goal kernels (goal-ledger.ts, goal-lifecycle-ledger.ts). No SQL runs here.
import { jaccard, tokenize } from "../similarity.js";
import {
  GOAL_CATEGORIES,
  GOAL_LIMITS,
  type GoalCategory,
  type GoalCreatedVia,
  type GoalCreationGrantRecord,
  type GoalEntryAuthor,
  type GoalEntryKind,
  type GoalEntryRecord,
  type GoalFields,
  type GoalInvalidCode,
  type GoalLifecycle,
  type GoalLinkKind,
  type GoalLinkRecord,
  type GoalMetricDirection,
  type GoalMetricRecord,
  type GoalMetricSource,
  type GoalNotifyPolicy,
  type GoalOrigin,
  type GoalRecord,
  type GoalSensitivity,
  type GoalStatus,
} from "./goal-types.js";

export type Row = Record<string, unknown>;

/** The statement helpers of the shared ledger (claim-ledger.ts `internals`), narrowed to what the goal kernels use. */
export type GoalDb = {
  one(sql: string, ...params: (string | number | null)[]): Row | undefined;
  all(sql: string, ...params: (string | number | null)[]): Row[];
  run(sql: string, ...params: (string | number | null)[]): number;
  newId(prefix: string): string;
};

const optionalNumber = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const optionalText = (value: unknown): string | null => (typeof value === "string" ? value : null);

function parseQuestions(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((q): q is string => typeof q === "string") : [];
  } catch {
    return [];
  }
}

export function toGoal(row: Row): GoalRecord {
  return {
    id: String(row.id),
    parentId: optionalText(row.parent_id),
    category: String(row.category) as GoalCategory,
    title: String(row.title),
    userWords: optionalText(row.user_words),
    summary: optionalText(row.summary),
    currentState: optionalText(row.current_state),
    status: String(row.status) as GoalStatus,
    lifecycle: String(row.lifecycle) as GoalLifecycle,
    origin: String(row.origin) as GoalOrigin,
    createdVia: String(row.created_via) as GoalCreatedVia,
    confirmedAt: optionalNumber(row.confirmed_at),
    confirmedBy: optionalText(row.confirmed_by),
    sensitivity: String(row.sensitivity) as GoalSensitivity,
    notifyPolicy: String(row.notify_policy) as GoalNotifyPolicy,
    sortOrder: Number(row.sort_order),
    questions: parseQuestions(row.questions_json),
    revision: Number(row.revision),
    completedAt: optionalNumber(row.completed_at),
    deletedAt: optionalNumber(row.deleted_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function toEntry(row: Row): GoalEntryRecord {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    kind: String(row.kind) as GoalEntryKind,
    text: String(row.text),
    author: String(row.author) as GoalEntryAuthor,
    effectiveAt: Number(row.effective_at),
    createdAt: Number(row.created_at),
    taskId: optionalText(row.task_id),
    claimId: optionalText(row.claim_id),
    retractedAt: optionalNumber(row.retracted_at),
  };
}

export function toMetric(row: Row): GoalMetricRecord {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    name: String(row.name),
    unit: String(row.unit),
    direction: String(row.direction) as GoalMetricDirection,
    target: optionalNumber(row.target),
    current: optionalNumber(row.current),
    asOf: optionalNumber(row.as_of),
    source: String(row.source) as GoalMetricSource,
    taskId: optionalText(row.task_id),
    claimId: optionalText(row.claim_id),
    reachedAt: optionalNumber(row.reached_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/** Is the target met? `up`: current at or above it; `down`: at or below. No target or no figure: never. */
export function metricReached(metric: {
  direction: GoalMetricDirection;
  target: number | null;
  current: number | null;
}): boolean {
  if (metric.target === null || metric.current === null) {
    return false;
  }
  return metric.direction === "up"
    ? metric.current >= metric.target
    : metric.current <= metric.target;
}

export function toLink(row: Row, targetGone: boolean): GoalLinkRecord {
  return {
    id: String(row.id),
    goalId: String(row.goal_id),
    kind: String(row.kind) as GoalLinkKind,
    refId: String(row.ref_id),
    createdAt: Number(row.created_at),
    targetGone: targetGone || row.target_gone_at !== null,
  };
}

export function toGrant(row: Row): GoalCreationGrantRecord {
  return {
    id: String(row.id),
    sessionKey: String(row.session_key),
    category: String(row.category) as GoalCategory,
    parentId: optionalText(row.parent_id),
    issuedBy: String(row.issued_by),
    expiresAt: Number(row.expires_at),
    createdAt: Number(row.created_at),
  };
}

export const GOAL_COLUMNS =
  "id, parent_id, category, title, user_words, summary, current_state, status, lifecycle, origin, created_via, " +
  "confirmed_at, confirmed_by, sensitivity, notify_policy, sort_order, questions_json, revision, completed_at, " +
  "deleted_at, created_at, updated_at";

export function isGoalCategory(value: unknown): value is GoalCategory {
  return typeof value === "string" && (GOAL_CATEGORIES as readonly string[]).includes(value);
}

const charLength = (text: string): number => Array.from(text).length;

/** A single line of plain text: trimmed, inner whitespace folded. Empty after folding means "not provided". */
export function foldText(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const folded = value.replace(/\s+/gu, " ").trim();
  return folded.length > 0 ? folded : undefined;
}

/** Entry text may span lines; only trim the ends and collapse runs of blank lines. */
export function cleanBlock(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const cleaned = value
    .replace(/\r\n?/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

export type CheckedFields = {
  title: string;
  summary: string | null;
  currentState: string | null;
};

export function checkFields(
  fields: GoalFields,
): { ok: true; value: CheckedFields } | { ok: false; code: GoalInvalidCode } {
  const title = foldText(fields.title);
  if (title === undefined) {
    return { ok: false, code: "bad_title" };
  }
  if (charLength(title) > GOAL_LIMITS.title) {
    return { ok: false, code: "title_too_long" };
  }
  const summary = fields.summary === undefined ? null : (cleanBlock(fields.summary) ?? null);
  if (summary !== null && charLength(summary) > GOAL_LIMITS.summary) {
    return { ok: false, code: "summary_too_long" };
  }
  const currentState =
    fields.currentState === undefined ? null : (foldText(fields.currentState) ?? null);
  if (currentState !== null && charLength(currentState) > GOAL_LIMITS.currentState) {
    return { ok: false, code: "current_state_too_long" };
  }
  return { ok: true, value: { title, summary, currentState } };
}

export function checkQuestions(
  questions: readonly unknown[] | undefined,
): { ok: true; value: string[] } | { ok: false; code: GoalInvalidCode } {
  if (questions === undefined) {
    return { ok: true, value: [] };
  }
  if (questions.length > GOAL_LIMITS.questions) {
    return { ok: false, code: "too_many_questions" };
  }
  const out: string[] = [];
  for (const question of questions) {
    const text = foldText(question);
    if (text === undefined || charLength(text) > GOAL_LIMITS.question) {
      return { ok: false, code: "bad_question" };
    }
    out.push(text);
  }
  return { ok: true, value: out };
}

/** "Same matter" test for goal titles: equal after normalising, or token overlap at or above the threshold. */
const SIMILAR_TITLE = 0.6;
export function similarTitles(a: string, b: string): boolean {
  const left = a.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  const right = b.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
  if (left.length === 0 || right.length === 0) {
    return false;
  }
  if (left === right) {
    return true;
  }
  return jaccard(tokenize(left), tokenize(right)) >= SIMILAR_TITLE;
}

export function likeEscape(term: string): string {
  return term.replace(/[\\%_]/gu, (ch) => `\\${ch}`);
}
