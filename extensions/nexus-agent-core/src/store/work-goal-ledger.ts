// Work <-> Goal link (design 4.2.3): goal_work_links is the single write source; the goal_links(kind='task') shadow is kept in step.
import type { Principal } from "./types.js";
import type { WorkActor } from "./work-ledger-common.js";
import type { WorkOpsDeps } from "./work-ledger-deps.js";

export function createWorkGoalOps(deps: WorkOpsDeps) {
  const { transaction, c, requireLive, syncGoalShadow } = deps;
  const { one, run, newId, appendEvent, touch } = c;

  const workSetGoal = (input: {
    principal: Principal;
    workId: string;
    goalId: string | null;
    role?: "primary" | "reference";
    actor: WorkActor;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = requireLive(owner, input.workId);
      if (found.problem) {
        return { outcome: "not_found" as const };
      }
      const work = found.work;
      const role = input.role ?? "primary";
      if (input.goalId === null) {
        const ended = run(
          "UPDATE goal_work_links SET ended_at = ?, end_basis = 'cleared' WHERE owner_id = ? AND work_id = ? AND role = ? AND ended_at IS NULL",
          input.now,
          owner,
          work.id,
          role,
        );
        if (ended > 0) {
          appendEvent(owner, work.id, "goal_cleared", input.actor, { role }, input.now);
          syncGoalShadow(owner, work.id, input.now);
          touch(owner, work.id, input.now);
        }
        return { outcome: "cleared" as const, ended };
      }
      if (work.contextMode !== "personal") {
        return { outcome: "executive_work" as const };
      }
      const goal = one(
        "SELECT lifecycle, status FROM goals WHERE owner_id = ? AND id = ?",
        owner,
        input.goalId,
      );
      if (!goal) {
        return { outcome: "goal_not_found" as const };
      }
      if (String(goal.lifecycle) !== "live" || String(goal.status) === "proposed") {
        return {
          outcome: "goal_not_usable" as const,
          lifecycle: String(goal.lifecycle),
          status: String(goal.status),
        };
      }
      const same = one(
        "SELECT role FROM goal_work_links WHERE owner_id = ? AND goal_id = ? AND work_id = ? AND ended_at IS NULL",
        owner,
        input.goalId,
        work.id,
      );
      if (same && String(same.role) === role) {
        return { outcome: "unchanged" as const };
      }
      if (same) {
        run(
          "UPDATE goal_work_links SET ended_at = ?, end_basis = 'role_changed' WHERE owner_id = ? AND goal_id = ? AND work_id = ? AND ended_at IS NULL",
          input.now,
          owner,
          input.goalId,
          work.id,
        );
      }
      if (role === "primary") {
        run(
          "UPDATE goal_work_links SET ended_at = ?, end_basis = 'replaced' WHERE owner_id = ? AND work_id = ? AND role = 'primary' AND ended_at IS NULL",
          input.now,
          owner,
          work.id,
        );
      }
      run(
        "INSERT INTO goal_work_links (owner_id, id, goal_id, work_id, role, work_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        owner,
        newId("gw_"),
        input.goalId,
        work.id,
        role,
        work.currentWorkVersion,
        input.now,
      );
      appendEvent(
        owner,
        work.id,
        "goal_set",
        input.actor,
        { goalId: input.goalId, role },
        input.now,
      );
      syncGoalShadow(owner, work.id, input.now);
      touch(owner, work.id, input.now);
      return { outcome: "linked" as const, role };
    });

  // ------------------------------------------------------------------ typed links

  return { workSetGoal };
}
