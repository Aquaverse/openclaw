// Shared Task store types (DESIGN section 6.3 / 7). Plain data only: everything here crosses the SQLite worker boundary.

export const TASK_STATUSES = [
  "draft",
  "clarifying",
  "planning",
  "awaiting_decision",
  "executing",
  "watching",
  "succeeded",
  "failed",
  "cancelled",
  "deleted",
  "purging",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/** Statuses a Task never leaves through `nexus_task_update` (purging belongs to the Stage 3 purge protocol). */
export const CLOSED_STATUSES: readonly TaskStatus[] = [
  "succeeded",
  "failed",
  "cancelled",
  "deleted",
  "purging",
];

/**
 * Statuses the model may set in Stage 1. `awaiting_decision` / `executing` belong to Stage 2 (decisions and
 * executions), `watching` to Stage 4 (needs an active watch), `succeeded` to Stage 3 (completion claims,
 * DESIGN section 9.3); `cancelled` / `deleted` are operator actions (`nexus.task.abort` / `.delete`).
 */
export const MODEL_SETTABLE_STATUSES: readonly TaskStatus[] = ["clarifying", "planning"];

export type Principal = {
  ownerId: string;
  agentId?: string;
  accountId?: string;
  senderId?: string;
};

export type TaskRecord = {
  id: string;
  ownerId: string;
  kind: string;
  title: string;
  status: TaskStatus;
  goal: unknown;
  entities: unknown;
  riskCeiling: string;
  summary: string | null;
  revision: number;
  originSessionKey: string;
  lastSessionKey: string | null;
  createdAt: number;
  updatedAt: number;
  endedAt: number | null;
  deletedAt: number | null;
};

export type TaskStepRecord = {
  id: string;
  seq: number;
  kind: string;
  status: string;
  title: string;
  detail: unknown;
  flowId: string | null;
  startedAt: number | null;
  endedAt: number | null;
};

export type TaskSessionRecord = { sessionKey: string; firstSeen: number; lastSeen: number };

export type TaskDetail = {
  task: TaskRecord;
  steps: TaskStepRecord[];
  sessions: TaskSessionRecord[];
};

export type ScoredTask = { task: TaskRecord; score: number; matchedOn: string[] };
