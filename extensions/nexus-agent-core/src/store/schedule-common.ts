// Schedule kernel, shared part: row mapping, owner lookups and the checks every operation module needs (design 4.5, INV-10/11/12).
// No transaction is opened here; the modules around it own theirs. Every statement filters on owner_id.
import { normalizeCadence, type Cadence } from "../schedule/cadence.js";
import {
  BLOCK_CODES,
  SCHEDULE_LIMITS,
  type BlockReason,
  type DelegationPlanRecord,
  type PlanBody,
  type PlanGap,
  type PlanOwnerType,
  type ScheduleRecord,
  type ScheduleSpec,
  type TriggerRecord,
} from "../schedule/types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null =>
  value === null || value === undefined ? null : Number(value);
const parse = <T>(text: unknown, fallback: T): T => {
  if (typeof text !== "string") {
    return fallback;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

export function toPlan(row: Row): DelegationPlanRecord {
  return {
    ownerId: String(row.owner_id),
    id: String(row.id),
    workId: String(row.work_id),
    workVersion: Number(row.work_version),
    planOwnerType: String(row.plan_owner_type) as PlanOwnerType,
    planOwnerId: String(row.plan_owner_id),
    purpose: String(row.purpose),
    planVersion: Number(row.plan_version),
    status: String(row.status) as DelegationPlanRecord["status"],
    plan: parse<PlanBody>(row.plan_json, {}),
    gaps: parse<PlanGap[]>(row.gaps_json, []),
    startIntent: String(row.start_intent) as DelegationPlanRecord["startIntent"],
    acceptedResponsibilityVersion: num(row.accepted_responsibility_version),
    acceptedContractVersion: num(row.accepted_contract_version),
    replacesPlanId: str(row.replaces_plan_id),
    endReason: str(row.end_reason),
    createdBy: String(row.created_by) as "user" | "agent",
    createdAt: Number(row.created_at),
    acceptedAt: num(row.accepted_at),
    endedAt: num(row.ended_at),
  };
}

export function toSchedule(row: Row): ScheduleRecord {
  return {
    ownerId: String(row.owner_id),
    id: String(row.id),
    workId: String(row.work_id),
    ownerType: String(row.owner_type) as ScheduleRecord["ownerType"],
    ownerRef: String(row.owner_ref),
    planId: str(row.plan_id),
    planVersion: num(row.plan_version),
    scheduleKind: String(row.schedule_kind) as ScheduleRecord["scheduleKind"],
    purpose: String(row.purpose),
    cadence: parse<Cadence>(row.cadence_json, { kind: "once", at: 0 }),
    tz: String(row.tz),
    nextDueAt: num(row.next_due_at),
    dispatchWindowMs: num(row.dispatch_window_ms),
    executorKind: String(row.executor_kind) as ScheduleRecord["executorKind"],
    executorRef: str(row.executor_ref),
    status: String(row.status) as ScheduleRecord["status"],
    pauseSource: str(row.pause_source) as ScheduleRecord["pauseSource"],
    blockReasons: parse<BlockReason[]>(row.block_reasons_json, []),
    lastManualTriggerAt: num(row.last_manual_trigger_at),
    stopReason: str(row.stop_reason),
    endedAt: num(row.ended_at),
    coverageState: String(row.coverage_state) as ScheduleRecord["coverageState"],
    coverageNote: str(row.coverage_note),
    replacesScheduleId: str(row.replaces_schedule_id),
    createdVia: String(row.created_via) as "plan" | "migration",
    revision: Number(row.revision),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export function toTrigger(row: Row): TriggerRecord {
  return {
    id: String(row.id),
    scheduleId: String(row.schedule_id),
    scheduleRevision: Number(row.schedule_revision),
    occurrenceKey: String(row.occurrence_key),
    planVersion: Number(row.plan_version),
    source: String(row.source) as TriggerRecord["source"],
    plannedAt: Number(row.planned_at),
    outcome: String(row.outcome) as TriggerRecord["outcome"],
    skipReason: str(row.skip_reason),
    mergedOccurrenceKeys: parse<string[]>(row.merged_occurrence_keys_json, []),
    taskId: str(row.task_id),
    slotOpen: Number(row.slot_open) === 1,
    firedAt: num(row.fired_at),
    createdAt: Number(row.created_at),
  };
}

/** The reason a block list is not acceptable, or null: a non-empty list of codes from the closed set. */
export function badBlockReasons(reasons: unknown): string | null {
  if (!Array.isArray(reasons) || reasons.length === 0 || reasons.length > 9) {
    return "bad_block_reasons";
  }
  for (const reason of reasons) {
    const r = reason as Partial<BlockReason> | null;
    if (
      !r ||
      !(BLOCK_CODES as readonly string[]).includes(String(r.code)) ||
      (r.actor !== "user" && r.actor !== "system") ||
      (r.ref !== undefined && (typeof r.ref !== "string" || r.ref.length > SCHEDULE_LIMITS.ref))
    ) {
      return "bad_block_reasons";
    }
  }
  return null;
}

/** Validate every schedule a plan will create; returns the normalised cadences in order, or the first problem. */
export function checkSpecs(
  specs: unknown,
  now: number,
): { ok: true; cadences: Cadence[] } | { ok: false; code: string } {
  if (
    !Array.isArray(specs) ||
    specs.length === 0 ||
    specs.length > SCHEDULE_LIMITS.schedulesPerPlan
  ) {
    return { ok: false, code: "bad_schedules" };
  }
  const cadences: Cadence[] = [];
  for (const spec of specs as ScheduleSpec[]) {
    const purpose = typeof spec?.purpose === "string" ? spec.purpose.trim() : "";
    if (purpose.length === 0 || purpose.length > SCHEDULE_LIMITS.purpose) {
      return { ok: false, code: "bad_purpose" };
    }
    if (spec.scheduleKind !== "once" && spec.scheduleKind !== "recurring") {
      return { ok: false, code: "bad_schedule_kind" };
    }
    const cadence = normalizeCadence(spec.cadence, spec.tz);
    if (!cadence.ok) {
      return { ok: false, code: cadence.problem };
    }
    if ((spec.scheduleKind === "once") !== (cadence.cadence.kind === "once")) {
      return { ok: false, code: "kind_cadence_mismatch" };
    }
    if (cadence.cadence.kind === "once" && cadence.cadence.at <= now) {
      return { ok: false, code: "once_in_past" };
    }
    const executor = spec.executorKind ?? "check_task";
    if (executor !== "watch" && executor !== "check_task") {
      return { ok: false, code: "bad_executor" };
    }
    if (executor === "watch" && (typeof spec.executorRef !== "string" || spec.executorRef === "")) {
      return { ok: false, code: "watch_needs_ref" };
    }
    if (
      spec.dispatchWindowMs !== undefined &&
      (!Number.isSafeInteger(spec.dispatchWindowMs) || spec.dispatchWindowMs <= 0)
    ) {
      return { ok: false, code: "bad_window" };
    }
    cadences.push(cadence.cadence);
  }
  return { ok: true, cadences };
}

export function createScheduleCommon(c: WorkCommon) {
  const { one, all } = c;

  const planRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM delegation_plans WHERE owner_id = ? AND id = ?", owner, id);
  const scheduleRow = (owner: string, id: string): Row | undefined =>
    one("SELECT * FROM schedules WHERE owner_id = ? AND id = ?", owner, id);
  const plan = (owner: string, id: string): DelegationPlanRecord | undefined => {
    const row = planRow(owner, id);
    return row ? toPlan(row) : undefined;
  };
  const schedule = (owner: string, id: string): ScheduleRecord | undefined => {
    const row = scheduleRow(owner, id);
    return row ? toSchedule(row) : undefined;
  };
  const schedulesOfPlan = (owner: string, planId: string): ScheduleRecord[] =>
    all(
      "SELECT * FROM schedules WHERE owner_id = ? AND plan_id = ? ORDER BY created_at, id",
      owner,
      planId,
    ).map(toSchedule);

  /**
   * Does the business owner of a plan still exist and still take follow-up? `owner_missing` / `owner_closed` otherwise.
   * A Commitment must be open or waiting, a Goal live and confirmed, a Work live.
   */
  const ownerProblem = (
    owner: string,
    type: PlanOwnerType,
    id: string,
  ): "owner_missing" | "owner_closed" | null => {
    if (type === "commitment") {
      const row = one("SELECT lifecycle FROM commitments WHERE owner_id = ? AND id = ?", owner, id);
      if (!row) {
        return "owner_missing";
      }
      return ["open", "waiting"].includes(String(row.lifecycle)) ? null : "owner_closed";
    }
    if (type === "personal_goal") {
      const row = one(
        "SELECT lifecycle, status FROM goals WHERE owner_id = ? AND id = ?",
        owner,
        id,
      );
      if (!row) {
        return "owner_missing";
      }
      return String(row.lifecycle) === "live" && String(row.status) !== "proposed"
        ? null
        : "owner_closed";
    }
    const row = c.workRow(owner, id);
    if (!row) {
      return "owner_missing";
    }
    return ["live", "archived"].includes(String(row.lifecycle)) ? null : "owner_closed";
  };

  /** Does the carrier Work cite the plan's owner with a valid link (INV-10, INV-11)? Work plans need none. */
  const carrierLinked = (
    owner: string,
    type: PlanOwnerType,
    ownerId: string,
    workId: string,
  ): boolean => {
    if (type === "commitment") {
      return (
        one(
          "SELECT 1 AS found FROM work_links WHERE owner_id = ? AND work_id = ? AND target_kind = 'commitment' AND target_id = ? " +
            "AND role IN ('required','reference') AND ended_at IS NULL",
          owner,
          workId,
          ownerId,
        ) !== undefined
      );
    }
    if (type === "personal_goal") {
      return (
        one(
          "SELECT 1 AS found FROM goal_work_links WHERE owner_id = ? AND goal_id = ? AND work_id = ? AND ended_at IS NULL",
          owner,
          ownerId,
          workId,
        ) !== undefined
      );
    }
    return true;
  };

  /** Is a Task finished for good (so it no longer holds its schedule's dispatch slot)? A Task that cannot be read counts as finished. */
  const taskIsFinished = (owner: string, taskId: string): boolean => {
    const row = one(
      "SELECT status, deleted_at FROM nexus_tasks WHERE owner_id = ? AND id = ?",
      owner,
      taskId,
    );
    return (
      !row ||
      row.deleted_at !== null ||
      ["succeeded", "failed", "cancelled", "deleted", "purging"].includes(String(row.status))
    );
  };

  return {
    planRow,
    scheduleRow,
    plan,
    schedule,
    schedulesOfPlan,
    ownerProblem,
    carrierLinked,
    taskIsFinished,
  };
}
export type ScheduleCommon = ReturnType<typeof createScheduleCommon>;
