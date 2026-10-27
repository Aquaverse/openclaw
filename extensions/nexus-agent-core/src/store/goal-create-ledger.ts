import type { GoalCommon } from "./goal-ledger-common.js";
// Goals kernel, creation: the single-use creation grants the console issues, `goalCreate` (only inside such a grant) and
// `goalPropose` (the Agent on its own; lands as `proposed`). See goal-ledger.ts for the rules that hold across all goal modules.
import {
  checkFields,
  checkQuestions,
  foldText,
  GOAL_COLUMNS,
  toGoal,
  toGrant,
  type Row,
} from "./goal-rows.js";
import {
  GOAL_LIMITS,
  isOpenGoalCategory,
  type GoalCreateInput,
  type GoalCreateOutcome,
  type GoalGrantCaptureInput,
  type GoalGrantCaptureOutcome,
  type GoalGrantIssueInput,
  type GoalGrantIssueOutcome,
  type GoalGrantLookupInput,
  type GoalGrantLookupOutcome,
  type GoalProposeInput,
  type GoalProposeOutcome,
} from "./goal-types.js";

const CREATED_RETRY_WINDOW_MS = 10 * 60 * 1000;
const GRANT_KEEP_MS = 24 * 60 * 60 * 1000;
const REPLY_CHARS = 500;
export function createGoalCreation(c: GoalCommon) {
  const {
    transaction,
    one,
    run,
    newId,
    goalRow,
    mustGoal,
    activeCount,
    proposedCount,
    parentProblem,
    nextSortOrder,
    similarGoal,
    insertSystemEntry,
  } = c;

  // ------------------------------------------------------------------ creation grants

  const pruneGrants = (owner: string, now: number): void => {
    run(
      "DELETE FROM goal_creation_grants WHERE owner_id = ? AND " +
        "((consumed_at IS NULL AND expires_at < ?) OR (revoked_at IS NOT NULL AND revoked_at < ?) OR " +
        "(consumed_at IS NOT NULL AND consumed_at < ?))",
      owner,
      now - GRANT_KEEP_MS,
      now - GRANT_KEEP_MS,
      now - GRANT_KEEP_MS,
    );
  };

  const goalGrantIssue = (input: GoalGrantIssueInput): GoalGrantIssueOutcome =>
    transaction((): GoalGrantIssueOutcome => {
      const owner = input.principal.ownerId;
      if (!isOpenGoalCategory(input.category)) {
        return { outcome: "bad_category" };
      }
      if (
        typeof input.sessionKey !== "string" ||
        input.sessionKey.length === 0 ||
        input.sessionKey.length > 512
      ) {
        return { outcome: "bad_session" };
      }
      if (input.parentId !== undefined) {
        const problem = parentProblem(owner, input.parentId);
        if (problem) {
          return { outcome: "parent_invalid", reason: problem };
        }
      }
      if (activeCount(owner) >= input.maxActive) {
        return { outcome: "limit_reached", max: input.maxActive, kind: "active" };
      }
      pruneGrants(owner, input.now);
      run(
        "UPDATE goal_creation_grants SET revoked_at = ? WHERE owner_id = ? AND session_key = ? " +
          "AND consumed_at IS NULL AND revoked_at IS NULL",
        input.now,
        owner,
        input.sessionKey,
      );
      const id = newId("GG");
      run(
        "INSERT INTO goal_creation_grants (owner_id, id, session_key, category, parent_id, issued_by, expires_at, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        owner,
        id,
        input.sessionKey,
        input.category,
        input.parentId ?? null,
        input.issuedBy,
        input.now + input.ttlMs,
        input.now,
      );
      return {
        outcome: "issued",
        grant: toGrant(
          one("SELECT * FROM goal_creation_grants WHERE owner_id = ? AND id = ?", owner, id) as Row,
        ),
      };
    });

  const openGrantRow = (owner: string, sessionKey: string, now: number): Row | undefined =>
    one(
      "SELECT * FROM goal_creation_grants WHERE owner_id = ? AND session_key = ? AND consumed_at IS NULL " +
        "AND revoked_at IS NULL AND expires_at > ?",
      owner,
      sessionKey,
      now,
    );

  const goalGrantLookup = (input: GoalGrantLookupInput): GoalGrantLookupOutcome => {
    const row = openGrantRow(input.ownerId, input.sessionKey, input.now);
    return row ? { outcome: "active", grant: toGrant(row) } : { outcome: "none" };
  };

  /** Capture one typed user reply of the creation session. Keyed by message id: hooks run again on retries and compaction. */
  const goalGrantCapture = (input: GoalGrantCaptureInput): GoalGrantCaptureOutcome =>
    transaction((): GoalGrantCaptureOutcome => {
      const row = openGrantRow(input.ownerId, input.sessionKey, input.now);
      if (!row) {
        return { outcome: "none" };
      }
      const keys = JSON.parse(String(row.reply_keys_json)) as string[];
      if (keys.includes(input.messageKey)) {
        return { outcome: "duplicate" };
      }
      const replies = JSON.parse(String(row.user_replies_json)) as string[];
      const text = foldText(input.text);
      if (text === undefined) {
        return { outcome: "duplicate" };
      }
      if (replies.length >= GOAL_LIMITS.grantReplies) {
        return { outcome: "full" };
      }
      replies.push(Array.from(text).slice(0, REPLY_CHARS).join(""));
      keys.push(input.messageKey);
      run(
        "UPDATE goal_creation_grants SET user_replies_json = ?, reply_keys_json = ? WHERE owner_id = ? AND id = ?",
        JSON.stringify(replies),
        JSON.stringify(keys),
        input.ownerId,
        String(row.id),
      );
      return { outcome: "captured" };
    });

  // ------------------------------------------------------------------ create (inside a grant) and propose (Agent on its own)

  const insertGoal = (
    owner: string,
    spec: {
      id: string;
      parentId: string | null;
      category: string;
      title: string;
      userWords: string | null;
      summary: string | null;
      currentState: string | null;
      status: "active" | "proposed";
      origin: "user" | "agent";
      createdVia: "creation_chat" | "agent_proposal" | "console";
      sensitivity: string;
      idempotencyKey: string | null;
      questions: string[];
      now: number;
    },
  ): void => {
    run(
      "INSERT INTO goals (owner_id, id, parent_id, category, title, user_words, summary, current_state, status, lifecycle, " +
        "origin, created_via, sensitivity, notify_policy, sort_order, idempotency_key, questions_json, revision, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, 'off', ?, ?, ?, 1, ?, ?)",
      owner,
      spec.id,
      spec.parentId,
      spec.category,
      spec.title,
      spec.userWords,
      spec.summary,
      spec.currentState,
      spec.status,
      spec.origin,
      spec.createdVia,
      spec.sensitivity,
      nextSortOrder(owner, spec.parentId),
      spec.idempotencyKey,
      spec.questions.length > 0 ? JSON.stringify(spec.questions) : null,
      spec.now,
      spec.now,
    );
  };

  const goalCreate = (input: GoalCreateInput): GoalCreateOutcome =>
    transaction((): GoalCreateOutcome => {
      const owner = input.principal.ownerId;
      const grantRow = openGrantRow(owner, input.sessionKey, input.now);
      if (!grantRow) {
        // A retry after the grant was used: hand back the goal that grant created instead of refusing.
        const used = one(
          "SELECT goal_id FROM goal_creation_grants WHERE owner_id = ? AND session_key = ? AND consumed_at IS NOT NULL " +
            "AND consumed_at > ? ORDER BY consumed_at DESC LIMIT 1",
          owner,
          input.sessionKey,
          input.now - CREATED_RETRY_WINDOW_MS,
        );
        if (used && typeof used.goal_id === "string") {
          const existing = goalRow(owner, used.goal_id);
          if (existing) {
            return { outcome: "exists", goal: toGoal(existing) };
          }
        }
        return { outcome: "no_grant" };
      }
      const checked = checkFields(input.fields);
      if (!checked.ok) {
        return { outcome: "invalid", code: checked.code };
      }
      const category = String(grantRow.category);
      if (!isOpenGoalCategory(category)) {
        return { outcome: "invalid", code: "bad_category" };
      }
      const parentId = typeof grantRow.parent_id === "string" ? grantRow.parent_id : null;
      if (parentId !== null) {
        const problem = parentProblem(owner, parentId);
        if (problem) {
          return { outcome: "parent_invalid", reason: problem };
        }
      }
      const similar = similarGoal(owner, category, checked.value.title);
      if (similar) {
        return { outcome: "similar", goal: similar };
      }
      if (activeCount(owner) >= input.maxActive) {
        return { outcome: "limit_reached", max: input.maxActive, kind: "active" };
      }
      const replies = JSON.parse(String(grantRow.user_replies_json)) as string[];
      const userWords =
        replies.length > 0
          ? Array.from(replies.join(" / ")).slice(0, GOAL_LIMITS.userWords).join("")
          : null;
      const id = newId("GL");
      insertGoal(owner, {
        id,
        parentId,
        category,
        title: checked.value.title,
        userWords,
        summary: checked.value.summary,
        currentState: checked.value.currentState,
        status: "active",
        origin: "user",
        createdVia: "creation_chat",
        sensitivity: input.sensitivity,
        idempotencyKey: `creation:${String(grantRow.id)}`,
        questions: [],
        now: input.now,
      });
      insertSystemEntry(owner, id, checked.value.currentState ?? checked.value.title, input.now);
      run(
        "UPDATE goal_creation_grants SET consumed_at = ?, goal_id = ?, user_replies_json = '[]', reply_keys_json = '[]' " +
          "WHERE owner_id = ? AND id = ?",
        input.now,
        id,
        owner,
        String(grantRow.id),
      );
      return { outcome: "created", goal: mustGoal(owner, id) };
    });

  const goalPropose = (input: GoalProposeInput): GoalProposeOutcome =>
    transaction((): GoalProposeOutcome => {
      const owner = input.principal.ownerId;
      if (!isOpenGoalCategory(input.category)) {
        return { outcome: "invalid", code: "bad_category" };
      }
      const checked = checkFields(input.fields);
      if (!checked.ok) {
        return { outcome: "invalid", code: checked.code };
      }
      const questions = checkQuestions(input.questions);
      if (!questions.ok) {
        return { outcome: "invalid", code: questions.code };
      }
      const keyed = one(
        `SELECT ${GOAL_COLUMNS} FROM goals WHERE owner_id = ? AND idempotency_key = ?`,
        owner,
        input.idempotencyKey,
      );
      if (keyed) {
        return { outcome: "exists", goal: toGoal(keyed) };
      }
      if (input.parentId !== undefined) {
        const problem = parentProblem(owner, input.parentId);
        if (problem) {
          return { outcome: "parent_invalid", reason: problem };
        }
      }
      const similar = similarGoal(owner, input.category, checked.value.title);
      if (similar) {
        return { outcome: "similar", goal: similar };
      }
      if (proposedCount(owner) >= GOAL_LIMITS.maxProposed) {
        return { outcome: "limit_reached", max: GOAL_LIMITS.maxProposed, kind: "proposed" };
      }
      const id = newId("GL");
      insertGoal(owner, {
        id,
        parentId: input.parentId ?? null,
        category: input.category,
        title: checked.value.title,
        // The Agent can never supply the user's words: only the creation grant path captures them from the session.
        userWords: null,
        summary: checked.value.summary,
        currentState: checked.value.currentState,
        status: "proposed",
        origin: "agent",
        createdVia: "agent_proposal",
        sensitivity: input.sensitivity,
        idempotencyKey: input.idempotencyKey,
        questions: questions.value,
        now: input.now,
      });
      return { outcome: "proposed", goal: mustGoal(owner, id) };
    });

  return {
    goalGrantIssue,
    goalGrantLookup,
    goalGrantCapture,
    goalCreate,
    goalPropose,
  };
}
