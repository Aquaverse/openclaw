// Work kernel (object-model design 4.2, 5, 10.2): create, read, update, goal link, typed links, controls, prerequisites, outcome
// and end facts. Runs inside the SQLite worker; every method is ONE synchronous transaction and every statement filters on owner_id.
// What holds across the file:
//   * a Work has no execution state column: its state is derived at read time (work/derive.ts) from Task, prerequisite, control,
//     outcome and end facts; "done" and "ended" are READ from work_outcome_events / work_terminal_events, never computed from Tasks;
//   * task_work_owner is write-once and written in the same transaction as the Task (INV-02), so every Task has exactly one Work;
//   * a Goal link has one write source, goal_work_links; goal_links(kind='task') rows are a compatibility shadow kept in step here;
//   * history is append-only: links are ended, not deleted; outcome and end events are appended, never rewritten.
import type { ContextMode, WorkRecord, WorkSpec } from "../work/types.js";
import type { ClaimLedger } from "./claim-ledger.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import { createWorkControlOps } from "./work-control-ledger.js";
import { createWorkCountsOps } from "./work-counts-ledger.js";
import { createWorkFacts, type WorkView } from "./work-facts.js";
import { createWorkGoalOps } from "./work-goal-ledger.js";
import { workKeywordFilter } from "./work-keyword.js";
import { createWorkCommon, toWork, type Row, type WorkActor } from "./work-ledger-common.js";
import { createRequireLive, TERMINAL_TASK, type WorkOpsDeps } from "./work-ledger-deps.js";
import { createWorkLinkOps } from "./work-link-ledger.js";
import { createWorkLinkLines } from "./work-link-lines.js";

export type WorkListInput = {
  principal: Principal;
  now: number;
  states?: string[];
  includeHidden?: boolean;
  includeArchived?: boolean;
  goalId?: string;
  contextMode?: ContextMode;
  keyword?: string;
  /** "recent" (default): most recently updated first. "state": by what needs the reader first, then most recent. */
  order?: "recent" | "state";
  limit: number;
  offset: number;
};

/** The order of the "state" listing: what needs the person first, finished and ended work last. */
const STATE_ORDER: Record<string, number> = {
  needs_you: 0,
  blocked: 1,
  in_progress: 2,
  done: 3,
  ended_incomplete: 4,
};

export function createWorkLedger(
  transaction: TransactionRunner,
  internals: ClaimLedger["internals"],
) {
  const c = createWorkCommon(transaction, internals);
  const { one, all, run, newId, workRow, appendEvent, ensureContextRoot, touch } = c;
  const facts = createWorkFacts(c);
  const { workCounts } = createWorkCountsOps(c, facts);
  const { lines: linkLines, goalTitle } = createWorkLinkLines(c);

  const requireLive = createRequireLive(c);

  // ------------------------------------------------------------------ outcome evaluation (default contract)

  /**
   * W1 interim contract: a Work without an outcome contract (the contract tables arrive with W2) is achieved when it has at least
   * one non-superseded Task and every such Task has succeeded; a succeeded Task already passed the claim completion gate (9.3), so
   * the event is written with basis `source_verified` and the criterion recorded in assessment_refs_json. The chain is
   * append-only: achieved, then withdrawn when a new unfinished Task joins, then reinstated. A live end fact (stop) blocks new
   * achievements (INV-20).
   */
  const evaluateOutcomeInTx = (owner: string, workId: string, now: number): void => {
    const work = toWork(workRow(owner, workId) as Row);
    if (work.lifecycle !== "live" && work.lifecycle !== "archived") {
      return;
    }
    const tasks = all(
      "SELECT t.id, t.status FROM task_work_owner o JOIN nexus_tasks t ON t.owner_id = o.owner_id AND t.id = o.task_id " +
        "WHERE o.owner_id = ? AND o.work_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging')",
      owner,
      workId,
    );
    const superseded = new Set(
      all(
        "SELECT x.supersedes_task_id AS s FROM task_ext x JOIN task_work_owner o ON o.owner_id = x.owner_id AND o.task_id = x.task_id " +
          "WHERE o.owner_id = ? AND o.work_id = ? AND x.supersedes_task_id IS NOT NULL",
        owner,
        workId,
      ).map((row) => String(row.s)),
    );
    const counted = tasks.filter((row) => !superseded.has(String(row.id)));
    // Required Commitments count too: only a source-verified resolution fulfils one. A manual close or a cancel never does, so a
    // Work that depends on such a Commitment cannot become "done" by that route (design 5.2, 6.2).
    const required = all(
      "SELECT c.id, c.lifecycle, c.resolution_basis FROM work_links l JOIN commitments c ON c.owner_id = l.owner_id AND c.id = l.target_id " +
        "WHERE l.owner_id = ? AND l.work_id = ? AND l.role = 'required' AND l.target_kind = 'commitment' AND l.ended_at IS NULL",
      owner,
      workId,
    );
    const met =
      (counted.length > 0 || required.length > 0) &&
      counted.every((row) => String(row.status) === "succeeded") &&
      required.every(
        (row) =>
          String(row.lifecycle) === "resolved" &&
          String(row.resolution_basis) === "source_verified",
      );
    const events = all(
      "SELECT * FROM work_outcome_events WHERE owner_id = ? AND work_id = ? AND original_result_id = ?",
      owner,
      workId,
      work.originalResultId,
    );
    const head = facts.outcomeHead(events);
    const valid =
      head !== undefined && (head.event_type === "achieved" || head.event_type === "reinstated");
    const stopped =
      one(
        "SELECT 1 AS found FROM work_terminal_events WHERE owner_id = ? AND work_id = ? AND reopened_at IS NULL",
        owner,
        workId,
      ) !== undefined;
    let eventType: "achieved" | "reinstated" | "withdrawn" | undefined;
    if (met && !valid && !stopped) {
      eventType = head === undefined ? "achieved" : "reinstated";
    } else if (!met && valid) {
      eventType = "withdrawn";
    }
    if (!eventType) {
      return;
    }
    const id = `oe_${workId}_${events.length + 1}`;
    run(
      "INSERT INTO work_outcome_events (owner_id, id, work_id, original_result_id, work_version, contract_version, scope_ref, event_type, " +
        "basis, provenance, assessment_refs_json, previous_event_id, reason, recorded_at, business_fulfilled_at) " +
        "VALUES (?, ?, ?, ?, ?, 1, NULL, ?, 'source_verified', 'live', ?, ?, ?, ?, ?)",
      owner,
      id,
      workId,
      work.originalResultId,
      work.currentWorkVersion,
      eventType,
      JSON.stringify({
        criteria: [
          ...(counted.length > 0
            ? [
                {
                  kind: "task_completed",
                  taskIds: counted.map((row) => String(row.id)),
                  gate: "completion_check",
                },
              ]
            : []),
          ...(required.length > 0
            ? [
                {
                  kind: "commitment_verified",
                  commitmentIds: required.map((row) => String(row.id)),
                },
              ]
            : []),
        ],
      }),
      head ? String(head.id) : null,
      "default_contract",
      now,
      eventType === "withdrawn" ? null : now,
    );
    appendEvent(
      owner,
      workId,
      "outcome_recorded",
      "system",
      { outcomeEventId: id, eventType },
      now,
    );
    touch(owner, workId, now);
  };

  // ------------------------------------------------------------------ Goal shadow

  /** Make goal_links(kind='task') mirror the Work's primary Goal for every Task the Work owns (idempotent). */
  const syncGoalShadow = (owner: string, workId: string, now: number): void => {
    const goal = one(
      "SELECT goal_id FROM goal_work_links WHERE owner_id = ? AND work_id = ? AND role = 'primary' AND ended_at IS NULL",
      owner,
      workId,
    );
    const taskIds = all(
      "SELECT task_id FROM task_work_owner WHERE owner_id = ? AND work_id = ?",
      owner,
      workId,
    ).map((row) => String(row.task_id));
    for (const taskId of taskIds) {
      if (!goal) {
        run(
          "DELETE FROM goal_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ?",
          owner,
          taskId,
        );
        continue;
      }
      const goalId = String(goal.goal_id);
      const have = one(
        "SELECT goal_id FROM goal_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ?",
        owner,
        taskId,
      );
      if (have && String(have.goal_id) === goalId) {
        continue;
      }
      if (have) {
        run(
          "DELETE FROM goal_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ?",
          owner,
          taskId,
        );
      }
      run(
        "INSERT INTO goal_links (owner_id, id, goal_id, kind, ref_id, created_at) VALUES (?, ?, ?, 'task', ?, ?)",
        owner,
        newId("GL"),
        goalId,
        taskId,
        now,
      );
    }
  };

  // ------------------------------------------------------------------ creation

  const insertWork = (
    owner: string,
    spec: WorkSpec,
    now: number,
    extra: {
      origin?: string;
      hidden?: boolean;
      contextOrigin?: string;
      contextReview?: string;
      migratedOutcome?: string | null;
      id?: string;
      createdAt?: number;
      updatedAt?: number;
    } = {},
  ): string => {
    const id = extra.id ?? newId("w_");
    const mode = spec.contextMode ?? "personal";
    const scope = ensureContextRoot(owner, mode, now);
    const created = extra.createdAt ?? now;
    run(
      "INSERT INTO works (owner_id, id, title, request_text, outcome_text, original_result_id, context_mode, primary_context_id, " +
        "context_origin, context_review, entry_kind, accepted_at, migrated_outcome, origin, request_ref, hidden, revision, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)",
      owner,
      id,
      spec.title,
      spec.requestText ?? null,
      spec.outcomeText ?? spec.requestText ?? null,
      `r_${id}`,
      mode,
      scope,
      extra.contextOrigin ?? "explicit",
      extra.contextReview ?? "none",
      spec.entryKind ?? (extra.origin === "migrated" ? "migrated" : "user_request"),
      created,
      extra.migratedOutcome ?? null,
      extra.origin ?? spec.origin,
      spec.requestRef ?? null,
      extra.hidden ? 1 : 0,
      created,
      extra.updatedAt ?? created,
    );
    run(
      "INSERT INTO work_versions (owner_id, work_id, work_version, context_mode, context_scope_id, context_semantic_version, " +
        "contract_version, outcome_text, diff_json, accepted_basis, created_at) VALUES (?, ?, 1, ?, ?, 1, 1, ?, NULL, ?, ?)",
      owner,
      id,
      mode,
      scope,
      spec.outcomeText ?? spec.requestText ?? null,
      extra.origin === "migrated" ? "migration" : "creation",
      created,
    );
    return id;
  };

  const validateWorkInTx = (
    owner: string,
    spec: WorkSpec,
  ): { ok: true } | { ok: false; reason: "work_not_found" | "work_not_live" } => {
    if (!spec.workId) {
      return { ok: true };
    }
    const row = workRow(owner, spec.workId);
    if (!row) {
      return { ok: false, reason: "work_not_found" };
    }
    return String(row.lifecycle) === "live" ? { ok: true } : { ok: false, reason: "work_not_live" };
  };

  /** Called by the Task create transaction after the nexus_tasks INSERT: resolve or create the Work and write task_work_owner. */
  const attachTaskInTx = (
    owner: string,
    taskId: string,
    spec: WorkSpec,
    now: number,
  ): { workId: string; createdWork: boolean } => {
    let workId = spec.workId;
    let createdWork = false;
    if (!workId && spec.requestRef) {
      const dup = one(
        "SELECT id FROM works WHERE owner_id = ? AND request_ref = ? AND lifecycle = 'live'",
        owner,
        spec.requestRef,
      );
      workId = dup ? String(dup.id) : undefined;
    }
    if (!workId) {
      workId = insertWork(owner, spec, now);
      appendEvent(owner, workId, "created", spec.origin, { via: "task_create", taskId }, now);
      createdWork = true;
    }
    run(
      "INSERT INTO task_work_owner (owner_id, task_id, work_id, created_at) VALUES (?, ?, ?, ?)",
      owner,
      taskId,
      workId,
      now,
    );
    if (!createdWork) {
      touch(owner, workId, now);
    }
    syncGoalShadow(owner, workId, now);
    evaluateOutcomeInTx(owner, workId, now);
    return { workId, createdWork };
  };

  /** Re-run the outcome evaluation for one Work (recovery and reconciliation; the Task transaction already does it inline). */
  const workEvaluate = (input: { principal: Principal; workId: string; now: number }) =>
    transaction(() => {
      const found = requireLive(input.principal.ownerId, input.workId);
      if (found.problem) {
        return { outcome: "not_found" as const };
      }
      evaluateOutcomeInTx(input.principal.ownerId, input.workId, input.now);
      return { outcome: "evaluated" as const };
    });

  const afterTaskSucceededInTx = (owner: string, taskId: string, now: number): void => {
    const workId = c.workOfTask(owner, taskId);
    if (workId) {
      evaluateOutcomeInTx(owner, workId, now);
    }
  };

  const workCreate = (input: { principal: Principal; spec: WorkSpec; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const spec = input.spec;
      if (spec.requestRef) {
        const dup = one(
          "SELECT id FROM works WHERE owner_id = ? AND request_ref = ?",
          owner,
          spec.requestRef,
        );
        if (dup) {
          return { outcome: "replayed" as const, workId: String(dup.id) };
        }
      }
      const id = insertWork(owner, spec, input.now);
      appendEvent(owner, id, "created", spec.origin, { via: "manual" }, input.now);
      return { outcome: "created" as const, workId: id };
    });

  // ------------------------------------------------------------------ reads

  const workGet = (input: {
    principal: Principal;
    workId: string;
    now: number;
    eventLimit: number;
  }) => {
    const owner = input.principal.ownerId;
    const found = requireLive(owner, input.workId);
    if (found.problem) {
      return null;
    }
    const row = workRow(owner, input.workId) as Row;
    const view = facts.buildViews(owner, [row], input.now)[0] as WorkView;
    const links = linkLines(
      owner,
      all(
        "SELECT * FROM work_links WHERE owner_id = ? AND work_id = ? ORDER BY created_at DESC LIMIT 200",
        owner,
        input.workId,
      ),
    );
    const events = all(
      "SELECT id, seq, kind, actor, payload_json, created_at FROM work_events WHERE owner_id = ? AND work_id = ? ORDER BY seq DESC LIMIT ?",
      owner,
      input.workId,
      input.eventLimit,
    ).map((event) => ({
      id: String(event.id),
      seq: Number(event.seq),
      kind: String(event.kind),
      actor: String(event.actor),
      payload: JSON.parse(String(event.payload_json)) as unknown,
      createdAt: Number(event.created_at),
    }));
    const controls = all(
      "SELECT * FROM work_controls WHERE owner_id = ? AND work_id = ? AND state <> 'released'",
      owner,
      input.workId,
    ).map((ctl) => ({
      id: String(ctl.id),
      scopeKind: String(ctl.scope_kind),
      scopeId: typeof ctl.scope_id === "string" ? ctl.scope_id : null,
      state: String(ctl.state),
      reason: typeof ctl.reason === "string" ? ctl.reason : null,
      reconcileOnly: Number(ctl.reconcile_only) === 1,
      createdAt: Number(ctl.created_at),
    }));
    const prerequisites = all(
      "SELECT * FROM work_prerequisites WHERE owner_id = ? AND work_id = ? AND state = 'pending'",
      owner,
      input.workId,
    ).map((p) => ({
      id: String(p.id),
      kind: String(p.kind),
      actor: String(p.actor),
      reason: String(p.reason),
      requestText: typeof p.request_text === "string" ? p.request_text : null,
      validUntil: p.valid_until === null ? null : Number(p.valid_until),
      createdAt: Number(p.created_at),
    }));
    const detail = { ...view, goalTitle: goalTitle(owner, view.goalId) };
    return { ...detail, links, events: events.toReversed(), controls, prerequisites };
  };

  const workList = (input: WorkListInput) => {
    const owner = input.principal.ownerId;
    const where = [
      "w.owner_id = ?",
      input.includeArchived ? "w.lifecycle IN ('live','archived')" : "w.lifecycle = 'live'",
    ];
    const params: (string | number)[] = [owner];
    if (!input.includeHidden) {
      where.push("w.hidden = 0");
    }
    if (input.contextMode) {
      where.push("w.context_mode = ?");
      params.push(input.contextMode);
    }
    if (input.goalId) {
      where.push(
        "EXISTS (SELECT 1 FROM goal_work_links g WHERE g.owner_id = w.owner_id AND g.work_id = w.id AND g.goal_id = ? AND g.ended_at IS NULL)",
      );
      params.push(input.goalId);
    }
    if (input.keyword) {
      const found = workKeywordFilter(input.keyword);
      where.push(found.sql);
      params.push(...found.params);
    }
    const rows = all(
      `SELECT w.* FROM works w WHERE ${where.join(" AND ")} ORDER BY w.updated_at DESC, w.id DESC LIMIT 2000`,
      ...params,
    );
    const views = facts.buildViews(owner, rows, input.now);
    const wanted = input.states && input.states.length > 0 ? new Set(input.states) : undefined;
    const filtered = wanted ? views.filter((view) => wanted.has(view.state.primary)) : views;
    // Array.prototype.sort is stable, so within one state the rows keep the "most recent first" order of the query.
    const matched =
      input.order === "state"
        ? filtered.toSorted(
            (a, b) => (STATE_ORDER[a.state.primary] ?? 9) - (STATE_ORDER[b.state.primary] ?? 9),
          )
        : filtered;
    return {
      works: matched.slice(input.offset, input.offset + input.limit),
      total: matched.length,
      offset: input.offset,
    };
  };

  const workOfTask = (input: { principal: Principal; taskId: string }) =>
    c.workOfTask(input.principal.ownerId, input.taskId) ?? null;

  // ------------------------------------------------------------------ updates

  type UpdateOutcome =
    | { outcome: "updated"; work: WorkRecord }
    | { outcome: "unchanged"; work: WorkRecord }
    | { outcome: "not_found" }
    | { outcome: "revision_conflict"; work: WorkRecord }
    | { outcome: "invalid"; code: string };

  const workUpdate = (input: {
    principal: Principal;
    workId: string;
    patch: { title?: string; outcomeText?: string | null; hidden?: boolean; archived?: boolean };
    expectedRevision?: number;
    actor: WorkActor;
    now: number;
  }): UpdateOutcome =>
    transaction((): UpdateOutcome => {
      const owner = input.principal.ownerId;
      const found = requireLive(owner, input.workId);
      if (found.problem) {
        return { outcome: "not_found" };
      }
      const work = found.work;
      if (input.expectedRevision !== undefined && input.expectedRevision !== work.revision) {
        return { outcome: "revision_conflict", work };
      }
      const patch = input.patch;
      if (
        patch.title !== undefined &&
        (patch.title.trim().length === 0 || patch.title.length > 300)
      ) {
        return { outcome: "invalid", code: "bad_title" };
      }
      if (
        patch.outcomeText !== undefined &&
        patch.outcomeText !== null &&
        patch.outcomeText.length > 4000
      ) {
        return { outcome: "invalid", code: "bad_outcome_text" };
      }
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      let versionChange = false;
      if (patch.title !== undefined && patch.title !== work.title) {
        sets.push("title = ?");
        params.push(patch.title);
        appendEvent(
          owner,
          work.id,
          "retitled",
          input.actor,
          { from: work.title, to: patch.title },
          input.now,
        );
        versionChange = true;
      }
      if (patch.outcomeText !== undefined && patch.outcomeText !== work.outcomeText) {
        sets.push("outcome_text = ?");
        params.push(patch.outcomeText);
        appendEvent(
          owner,
          work.id,
          "outcome_changed",
          input.actor,
          { to: patch.outcomeText },
          input.now,
        );
        versionChange = true;
      }
      if (patch.hidden !== undefined && patch.hidden !== work.hidden) {
        // Visibility only: no background work is paused or stopped by hiding (WK-04).
        sets.push("hidden = ?");
        params.push(patch.hidden ? 1 : 0);
      }
      if (patch.archived !== undefined) {
        if (patch.archived && work.lifecycle === "live") {
          sets.push("lifecycle = 'archived'", "archived_at = ?");
          params.push(input.now);
          appendEvent(owner, work.id, "archived", input.actor, {}, input.now);
        } else if (!patch.archived && work.lifecycle === "archived") {
          sets.push("lifecycle = 'live'", "archived_at = NULL");
          appendEvent(owner, work.id, "unarchived", input.actor, {}, input.now);
        }
      }
      if (sets.length === 0) {
        return { outcome: "unchanged", work };
      }
      if (versionChange) {
        // Title / outcome wording edits are metadata revisions (design 4.2.1): a new work_versions row, nothing re-runs.
        const next = work.currentWorkVersion + 1;
        run(
          "INSERT INTO work_versions (owner_id, work_id, work_version, context_mode, context_scope_id, context_semantic_version, " +
            "contract_version, outcome_text, diff_json, accepted_basis, created_at) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, ?)",
          owner,
          work.id,
          next,
          work.contextMode,
          work.primaryContextId,
          patch.outcomeText !== undefined ? patch.outcomeText : work.outcomeText,
          JSON.stringify({
            title: patch.title !== undefined,
            outcomeText: patch.outcomeText !== undefined,
          }),
          `${input.actor}_edit`,
          input.now,
        );
        sets.push("current_work_version = ?");
        params.push(next);
      }
      sets.push("revision = revision + 1", "updated_at = ?");
      params.push(input.now);
      run(
        `UPDATE works SET ${sets.join(", ")} WHERE owner_id = ? AND id = ?`,
        ...params,
        owner,
        work.id,
      );
      return { outcome: "updated", work: toWork(workRow(owner, work.id) as Row) };
    });

  const workDelete = (input: {
    principal: Principal;
    workId: string;
    actor: WorkActor;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = requireLive(owner, input.workId);
      if (found.problem) {
        return { outcome: "not_found" as const };
      }
      // Soft delete only (design 12.5): active Tasks must be dealt with first, the user is told which ones.
      const active = all(
        "SELECT t.id, t.title FROM task_work_owner o JOIN nexus_tasks t ON t.owner_id = o.owner_id AND t.id = o.task_id " +
          `WHERE o.owner_id = ? AND o.work_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ${TERMINAL_TASK} AND t.status NOT IN ('deleted','purging')`,
        owner,
        input.workId,
      ).map((row) => ({ id: String(row.id), title: String(row.title) }));
      if (active.length > 0) {
        return { outcome: "has_active_tasks" as const, tasks: active };
      }
      run(
        "UPDATE works SET lifecycle = 'deleted', deleted_at = ?, archived_at = NULL, revision = revision + 1, updated_at = ? WHERE owner_id = ? AND id = ?",
        input.now,
        input.now,
        owner,
        input.workId,
      );
      appendEvent(owner, input.workId, "deleted", input.actor, {}, input.now);
      return { outcome: "deleted" as const };
    });

  // ------------------------------------------------------------------ Goal

  const deps: WorkOpsDeps = {
    transaction,
    c,
    facts,
    requireLive,
    evaluateOutcomeInTx,
    syncGoalShadow,
  };
  const { workSetGoal } = createWorkGoalOps(deps);
  const { workLinkAdd, linkAddInTx, workLinkEnd, workPrereqAdd, workPrereqResolve } =
    createWorkLinkOps(deps);
  const { workControl, workRecordOutcome } = createWorkControlOps(deps);

  return {
    workCreate,
    workGet,
    workList,
    workCounts,
    workOfTask,
    workUpdate,
    workDelete,
    workSetGoal,
    workLinkAdd,
    workLinkEnd,
    workPrereqAdd,
    workPrereqResolve,
    workControl,
    workRecordOutcome,
    workEvaluate,
    hooks: { validateWorkInTx, attachTaskInTx, afterTaskSucceededInTx },
    /** Building blocks shared with work-backfill-ledger.ts (same transaction runner). Not worker operations. */
    internals: {
      common: c,
      facts,
      insertWork,
      syncGoalShadow,
      evaluateOutcomeInTx,
      requireLive,
      linkAddInTx,
    },
  };
}

export type WorkLedger = ReturnType<typeof createWorkLedger>;
