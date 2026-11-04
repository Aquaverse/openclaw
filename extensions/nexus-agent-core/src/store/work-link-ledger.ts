// Typed links from a Work and its prerequisites (design 4.2.4, 4.2.7). Links are ended, never deleted; a prerequisite is
// resolved by appending the answer, never by rewriting the request.
import { createCommitmentCommon } from "./commitment-common.js";
import type { Principal } from "./types.js";
import type { WorkActor } from "./work-ledger-common.js";
import type { WorkOpsDeps } from "./work-ledger-deps.js";

export function createWorkLinkOps(deps: WorkOpsDeps) {
  const { transaction, c, requireLive } = deps;
  const { one, run, newId, appendEvent, touch, hasTable } = c;
  const commitmentEvents = createCommitmentCommon(c);

  const LINK_ROLES = [
    "required",
    "reference",
    "coordination",
    "handoff_result",
    "output_dependency",
  ] as const;
  const LINK_TARGETS = ["work", "commitment", "task_output", "artifact"] as const;

  type LinkAddInput = {
    principal: Principal;
    workId: string;
    role: string;
    targetKind: string;
    targetId: string;
    purpose?: string | null;
    taskPlanVersion?: number;
    outputRef?: string;
    originalResultId?: string;
    artifactFileId?: string;
    artifactVersionSeq?: number;
    actor: WorkActor;
    now: number;
  };

  /** Add a link inside the caller's transaction (the Commitment ledger links a Commitment it just created). */
  const linkAddInTx = (input: LinkAddInput) => {
    const owner = input.principal.ownerId;
    const found = requireLive(owner, input.workId);
    if (found.problem) {
      return { outcome: "not_found" as const };
    }
    if (
      !(LINK_ROLES as readonly string[]).includes(input.role) ||
      !(LINK_TARGETS as readonly string[]).includes(input.targetKind)
    ) {
      return { outcome: "invalid" as const, code: "bad_role_or_target" };
    }
    if (
      typeof input.targetId !== "string" ||
      input.targetId.length === 0 ||
      input.targetId.length > 200
    ) {
      return { outcome: "invalid" as const, code: "bad_target_id" };
    }
    if (input.targetKind === "commitment") {
      const target = one(
        "SELECT 1 AS found FROM commitments WHERE owner_id = ? AND id = ?",
        owner,
        input.targetId,
      );
      if (!target) {
        return { outcome: "target_not_found" as const };
      }
    } else if (input.targetKind === "work") {
      const other = requireLive(owner, input.targetId);
      if (other.problem || input.targetId === input.workId) {
        return { outcome: "target_not_found" as const };
      }
    } else if (input.targetKind === "task_output") {
      const task = one(
        "SELECT status FROM nexus_tasks WHERE owner_id = ? AND id = ? AND deleted_at IS NULL",
        owner,
        input.targetId,
      );
      if (!task || String(task.status) === "purging") {
        return { outcome: "target_not_found" as const };
      }
      if (c.workOfTask(owner, input.targetId) === input.workId) {
        // Output dependencies exist to cite ANOTHER Work's Task; a Work's own Tasks are already its primary branch.
        return { outcome: "invalid" as const, code: "own_task" };
      }
    } else if (input.targetKind === "artifact") {
      if (
        !hasTable("vault_versions") ||
        input.artifactFileId === undefined ||
        input.artifactVersionSeq === undefined
      ) {
        return { outcome: "invalid" as const, code: "artifact_needs_file_and_version" };
      }
      const version = one(
        "SELECT 1 AS found FROM vault_versions WHERE owner_id = ? AND file_id = ? AND seq = ?",
        owner,
        input.artifactFileId,
        input.artifactVersionSeq,
      );
      if (!version) {
        return { outcome: "target_not_found" as const };
      }
    }
    const targetId =
      input.targetKind === "artifact"
        ? `${input.artifactFileId}#${input.artifactVersionSeq}`
        : input.targetId;
    if (input.targetKind === "commitment") {
      // One Commitment is cited once by a Work, as required or as a reference; changing that is a role change, not a second link
      // (two links would show the same Commitment twice, once as required and once as optional).
      const other = one(
        "SELECT id, role FROM work_links WHERE owner_id = ? AND work_id = ? AND target_kind = 'commitment' AND target_id = ? AND role <> ? AND ended_at IS NULL",
        owner,
        input.workId,
        input.targetId,
        input.role,
      );
      if (other) {
        return {
          outcome: "role_conflict" as const,
          linkId: String(other.id),
          role: String(other.role),
        };
      }
    }
    const dup = one(
      "SELECT id FROM work_links WHERE owner_id = ? AND work_id = ? AND role = ? AND target_kind = ? AND target_id = ? AND ended_at IS NULL",
      owner,
      input.workId,
      input.role,
      input.targetKind,
      targetId,
    );
    if (dup) {
      return { outcome: "exists" as const, linkId: String(dup.id) };
    }
    const id = newId("wl_");
    try {
      run(
        "INSERT INTO work_links (owner_id, id, work_id, role, target_kind, target_id, task_plan_version, output_ref, original_result_id, " +
          "purpose, artifact_file_id, artifact_version_seq, link_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)",
        owner,
        id,
        input.workId,
        input.role,
        input.targetKind,
        targetId,
        input.taskPlanVersion ?? null,
        input.outputRef ?? null,
        input.originalResultId ?? null,
        input.purpose ?? null,
        input.artifactFileId ?? null,
        input.artifactVersionSeq ?? null,
        input.now,
      );
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (
        text.includes("work_links_owner_file") ||
        text.includes("work_links.owner_id, work_links.artifact_file_id")
      ) {
        return { outcome: "file_already_adopted" as const };
      }
      if (text.includes("CHECK constraint")) {
        return { outcome: "invalid" as const, code: "role_target_mismatch" };
      }
      throw error;
    }
    appendEvent(
      owner,
      input.workId,
      "link_added",
      input.actor,
      { linkId: id, role: input.role, targetKind: input.targetKind, targetId },
      input.now,
    );
    if (input.targetKind === "commitment") {
      commitmentEvents.appendEvent(
        owner,
        input.targetId,
        "linked_to_work",
        input.actor,
        { workId: input.workId, role: input.role },
        input.now,
      );
      if (input.role === "required") {
        // A new required obligation can take back a finished Work's achievement (design 5.2).
        deps.evaluateOutcomeInTx(owner, input.workId, input.now);
      }
    }
    touch(owner, input.workId, input.now);
    return { outcome: "linked" as const, linkId: id };
  };
  const workLinkAdd = (input: LinkAddInput) => transaction(() => linkAddInTx(input));

  const workLinkEnd = (input: {
    principal: Principal;
    workId: string;
    linkId: string;
    basis: string;
    actor: WorkActor;
    /** Dropping a REQUIRED Commitment can make a Work look finished; the caller must say it accepts that (design 6.6). */
    acknowledgeGap?: boolean;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const link = one(
        "SELECT id, ended_at, role, target_kind, target_id FROM work_links WHERE owner_id = ? AND work_id = ? AND id = ?",
        owner,
        input.workId,
        input.linkId,
      );
      if (!link) {
        return { outcome: "not_found" as const };
      }
      if (link.ended_at !== null) {
        return { outcome: "already_ended" as const };
      }
      const requiredCommitment =
        String(link.target_kind) === "commitment" && String(link.role) === "required";
      if (requiredCommitment && input.acknowledgeGap !== true) {
        return { outcome: "gap_ack_required" as const, commitmentId: String(link.target_id) };
      }
      // The cascade check of design 6.5 (stop the plans that only this link supports) arrives with slice W4: no plan exists yet.
      run(
        "UPDATE work_links SET ended_at = ?, end_basis = ? WHERE owner_id = ? AND id = ?",
        input.now,
        input.basis,
        owner,
        input.linkId,
      );
      appendEvent(
        owner,
        input.workId,
        "link_ended",
        input.actor,
        { linkId: input.linkId, basis: input.basis },
        input.now,
      );
      if (String(link.target_kind) === "commitment") {
        commitmentEvents.appendEvent(
          owner,
          String(link.target_id),
          "unlinked_from_work",
          input.actor,
          { workId: input.workId, role: String(link.role), basis: input.basis },
          input.now,
        );
      }
      if (requiredCommitment) {
        deps.evaluateOutcomeInTx(owner, input.workId, input.now);
      }
      touch(owner, input.workId, input.now);
      return { outcome: "ended" as const };
    });

  // ------------------------------------------------------------------ prerequisites

  const workPrereqAdd = (input: {
    principal: Principal;
    workId: string;
    kind: string;
    actor: "user" | "system";
    reason: string;
    requestText?: string | null;
    validUntil?: number | null;
    by: WorkActor;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const found = requireLive(owner, input.workId);
      if (found.problem) {
        return { outcome: "not_found" as const };
      }
      const id = newId("wp_");
      try {
        run(
          "INSERT INTO work_prerequisites (owner_id, id, work_id, work_version, kind, reason, actor, request_text, valid_until, state, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
          owner,
          id,
          input.workId,
          found.work.currentWorkVersion,
          input.kind,
          input.reason,
          input.actor,
          input.requestText ?? null,
          input.validUntil ?? null,
          input.now,
        );
      } catch (error) {
        if (error instanceof Error && error.message.includes("CHECK constraint")) {
          return { outcome: "invalid" as const, code: "bad_kind_or_actor" };
        }
        throw error;
      }
      appendEvent(
        owner,
        input.workId,
        "prerequisite_changed",
        input.by,
        { prerequisiteId: id, state: "pending", kind: input.kind },
        input.now,
      );
      touch(owner, input.workId, input.now);
      return { outcome: "added" as const, prerequisiteId: id };
    });

  const workPrereqResolve = (input: {
    principal: Principal;
    workId: string;
    prerequisiteId: string;
    state: "satisfied" | "withdrawn";
    basis: string;
    by: WorkActor;
    now: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const row = one(
        "SELECT state FROM work_prerequisites WHERE owner_id = ? AND work_id = ? AND id = ?",
        owner,
        input.workId,
        input.prerequisiteId,
      );
      if (!row) {
        return { outcome: "not_found" as const };
      }
      if (String(row.state) !== "pending") {
        return { outcome: "already_resolved" as const };
      }
      run(
        "UPDATE work_prerequisites SET state = ?, resolution_basis = ?, resolved_at = ? WHERE owner_id = ? AND id = ?",
        input.state,
        input.basis,
        input.now,
        owner,
        input.prerequisiteId,
      );
      appendEvent(
        owner,
        input.workId,
        "prerequisite_changed",
        input.by,
        { prerequisiteId: input.prerequisiteId, state: input.state },
        input.now,
      );
      touch(owner, input.workId, input.now);
      return { outcome: "resolved" as const };
    });

  // ------------------------------------------------------------------ controls, stop, partial end, reopen

  return { workLinkAdd, linkAddInTx, workLinkEnd, workPrereqAdd, workPrereqResolve };
}
