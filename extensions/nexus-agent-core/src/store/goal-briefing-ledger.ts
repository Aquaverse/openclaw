import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { WorkCommon } from "./work-ledger-common.js";

// Goal letter policy, the minimal version (object-model design 4.5.4, NX-03): one row per Goal saying whether the weekly letter is
// switched on and when. This batch stores the policy only; nothing generates a letter yet. A Goal's rest mode (muting its
// nudges) never touches this row, and completing a Goal does not switch it off: the user does that in settings.

export type BriefingCadence = { kind: "weekly"; weekday: number };
export type BriefingPolicy = {
  goalId: string;
  enabled: boolean;
  cadence: BriefingCadence | null;
  version: number;
  updatedAt: number;
};

export function createGoalBriefingOps(deps: { transaction: TransactionRunner; c: WorkCommon }) {
  const { transaction, c } = deps;
  const { one, run } = c;

  const read = (owner: string, goalId: string): BriefingPolicy | null => {
    const row = one(
      "SELECT * FROM goal_briefing_policies WHERE owner_id = ? AND goal_id = ?",
      owner,
      goalId,
    );
    if (!row) {
      return null;
    }
    let cadence: BriefingCadence | null;
    try {
      cadence = row.cadence_json ? (JSON.parse(String(row.cadence_json)) as BriefingCadence) : null;
    } catch {
      cadence = null;
    }
    return {
      goalId,
      enabled: Number(row.enabled) === 1,
      cadence,
      version: Number(row.version),
      updatedAt: Number(row.updated_at),
    };
  };

  const goalBriefingGet = (input: { principal: Principal; goalId: string }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (!one("SELECT 1 AS found FROM goals WHERE owner_id = ? AND id = ?", owner, input.goalId)) {
        return { outcome: "not_found" as const };
      }
      // A Goal with no row has the letter off: that is the default, not a stored fact.
      return {
        outcome: "ok" as const,
        policy: read(owner, input.goalId) ?? {
          goalId: input.goalId,
          enabled: false,
          cadence: null,
          version: 0,
          updatedAt: 0,
        },
      };
    });

  const goalBriefingSet = (input: {
    principal: Principal;
    goalId: string;
    enabled: boolean;
    cadence?: BriefingCadence | null;
    expectedVersion?: number;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const goal = one(
        "SELECT lifecycle FROM goals WHERE owner_id = ? AND id = ?",
        owner,
        input.goalId,
      );
      if (!goal || String(goal.lifecycle) !== "live") {
        return { outcome: "not_found" as const };
      }
      const before = read(owner, input.goalId);
      if (input.expectedVersion !== undefined && input.expectedVersion !== (before?.version ?? 0)) {
        return { outcome: "conflict" as const, policy: before };
      }
      const cadence = input.cadence === undefined ? (before?.cadence ?? null) : input.cadence;
      if (
        cadence !== null &&
        (cadence.kind !== "weekly" ||
          !Number.isInteger(cadence.weekday) ||
          cadence.weekday < 0 ||
          cadence.weekday > 6)
      ) {
        return { outcome: "invalid" as const, code: "bad_cadence" };
      }
      if (input.enabled && cadence === null) {
        return { outcome: "invalid" as const, code: "cadence_required" };
      }
      const cadenceJson = cadence === null ? null : JSON.stringify(cadence);
      if (!before) {
        run(
          "INSERT INTO goal_briefing_policies (owner_id, goal_id, enabled, cadence_json, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)",
          owner,
          input.goalId,
          input.enabled ? 1 : 0,
          cadenceJson,
          input.now,
          input.now,
        );
      } else if (
        before.enabled === input.enabled &&
        JSON.stringify(before.cadence) === JSON.stringify(cadence)
      ) {
        return { outcome: "unchanged" as const, policy: before };
      } else {
        run(
          "UPDATE goal_briefing_policies SET enabled = ?, cadence_json = ?, version = version + 1, updated_at = ? WHERE owner_id = ? AND goal_id = ?",
          input.enabled ? 1 : 0,
          cadenceJson,
          input.now,
          owner,
          input.goalId,
        );
      }
      return { outcome: "saved" as const, policy: read(owner, input.goalId) as BriefingPolicy };
    });

  return { goalBriefingGet, goalBriefingSet };
}
