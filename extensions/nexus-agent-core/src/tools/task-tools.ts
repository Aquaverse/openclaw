// Agent tools for Tasks (DESIGN sections 7.1-7.3, 12): nexus_task_reserve / create / get / update / note / search.
// All are R0 (no external side effects). Every tool resolves the principal first and passes it to the store.
import { randomBytes } from "node:crypto";
import { Type } from "typebox";
import type { AnyAgentTool } from "../../api.js";
import { requestFingerprint, sha256Hex } from "../canonical.js";
import type { EventBridge } from "../events.js";
import type { TaskStore } from "../store/host.js";
import type { Principal, TaskDetail, TaskRecord } from "../store/types.js";
import { MODEL_SETTABLE_STATUSES } from "../store/types.js";
import type { TokenLedger } from "../tokens.js";

export const TASK_TOOL_NAMES = [
  "nexus_task_reserve",
  "nexus_task_create",
  "nexus_task_get",
  "nexus_task_update",
  "nexus_task_note",
  "nexus_task_search",
] as const;

export const LIMITS = {
  kind: 40,
  title: 200,
  json: 8_192,
  summary: 2_000,
  note: 4_000,
  query: 200,
  stepsReturned: 20,
  searchLimit: 8,
  duplicateWindowDays: 30,
  duplicateCandidates: 5,
} as const;

const KIND = /^[a-z][a-z0-9_]{0,39}$/;
const TASK_ID = /^#?(T[0-9A-Z]{4,16})$/;
const NO_SESSION = "(no-session)";

export type TaskToolDeps = {
  getStore: () => Promise<TaskStore>;
  ledger: TokenLedger;
  events: EventBridge;
  resolvePrincipal: (ctx: { agentId?: string; sessionKey?: string }) => Principal | undefined;
  now?: () => number;
  newId?: () => string;
  /** Stage 3: nexus_task_update may ask for "succeeded"; the store accepts it only when every completion claim is met. */
  completionEnabled?: boolean;
};

type ToolContext = { agentId?: string; sessionKey?: string };

type Failure = { ok: false; code: string; message: string; hint?: string; [key: string]: unknown };

const objectSchema = (description: string) =>
  Type.Object({}, { additionalProperties: true, description });

export function jsonResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    details: payload,
  };
}

function fail(code: string, message: string, extra: Record<string, unknown> = {}): Failure {
  // Weak models have reported a failed call as success (and invented a task id); say it plainly in the result.
  return {
    ok: false,
    code,
    message,
    ...extra,
    notice:
      "This call FAILED and changed nothing. Tell the user it failed; never claim the Task was created or invent a Task id.",
  };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tooBig(value: unknown, max: number): boolean {
  return JSON.stringify(value).length > max;
}

function newTaskId(): string {
  // 8 chars of Crockford-ish base32: collision-safe at personal scale, readable in a prompt list.
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const bytes = randomBytes(8);
  return `T${[...bytes].map((byte) => alphabet[byte % 32]).join("")}`;
}

export function normalizeTaskId(raw: unknown): string | undefined {
  return typeof raw === "string" ? TASK_ID.exec(raw.trim())?.[1] : undefined;
}

function taskView(task: TaskRecord) {
  return {
    taskId: task.id,
    kind: task.kind,
    title: task.title,
    status: task.status,
    goal: task.goal,
    entities: task.entities,
    summary: task.summary,
    revision: task.revision,
    riskCeiling: task.riskCeiling,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

type DetailExtras = {
  pendingDecisions: unknown[];
  readyExecutions: unknown[];
};

function detailView(detail: TaskDetail, extras: DetailExtras) {
  return {
    ...taskView(detail.task),
    steps: detail.steps.map((step) => ({
      seq: step.seq,
      kind: step.kind,
      status: step.status,
      title: step.title,
      detail: step.detail,
      at: step.endedAt ?? step.startedAt,
    })),
    sessions: detail.sessions.length,
    // Decisions waiting for the human, and executions the model may commit right now (DESIGN sections 8 and 12).
    pendingDecisions: extras.pendingDecisions,
    readyExecutions: extras.readyExecutions,
  };
}

/** Builds the six tools for one tool context (the host passes sessionKey/agentId per run). */
export function createTaskTools(deps: TaskToolDeps, ctx: ToolContext): AnyAgentTool[] {
  const now = deps.now ?? Date.now;
  const newId = deps.newId ?? newTaskId;
  const sessionKey = ctx.sessionKey ?? NO_SESSION;

  const withPrincipal = async (
    run: (principal: Principal, store: TaskStore) => Promise<Record<string, unknown>>,
  ) => {
    const principal = deps.resolvePrincipal(ctx);
    if (!principal) {
      return jsonResult(
        fail(
          "no_principal",
          "Cannot determine the current principal; Nexus is not serving this request.",
        ),
      );
    }
    try {
      return jsonResult(await run(principal, await deps.getStore()));
    } catch (error) {
      return jsonResult(
        fail("store_error", error instanceof Error ? error.message : String(error)),
      );
    }
  };

  const tools = [
    {
      name: "nexus_task_reserve",
      label: "Nexus: reserve a Task operation token",
      description:
        "Before creating a Task, reserve a server-issued operation token for the Task kind. Pass the returned operationToken to nexus_task_create so that a retry never creates a second Task. The token is bound to the kind only, not to the entities.",
      parameters: Type.Object({
        kind: Type.String({ description: "Task kind, lower_snake_case, e.g. flight_booking." }),
        entities: Type.Optional(
          objectSchema(
            "Optional and not bound to the token. Only facts the user explicitly stated; never guess anything the user did not say, such as the departure city.",
          ),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal) => {
          const kind = typeof params.kind === "string" ? params.kind : "";
          if (!KIND.test(kind)) {
            return fail("invalid_kind", "kind must be lower_snake_case, at most 40 characters.");
          }
          const entities = params.entities ?? null;
          if (entities !== null && (!isPlainObject(entities) || tooBig(entities, LIMITS.json))) {
            return fail("invalid_entities", "entities must be an object of at most 8 KB.");
          }
          const issued = deps.ledger.issueOperation(principal, { kind });
          return { ok: true, operationToken: issued.token, expiresAt: issued.expiresAt };
        });
      },
    },
    {
      name: "nexus_task_create",
      label: "Nexus: create a Task",
      description:
        "Create a Task for a matter that will take several turns. Registering a Task is only a record: it does not start any work, so do not spawn sub-agents or book anything because of it. Always de-duplicates first: when a similar open Task exists it returns created:false with existing_candidates and a duplicate_override_token. Ask the user, then retry with that token only if they confirm it is a new matter.",
      parameters: Type.Object({
        kind: Type.String({ description: "Task kind, lower_snake_case." }),
        title: Type.String({ description: "Short title shown in the user's Task list." }),
        goal: objectSchema(
          "What the user wants achieved, using only what the user stated. Do not add assumptions.",
        ),
        entities: Type.Optional(
          objectSchema(
            "Key facts the user explicitly stated. Never guess missing facts; omit them and ask the user.",
          ),
        ),
        operationToken: Type.Optional(Type.String({ description: "From nexus_task_reserve." })),
        duplicateOverrideToken: Type.Optional(
          Type.String({
            description: "From a previous created:false response, after the user confirmed.",
          }),
        ),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const kind = typeof params.kind === "string" ? params.kind : "";
          const title = typeof params.title === "string" ? params.title.trim() : "";
          const goal = params.goal;
          const entities = params.entities ?? null;
          if (!KIND.test(kind)) {
            return fail("invalid_kind", "kind must be lower_snake_case, at most 40 characters.");
          }
          if (!title || [...title].length > LIMITS.title) {
            return fail("invalid_title", "title must not be empty, at most 200 characters.");
          }
          if (!isPlainObject(goal) || tooBig(goal, LIMITS.json)) {
            return fail("invalid_goal", "goal must be an object of at most 8 KB.");
          }
          if (entities !== null && (!isPlainObject(entities) || tooBig(entities, LIMITS.json))) {
            return fail("invalid_entities", "entities must be an object of at most 8 KB.");
          }
          const fingerprint = requestFingerprint({ kind, entities, goal });
          const operationToken =
            typeof params.operationToken === "string" && params.operationToken
              ? params.operationToken
              : undefined;
          // Without a token the server derives a short-lived key, so same-turn tool retries still collapse.
          const idempotencyKey =
            operationToken ??
            `auto_${sha256Hex(`${principal.ownerId}|${fingerprint}|${Math.floor(now() / 60_000)}`).slice(0, 32)}`;

          const existing = await store.lookupByKey({ principal, idempotencyKey });
          if (existing) {
            if (existing.fingerprint === fingerprint) {
              return { ok: true, created: false, replayed: true, ...taskView(existing.task) };
            }
            return fail(
              "fingerprint_conflict",
              "This operationToken was already used for a different Task; call nexus_task_reserve again before creating.",
              { existing: { taskId: existing.task.id, title: existing.task.title } },
            );
          }
          if (operationToken) {
            const check = deps.ledger.checkOperation(principal, operationToken, { kind });
            if (check !== "ok") {
              return fail("operation_token_invalid", `operationToken is not usable (${check}).`, {
                hint: "Call nexus_task_reserve again for a new token; a token is only valid for the kind it was reserved with.",
              });
            }
          }

          const duplicates = await store.findSimilar({
            principal,
            kind,
            title,
            entities,
            sinceMs: now() - LIMITS.duplicateWindowDays * 86_400_000,
            limit: LIMITS.duplicateCandidates,
          });
          if (duplicates.length > 0) {
            const candidateIds = duplicates.map((entry) => entry.task.id);
            const overrideToken =
              typeof params.duplicateOverrideToken === "string"
                ? params.duplicateOverrideToken
                : undefined;
            const verdict = overrideToken
              ? deps.ledger.consumeOverride(principal, overrideToken, {
                  requestFingerprint: fingerprint,
                  candidateIds,
                })
              : undefined;
            if (verdict !== "ok") {
              const issued = deps.ledger.issueOverride(principal, {
                requestFingerprint: fingerprint,
                candidateIds,
              });
              return {
                ok: true,
                created: false,
                existing_candidates: duplicates.map((entry) => ({
                  ...taskView(entry.task),
                  similarity: Number(entry.score.toFixed(2)),
                })),
                duplicate_override_token: issued.token,
                expiresAt: issued.expiresAt,
                ...(verdict ? { previousTokenRejected: verdict } : {}),
                hint: "A similar Task exists. Confirm with the user first; once they confirm it is a new task, retry with the same token.",
              };
            }
          }

          const created = await store.create({
            principal,
            id: newId(),
            kind,
            title,
            goal,
            entities,
            idempotencyKey,
            fingerprint,
            sessionKey,
            now: now(),
          });
          if (created.outcome === "fingerprint_conflict") {
            return fail(
              "fingerprint_conflict",
              "The idempotency key conflicts with another Task; reserve again.",
            );
          }
          if (created.outcome === "created") {
            deps.events.taskChanged("created", created.task);
          }
          return {
            ok: true,
            created: created.outcome === "created",
            replayed: created.outcome === "replayed",
            ...taskView(created.task),
          };
        });
      },
    },
    {
      name: "nexus_task_get",
      label: "Nexus: read a Task",
      description:
        "Read one Task by its explicit taskId: goal, status, recent steps and notes. There is no implicit 'current Task'; use nexus_task_search when you do not have the id.",
      parameters: Type.Object({
        taskId: Type.String({
          description: "Task id as shown in the list, with or without the leading #.",
        }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          const detail = await store.get({
            principal,
            taskId,
            bindSessionKey: sessionKey,
            now: now(),
            stepLimit: LIMITS.stepsReturned,
          });
          if (!detail) {
            return fail("not_found", "Task not found.");
          }
          const pending = await store.listDecisions({
            principal,
            taskId,
            statuses: ["pending"],
            limit: 5,
          });
          const ready = await store.listReadyExecutions({ principal, taskId, now: now() });
          return {
            ok: true,
            ...detailView(detail, {
              pendingDecisions: pending.map((decision) => ({
                decisionId: decision.id,
                riskTier: decision.riskTier,
                question: decision.question,
                actionIds: decision.actionIds,
                deadlineAt: decision.deadlineAt,
              })),
              readyExecutions: ready,
            }),
          };
        });
      },
    },
    {
      name: "nexus_task_update",
      label: "Nexus: update a Task",
      description: deps.completionEnabled
        ? 'Update a Task\'s title, goal, entities, summary or status (clarifying, planning, or succeeded). "succeeded" is refused unless the Task has completion claims (nexus_claim_add with completion) and every one has reached its required state through evidence; saying it is done does not count. You cannot mark a Task failed, cancelled or deleted. Pass expectedRevision when you want to detect concurrent edits.'
        : "Update a Task's title, goal, entities, summary or status (only clarifying or planning). You cannot mark a Task succeeded, failed, cancelled or deleted. Pass expectedRevision when you want to detect concurrent edits.",
      parameters: Type.Object({
        taskId: Type.String(),
        title: Type.Optional(Type.String()),
        goal: Type.Optional(objectSchema("Replaces the goal.")),
        entities: Type.Optional(objectSchema("Replaces the entities.")),
        summary: Type.Optional(Type.String({ description: "One-line progress summary." })),
        status: Type.Optional(
          Type.Union(
            [
              ...MODEL_SETTABLE_STATUSES,
              ...(deps.completionEnabled ? (["succeeded"] as const) : []),
            ].map((status) => Type.Literal(status)),
          ),
        ),
        expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          const patch: Parameters<TaskStore["update"]>[0]["patch"] = {};
          if (params.title !== undefined) {
            if (
              typeof params.title !== "string" ||
              !params.title.trim() ||
              [...params.title].length > LIMITS.title
            ) {
              return fail("invalid_title", "title must not be empty, at most 200 characters.");
            }
            patch.title = params.title.trim();
          }
          for (const key of ["goal", "entities"] as const) {
            const value = params[key];
            if (value === undefined) {
              continue;
            }
            if (!isPlainObject(value) || tooBig(value, LIMITS.json)) {
              return fail(`invalid_${key}`, `${key} must be an object of at most 8 KB.`);
            }
            patch[key] = value;
          }
          if (params.summary !== undefined) {
            if (typeof params.summary !== "string" || [...params.summary].length > LIMITS.summary) {
              return fail(
                "invalid_summary",
                "summary must be a string of at most 2000 characters.",
              );
            }
            patch.summary = params.summary;
          }
          if (params.status !== undefined) {
            if (typeof params.status !== "string") {
              return fail("invalid_status", "status must be a string.");
            }
            patch.status = params.status as NonNullable<typeof patch.status>;
          }
          const result = await store.update({
            principal,
            taskId,
            patch,
            ...(typeof params.expectedRevision === "number"
              ? { expectedRevision: params.expectedRevision }
              : {}),
            sessionKey,
            now: now(),
            ...(deps.completionEnabled ? { completionGate: true } : {}),
          });
          switch (result.outcome) {
            case "not_found":
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${result.task.status}); it can no longer be changed.`,
              );
            case "completion_unmet":
              return fail(
                "completion_unmet",
                result.check.reason === "no_completion_claims"
                  ? "This Task has no completion condition yet: first register what must be proven with nexus_claim_add (completion SUPPORTED or VERIFIED), then attach evidence with nexus_evidence_add."
                  : "Not every completion condition has reached its required state. The Task was not marked complete; do not tell the user it is complete.",
                { items: result.check.items },
              );
            case "status_not_allowed":
              return fail("status_not_allowed", "The model cannot set this status.", {
                allowed: result.allowed,
              });
            case "revision_conflict":
              return fail(
                "revision_conflict",
                "The Task was modified; call nexus_task_get to read the latest version first.",
                {
                  currentRevision: result.task.revision,
                },
              );
            case "updated":
              deps.events.taskChanged("updated", result.task);
              return {
                ok: true,
                updated: true,
                revisionBumped: result.revisionBumped,
                ...taskView(result.task),
              };
            case "unchanged":
              return { ok: true, updated: false, ...taskView(result.task) };
          }
        });
      },
    },
    {
      name: "nexus_task_note",
      label: "Nexus: add a progress note",
      description:
        "Append a progress note to a Task (what was found, what is still unknown). Notes never change the goal.",
      parameters: Type.Object({
        taskId: Type.String(),
        text: Type.String({ description: "The note, at most 4000 characters." }),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const taskId = normalizeTaskId(params.taskId);
          if (!taskId) {
            return fail("invalid_task_id", "taskId looks like T0ABC123 (a leading # is allowed).");
          }
          const text = typeof params.text === "string" ? params.text.trim() : "";
          if (!text || [...text].length > LIMITS.note) {
            return fail("invalid_text", "text must not be empty, at most 4000 characters.");
          }
          const result = await store.note({
            principal,
            taskId,
            text,
            stepId: `S${randomBytes(8).toString("hex")}`,
            sessionKey,
            now: now(),
          });
          switch (result.outcome) {
            case "not_found":
              return fail("not_found", "Task not found.");
            case "task_closed":
              return fail(
                "task_closed",
                `The Task has ended (${result.task.status}); notes can no longer be added.`,
              );
            case "added":
              deps.events.taskChanged("note", result.task);
              return { ok: true, added: true, seq: result.step.seq, ...taskView(result.task) };
          }
        });
      },
    },
    {
      name: "nexus_task_search",
      label: "Nexus: find Tasks",
      description:
        "Find candidate Tasks by free text when the list was truncated or you have no id. Returns candidates with a confidence; it never binds anything. If needs_user_confirmation is true, ask the user which one.",
      parameters: Type.Object({
        query: Type.String({ description: "What the user referred to, e.g. Tokyo flights." }),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: LIMITS.searchLimit })),
      }),
      async execute(_id: string, params: Record<string, unknown>) {
        return withPrincipal(async (principal, store) => {
          const query = typeof params.query === "string" ? params.query.trim() : "";
          if (!query || [...query].length > LIMITS.query) {
            return fail("invalid_query", "query must not be empty, at most 200 characters.");
          }
          const limit =
            typeof params.limit === "number" && params.limit >= 1
              ? Math.min(Math.floor(params.limit), LIMITS.searchLimit)
              : LIMITS.searchLimit;
          const found = await store.search({ principal, query, limit });
          const top = found[0];
          const second = found[1];
          const ambiguous =
            top !== undefined &&
            ((second !== undefined && top.score - second.score < 0.15) || top.score < 0.5);
          return {
            ok: true,
            candidates: found.map((entry) => ({
              taskId: entry.task.id,
              title: entry.task.title,
              status: entry.task.status,
              confidence: Number(entry.score.toFixed(2)),
              matchedOn: entry.matchedOn,
            })),
            needs_user_confirmation: ambiguous,
          };
        });
      },
    },
  ];
  // `direct-only` keeps these tools model-visible even when the host defers tool schemas behind Tool Search
  // (it switches on automatically for local-model routes, and the search only understands English queries).
  // Without it a local model searches in Chinese, finds nothing, and never calls the Task tools.
  const visible = tools.map((tool) => ({ ...tool, catalogMode: "direct-only" as const }));
  // The host reads name/label/description/parameters/execute; the precise AgentTool generics are not needed here.
  return visible as unknown as AnyAgentTool[];
}
