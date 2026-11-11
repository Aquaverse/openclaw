// Work kernel: gathers the facts `deriveWorkState` needs for a set of Works in one batch (a handful of `IN (...)` statements, no
// SQL inside a loop, design 5.5) and builds the Work view. Read only.
import {
  deriveWorkState,
  taskPhase,
  type CommitmentFact,
  type ControlFact,
  type OutcomeFact,
  type PrereqFact,
  type ScheduleFact,
  type TaskFact,
  type TerminalFact,
  type UnknownEffectFact,
  type WorkFacts,
} from "../work/derive.js";
import type { ResultAtClose, WorkRecord, WorkState } from "../work/types.js";
import { toWork, type Row, type WorkCommon } from "./work-ledger-common.js";

const CHUNK = 400;
const TERMINAL_PHASES = new Set(["completed", "partial", "failed", "cancelled"]);

export type WorkTaskLine = {
  id: string;
  title: string;
  status: string;
  phase: string;
  superseded: boolean;
};
export type WorkView = {
  work: WorkRecord;
  state: WorkState;
  goalId: string | null;
  tasks: WorkTaskLine[];
  openPrerequisites: number;
  outcome: {
    eventId: string;
    eventType: string;
    basis: string;
    recordedAt: number;
    firstAchievedAt: number | null;
  } | null;
  terminal: { id: string; reason: string; resultAtClose: string; recordedAt: number } | null;
};

const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) {
    out.push(items.slice(i, i + CHUNK));
  }
  return out;
};

export function createWorkFacts(c: WorkCommon) {
  const { all } = c;
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");
  const group = <T extends Row>(rows: T[], key: string): Map<string, T[]> => {
    const map = new Map<string, T[]>();
    for (const row of rows) {
      const k = String(row[key]);
      const list = map.get(k);
      if (list) {
        list.push(row);
      } else {
        map.set(k, [row]);
      }
    }
    return map;
  };
  const inChunks = (
    owner: string,
    ids: string[],
    sql: (m: string) => string,
    extra: (string | number)[] = [],
  ): Row[] => chunks(ids).flatMap((part) => all(sql(marks(part.length)), owner, ...part, ...extra));

  /** The chain head per Work: the event no other event names as its predecessor. */
  const outcomeHead = (events: Row[]): Row | undefined => {
    const previous = new Set(
      events.map((e) => e.previous_event_id).filter((v) => typeof v === "string"),
    );
    return events.find((e) => !previous.has(String(e.id)));
  };

  const buildViews = (owner: string, workRows: Row[], now: number): WorkView[] => {
    const works = workRows.map(toWork);
    const ids = works.map((work) => work.id);
    if (ids.length === 0) {
      return [];
    }
    const owners = group(
      inChunks(
        owner,
        ids,
        (m) =>
          "SELECT o.work_id, t.id, t.title, t.status FROM task_work_owner o JOIN nexus_tasks t " +
          `ON t.owner_id = o.owner_id AND t.id = o.task_id WHERE o.owner_id = ? AND o.work_id IN (${m}) AND t.deleted_at IS NULL`,
      ),
      "work_id",
    );
    const ext = new Map(
      inChunks(
        owner,
        ids,
        (m) =>
          "SELECT x.* FROM task_ext x JOIN task_work_owner o ON o.owner_id = x.owner_id AND o.task_id = x.task_id " +
          `WHERE o.owner_id = ? AND o.work_id IN (${m})`,
      ).map((row) => [String(row.task_id), row] as const),
    );
    const superseded = new Set(
      [...ext.values()]
        .map((row) => row.supersedes_task_id)
        .filter((v): v is string => typeof v === "string"),
    );
    const pendingDecisions = new Set(
      inChunks(
        owner,
        ids,
        (m) =>
          "SELECT DISTINCT d.task_id FROM decisions d JOIN task_work_owner o ON o.owner_id = d.owner_id AND o.task_id = d.task_id " +
          `WHERE o.owner_id = ? AND o.work_id IN (${m}) AND d.status = 'pending' AND (d.deadline_at IS NULL OR d.deadline_at > ?)`,
        [now],
      ).map((row) => String(row.task_id)),
    );
    const activeWatch = new Set(
      inChunks(
        owner,
        ids,
        (m) =>
          "SELECT DISTINCT w.task_id FROM watches w JOIN task_work_owner o ON o.owner_id = w.owner_id AND o.task_id = w.task_id " +
          `WHERE o.owner_id = ? AND o.work_id IN (${m}) AND w.status IN ('pending_schedule','scheduled','firing')`,
      ).map((row) => String(row.task_id)),
    );
    // The follow-up schedules of each Work (design 4.5.2). Cancelled counts as ended; the stored stop reason travels with it.
    const scheduleRows = group(
      inChunks(
        owner,
        ids,
        (m) =>
          `SELECT work_id, id, status, coverage_state, stop_reason FROM schedules WHERE owner_id = ? AND work_id IN (${m}) ORDER BY created_at, id`,
      ),
      "work_id",
    );
    const controls = group(
      inChunks(
        owner,
        ids,
        (m) =>
          `SELECT * FROM work_controls WHERE owner_id = ? AND work_id IN (${m}) AND state <> 'released'`,
      ),
      "work_id",
    );
    const adoptions = new Map(
      inChunks(
        owner,
        ids,
        (m) => `SELECT * FROM task_adoptions WHERE owner_id = ? AND work_id IN (${m})`,
      ).map((row) => [String(row.task_id), row] as const),
    );
    const prereqs = group(
      inChunks(
        owner,
        ids,
        (m) =>
          `SELECT * FROM work_prerequisites WHERE owner_id = ? AND work_id IN (${m}) AND state = 'pending'`,
      ),
      "work_id",
    );
    const outcomes = group(
      inChunks(
        owner,
        ids,
        (m) => `SELECT * FROM work_outcome_events WHERE owner_id = ? AND work_id IN (${m})`,
      ),
      "work_id",
    );
    const terminals = group(
      inChunks(
        owner,
        ids,
        (m) =>
          `SELECT * FROM work_terminal_events WHERE owner_id = ? AND work_id IN (${m}) AND reopened_at IS NULL ORDER BY recorded_at DESC`,
      ),
      "work_id",
    );
    const windowPending = new Set(
      inChunks(
        owner,
        ids,
        (m) =>
          `SELECT DISTINCT work_id FROM window_evaluation_requests WHERE owner_id = ? AND work_id IN (${m}) AND state IN ('pending','wrapping_up') AND window_end_at <= ?`,
        [now],
      ).map((row) => String(row.work_id)),
    );
    const unknownEffects = group(
      inChunks(
        owner,
        ids,
        (m) =>
          "SELECT e.id, o.work_id FROM action_executions e JOIN task_work_owner o ON o.owner_id = e.owner_id AND o.task_id = e.task_id " +
          `WHERE o.owner_id = ? AND o.work_id IN (${m}) AND e.state = 'unknown'`,
      ),
      "work_id",
    );
    const commitmentRows = group(
      inChunks(
        owner,
        ids,
        (m) =>
          "SELECT l.work_id, c.id, c.lifecycle, c.resolution_basis, c.verification FROM work_links l JOIN commitments c " +
          `ON c.owner_id = l.owner_id AND c.id = l.target_id WHERE l.owner_id = ? AND l.work_id IN (${m}) ` +
          "AND l.role = 'required' AND l.target_kind = 'commitment' AND l.ended_at IS NULL",
      ),
      "work_id",
    );
    const goals = new Map(
      inChunks(
        owner,
        ids,
        (m) =>
          `SELECT work_id, goal_id FROM goal_work_links WHERE owner_id = ? AND work_id IN (${m}) AND role = 'primary' AND ended_at IS NULL`,
      ).map((row) => [String(row.work_id), String(row.goal_id)] as const),
    );

    return works.map((work): WorkView => {
      const taskLines: WorkTaskLine[] = [];
      const taskFacts: TaskFact[] = [];
      const workControls = controls.get(work.id) ?? [];
      const workPaused = workControls.some((row) => row.scope_kind === "work");
      for (const row of owners.get(work.id) ?? []) {
        const taskId = String(row.id);
        const x = ext.get(taskId);
        const taskPaused =
          workPaused ||
          workControls.some((ctl) => ctl.scope_kind === "task" && ctl.scope_id === taskId);
        const phase = taskPhase({
          status: String(row.status),
          endKind: x && x.end_kind === "partial" ? "partial" : null,
          blockedSince:
            x && x.blocked_since !== null && x.blocked_since !== undefined
              ? Number(x.blocked_since)
              : null,
          hasPendingDecision: pendingDecisions.has(taskId),
          controlPaused: taskPaused,
          hasActiveWatch: activeWatch.has(taskId),
        });
        if (!phase) {
          continue;
        }
        const isSuperseded = superseded.has(taskId);
        taskLines.push({
          id: taskId,
          title: String(row.title),
          status: String(row.status),
          phase: phase.phase,
          superseded: isSuperseded,
        });
        const fact: TaskFact = { id: taskId, phase: phase.phase, required: !isSuperseded };
        if (phase.blockedReason) {
          fact.blockedReason = phase.blockedReason;
        }
        const adoption = adoptions.get(taskId);
        if (adoption && !TERMINAL_PHASES.has(phase.phase)) {
          const state = String(adoption.state);
          if (
            state === "pending" ||
            (state === "adopted" && Number(adoption.work_version) < work.currentWorkVersion)
          ) {
            fact.adoption = "needs_user";
          } else if (state === "quarantined") {
            fact.adoption = "accepted_waiting";
          }
        }
        taskFacts.push(fact);
      }

      const events = outcomes.get(work.id) ?? [];
      const head = outcomeHead(events);
      const validHead =
        head && (head.event_type === "achieved" || head.event_type === "reinstated")
          ? head
          : undefined;
      const firstAchieved = events
        .filter((e) => e.event_type === "achieved")
        .map((e) => Number(e.recorded_at))
        .toSorted((a, b) => a - b)[0];
      const outcomeFact: OutcomeFact = validHead
        ? {
            eventId: String(validHead.id),
            basis: String(validHead.basis),
            provenance: String(validHead.provenance),
          }
        : null;

      const terminalRow = (terminals.get(work.id) ?? [])[0];
      const terminalFact: TerminalFact = terminalRow
        ? {
            id: String(terminalRow.id),
            resultAtClose: String(terminalRow.result_at_close) as ResultAtClose,
            reason: String(terminalRow.reason),
            windowPending: false,
          }
        : windowPending.has(work.id)
          ? {
              id: "window_pending",
              resultAtClose: "unknown",
              reason: "window_ended",
              windowPending: true,
            }
          : null;

      const prereqFacts: PrereqFact[] = (prereqs.get(work.id) ?? []).map((row) => ({
        id: String(row.id),
        kind: String(row.kind),
        actor: String(row.actor) as "user" | "system",
        dispatchValid:
          typeof row.first_plan_request_id === "string" &&
          row.lease_until !== null &&
          row.lease_until !== undefined &&
          Number(row.lease_until) > now,
      }));
      const controlFacts: ControlFact[] = workControls.map((row) => ({
        id: String(row.id),
        scopeKind: String(row.scope_kind) as ControlFact["scopeKind"],
        scopeId: typeof row.scope_id === "string" ? row.scope_id : null,
        state: String(row.state) as ControlFact["state"],
        reason: typeof row.reason === "string" ? row.reason : null,
        reconcileOnly: Number(row.reconcile_only) === 1,
      }));
      const effects: UnknownEffectFact[] = (unknownEffects.get(work.id) ?? []).map((row) => ({
        id: String(row.id),
        affectsRequired: true,
      }));

      const commitmentFacts: CommitmentFact[] = (commitmentRows.get(work.id) ?? []).map((row) => {
        const lifecycle = String(row.lifecycle);
        const open = lifecycle === "open" || lifecycle === "waiting";
        return {
          id: String(row.id),
          // No longer an open obligation to chase: closed one way or the other. Whether that closing fulfils the Work is the
          // outcome event's business (a manual close or a cancel never does), shown to the user through `needsUser` below.
          resolved: !open,
          needsUser:
            lifecycle === "cancelled" ||
            (lifecycle === "resolved" && String(row.resolution_basis) === "manual_override") ||
            (open &&
              ["verified_exception", "conflicting_evidence"].includes(String(row.verification))),
        };
      });
      const facts: WorkFacts = {
        work: { id: work.id, lifecycle: work.lifecycle === "archived" ? "archived" : "live" },
        // The contract engine is not wired yet: every Work runs on the implicit default contract (version 1).
        contract: { version: 1 },
        outcome: outcomeFact,
        terminal: terminalFact,
        prerequisites: prereqFacts,
        tasks: taskFacts,
        commitments: commitmentFacts,
        schedules: (scheduleRows.get(work.id) ?? []).map((row): ScheduleFact => {
          const fact: ScheduleFact = {
            id: String(row.id),
            status: (String(row.status) === "cancelled"
              ? "ended"
              : String(row.status)) as ScheduleFact["status"],
            coverage: String(row.coverage_state) as ScheduleFact["coverage"],
            needsUser: false,
          };
          if (typeof row.stop_reason === "string") {
            fact.stopReason = row.stop_reason;
          }
          return fact;
        }),
        controls: controlFacts,
        unknownEffects: effects,
        evaluatedAt: now,
      };
      return {
        work,
        state: deriveWorkState(facts),
        goalId: goals.get(work.id) ?? null,
        tasks: taskLines,
        openPrerequisites: prereqFacts.length,
        outcome: validHead
          ? {
              eventId: String(validHead.id),
              eventType: String(validHead.event_type),
              basis: String(validHead.basis),
              recordedAt: Number(validHead.recorded_at),
              firstAchievedAt: firstAchieved ?? null,
            }
          : null,
        terminal: terminalRow
          ? {
              id: String(terminalRow.id),
              reason: String(terminalRow.reason),
              resultAtClose: String(terminalRow.result_at_close),
              recordedAt: Number(terminalRow.recorded_at),
            }
          : null,
      };
    });
  };

  return { buildViews, outcomeHead };
}

export type WorkFactsReader = ReturnType<typeof createWorkFacts>;
