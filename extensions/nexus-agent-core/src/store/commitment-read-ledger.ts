// Commitment reads (object-model design 4.4, 10.2): one record with its history, the filtered list a Work page or the Agent
// searches, and the impact preview. Read-only: nothing here writes a row, so a stale caller can only see old data.
import type { CommitmentActor, CommitmentRecord } from "../commitment/types.js";
import { PARTICIPANT_COUNT, toCommitment, type CommitmentCommon } from "./commitment-common.js";
import type { TransactionRunner } from "./kernel.js";
import type { Principal } from "./types.js";
import type { Row, WorkCommon } from "./work-ledger-common.js";

export type CommitmentReadDeps = {
  transaction: TransactionRunner;
  c: WorkCommon;
  k: CommitmentCommon;
  fetch: (owner: string, id: string, now: number) => CommitmentRecord | undefined;
};

const clean = (text: unknown): string => (typeof text === "string" ? text.trim() : "");

export function createCommitmentReadOps(deps: CommitmentReadDeps) {
  const { transaction, c, k, fetch } = deps;
  const { one, all } = c;

  const commitmentGet = (input: { principal: Principal; commitmentId: string; now: number }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const commitment = fetch(owner, input.commitmentId, input.now);
      if (!commitment) {
        return { outcome: "not_found" as const };
      }
      const events = all(
        "SELECT seq, kind, actor, payload_json, created_at FROM commitment_events WHERE owner_id = ? AND commitment_id = ? ORDER BY seq DESC LIMIT 50",
        owner,
        input.commitmentId,
      ).map((row) => ({
        seq: Number(row.seq),
        kind: String(row.kind),
        actor: String(row.actor) as CommitmentActor,
        payload: JSON.parse(String(row.payload_json)) as Record<string, unknown>,
        createdAt: Number(row.created_at),
      }));
      const versions = all(
        "SELECT responsibility_version, responsible_raw, requirement_text, due_state, due_at, communication_state, acceptance_state, superseded_at, superseded_reason " +
          "FROM commitment_responsibility_versions WHERE owner_id = ? AND commitment_id = ? ORDER BY responsibility_version DESC",
        owner,
        input.commitmentId,
      ).map((row) => ({
        responsibilityVersion: Number(row.responsibility_version),
        responsibleRaw: (row.responsible_raw as string | null) ?? null,
        requirementText: String(row.requirement_text),
        dueState: String(row.due_state),
        dueAt: (row.due_at as number | null) ?? null,
        communicationState: String(row.communication_state),
        acceptanceState: String(row.acceptance_state),
        supersededAt: Number(row.superseded_at),
        supersededReason: (row.superseded_reason as string | null) ?? null,
      }));
      return {
        outcome: "ok" as const,
        commitment,
        works: k.linkedWorks(owner, input.commitmentId),
        helpers: k.helpersOf(owner, input.commitmentId),
        events,
        versions,
      };
    });

  const commitmentList = (input: {
    principal: Principal;
    now: number;
    lifecycles?: string[];
    workId?: string;
    counterpartId?: string;
    contextMode?: "personal" | "executive";
    keyword?: string;
    overdueOnly?: boolean;
    dueBefore?: number;
    order?: "due" | "recent";
    limit: number;
    offset: number;
  }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      const where: string[] = ["c.owner_id = ?"];
      const params: (string | number)[] = [owner];
      let join = "";
      if (input.workId !== undefined) {
        join =
          " JOIN work_links wl ON wl.owner_id = c.owner_id AND wl.target_kind = 'commitment' AND wl.target_id = c.id AND wl.ended_at IS NULL AND wl.work_id = ?";
        params.unshift(input.workId);
        // The join parameter comes before the WHERE parameters in the statement text.
      }
      if (input.lifecycles && input.lifecycles.length > 0) {
        where.push(`c.lifecycle IN (${input.lifecycles.map(() => "?").join(", ")})`);
        params.push(...input.lifecycles);
      }
      if (input.counterpartId !== undefined) {
        where.push("c.responsible_counterpart_id = ?");
        params.push(input.counterpartId);
      }
      if (input.contextMode) {
        where.push("c.context_mode = ?");
        params.push(input.contextMode);
      }
      const keyword = clean(input.keyword);
      if (keyword.length > 0) {
        const like = `%${keyword.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
        where.push(
          "(c.requirement_text LIKE ? ESCAPE '\\' OR c.responsible_raw LIKE ? ESCAPE '\\' OR cp.display_name LIKE ? ESCAPE '\\')",
        );
        params.push(like, like, like);
      }
      if (input.overdueOnly) {
        where.push("c.lifecycle IN ('open','waiting') AND c.due_at IS NOT NULL AND c.due_at < ?");
        params.push(input.now);
      }
      if (input.dueBefore !== undefined) {
        where.push("c.due_at IS NOT NULL AND c.due_at < ?");
        params.push(input.dueBefore);
      }
      const base =
        `FROM commitments c LEFT JOIN counterparts cp ON cp.owner_id = c.owner_id AND cp.id = c.responsible_counterpart_id` +
        `${join} WHERE ${where.join(" AND ")}`;
      const total = Number((one(`SELECT COUNT(*) AS n ${base}`, ...params) as Row).n);
      const order =
        input.order === "recent"
          ? "c.updated_at DESC, c.id"
          : "CASE c.lifecycle WHEN 'open' THEN 0 WHEN 'waiting' THEN 1 WHEN 'resolved' THEN 2 ELSE 3 END, " +
            "c.due_at IS NULL, c.due_at, c.created_at DESC, c.id";
      const rows = all(
        `SELECT c.*, cp.display_name AS responsible_name, ${PARTICIPANT_COUNT}, (oi.self_counterpart_id IS NOT NULL) AS responsible_self, ` +
          `${input.workId !== undefined ? "wl.role AS link_role, wl.id AS link_id" : "NULL AS link_role, NULL AS link_id"} ` +
          `${base.replace("WHERE", "LEFT JOIN owner_identity oi ON oi.owner_id = c.owner_id AND oi.self_counterpart_id = c.responsible_counterpart_id WHERE")} ` +
          `ORDER BY ${order} LIMIT ? OFFSET ?`,
        ...params,
        input.limit,
        input.offset,
      );
      return {
        items: rows.map((row) => ({
          commitment: toCommitment(row, input.now),
          role: (row.link_role as "required" | "reference" | null) ?? null,
          linkId: (row.link_id as string | null) ?? null,
        })),
        total,
        offset: input.offset,
      };
    });

  const commitmentImpact = (input: { principal: Principal; commitmentId: string }) =>
    transaction(() => {
      const owner = input.principal.ownerId;
      if (!k.commitmentRow(owner, input.commitmentId)) {
        return { outcome: "not_found" as const };
      }
      return { outcome: "ok" as const, impact: k.impactOf(owner, input.commitmentId) };
    });

  return { commitmentGet, commitmentList, commitmentImpact };
}
