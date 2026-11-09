// Work kernel: the one-off backfill of existing Tasks into Works (design 12.2), the read-only data status for the manual CLI
// (12.1) and the read-only integrity report (12.6). The backfill is idempotent and resumable: every live Task without a
// task_work_owner row gets exactly one Work with the deterministic id `w_<taskId>`, one transaction per Task, so a crash leaves
// only whole Tasks done and a re-run continues with the rest. It writes no outcome event: finished old Tasks keep
// `migrated_outcome` only (R-42 default), shown as "history, reason not recorded" and never counted as done.
import { createHash } from "node:crypto";
import type { Principal } from "./types.js";
import type { Row } from "./work-ledger-common.js";
import type { WorkLedger } from "./work-ledger.js";

export const WORKS_BACKFILL_KEY = "works_backfill_v1";
export const TRIVIAL_TASK_RULE_VERSION = 1;
const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);

/** The user-facing words of an old Task's goal: a string, or the first textual field of the goal object. */
export function goalText(goalJson: unknown, fallback: string): string {
  if (typeof goalJson !== "string") {
    return fallback;
  }
  try {
    const parsed = JSON.parse(goalJson) as unknown;
    if (typeof parsed === "string" && parsed.trim().length > 0) {
      return parsed.slice(0, 2000);
    }
    if (parsed && typeof parsed === "object") {
      for (const key of ["goal", "text", "summary", "description", "title", "objective"]) {
        const value = (parsed as Record<string, unknown>)[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.slice(0, 2000);
        }
      }
      return JSON.stringify(parsed).slice(0, 500);
    }
  } catch {
    // Not JSON: fall through to the title.
  }
  return fallback;
}

const COUNTED_TABLES = [
  "nexus_tasks",
  "works",
  "task_work_owner",
  "work_versions",
  "work_events",
  "work_links",
  "goal_work_links",
  "work_outcome_events",
  "work_terminal_events",
  "work_prerequisites",
  "work_controls",
  "context_scopes",
  "task_adoptions",
  "task_ext",
] as const;

export function createWorkBackfill(ledger: WorkLedger) {
  const { common: c, insertWork } = ledger.internals;
  const { transaction, one, all, run, appendEvent } = c;

  /** trivialTaskRule v1: hidden only when ALL hold; it never looks at titles or text (design 12.2). */
  const isTrivial = (owner: string, task: Row): boolean => {
    if (!TERMINAL.has(String(task.status))) {
      return false;
    }
    const id = String(task.id);
    const has = (sql: string): boolean => one(sql, owner, id) !== undefined;
    return !(
      has("SELECT 1 AS f FROM nexus_task_steps WHERE owner_id = ? AND task_id = ? LIMIT 1") ||
      has("SELECT 1 AS f FROM decisions WHERE owner_id = ? AND task_id = ? LIMIT 1") ||
      has("SELECT 1 AS f FROM claims WHERE owner_id = ? AND task_id = ? LIMIT 1") ||
      has("SELECT 1 AS f FROM evidence WHERE owner_id = ? AND task_id = ? LIMIT 1") ||
      has("SELECT 1 AS f FROM watches WHERE owner_id = ? AND task_id = ? LIMIT 1") ||
      has(
        "SELECT 1 AS f FROM goal_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ? LIMIT 1",
      ) ||
      has(
        "SELECT 1 AS f FROM vault_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ? LIMIT 1",
      )
    );
  };

  const pendingTasks = (owner: string, limit: number): Row[] =>
    all(
      "SELECT t.* FROM nexus_tasks t WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') " +
        "AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.owner_id = t.owner_id AND o.task_id = t.id) ORDER BY t.created_at, t.id LIMIT ?",
      owner,
      limit,
    );

  const workBackfill = (input: { principal: Principal; dryRun: boolean; now: number }) => {
    const owner = input.principal.ownerId;
    const sample = all(
      "SELECT id, status, updated_at FROM nexus_tasks WHERE owner_id = ? AND deleted_at IS NULL AND status NOT IN ('deleted','purging') ORDER BY id",
      owner,
    );
    const todo = Number(
      (
        one(
          "SELECT COUNT(*) AS c FROM nexus_tasks t WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') " +
            "AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.owner_id = t.owner_id AND o.task_id = t.id)",
          owner,
        ) as Row
      ).c,
    );
    if (input.dryRun) {
      let hidden = 0;
      let history = 0;
      let offset = 0;
      // Dry run reads in pages and writes nothing.
      for (;;) {
        const page = all(
          "SELECT t.* FROM nexus_tasks t WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') " +
            "AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.owner_id = t.owner_id AND o.task_id = t.id) ORDER BY t.created_at, t.id LIMIT 200 OFFSET ?",
          owner,
          offset,
        );
        if (page.length === 0) {
          break;
        }
        for (const task of page) {
          hidden += isTrivial(owner, task) ? 1 : 0;
          history += String(task.status) === "succeeded" ? 1 : 0;
        }
        offset += page.length;
      }
      return {
        dryRun: true as const,
        tasks: sample.length,
        toCreate: todo,
        hidden,
        historySucceeded: history,
      };
    }

    // The mapping rule version and a hash of what was read go first (R-20), once per rule version.
    const sourceHash = createHash("sha256")
      .update(
        sample
          .map((row) => `${String(row.id)}:${String(row.status)}:${Number(row.updated_at)}`)
          .join("\n"),
      )
      .digest("hex");
    transaction(() => {
      run(
        "INSERT OR IGNORE INTO migration_snapshots (owner_id, migration_key, mapping_version, source_hash, source_summary_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        owner,
        WORKS_BACKFILL_KEY,
        TRIVIAL_TASK_RULE_VERSION,
        sourceHash,
        JSON.stringify({ tasks: sample.length, toCreate: todo }),
        input.now,
      );
    });

    let created = 0;
    let hidden = 0;
    let history = 0;
    for (;;) {
      const batch = pendingTasks(owner, 100);
      if (batch.length === 0) {
        break;
      }
      for (const task of batch) {
        transaction(() => {
          const taskId = String(task.id);
          const status = String(task.status);
          const trivial = isTrivial(owner, task);
          const text = goalText(task.goal_json, String(task.title));
          const workId = insertWork(
            owner,
            {
              title: String(task.title),
              requestText: text,
              outcomeText: text,
              origin: "user",
              entryKind: "migrated",
            },
            input.now,
            {
              id: `w_${taskId}`,
              origin: "migrated",
              hidden: trivial,
              contextOrigin: "legacy_default",
              contextReview: "pending",
              migratedOutcome: TERMINAL.has(status) ? status : null,
              createdAt: Number(task.created_at),
              updatedAt: Number(task.updated_at),
            },
          );
          run(
            "INSERT INTO task_work_owner (owner_id, task_id, work_id, created_at) VALUES (?, ?, ?, ?)",
            owner,
            taskId,
            workId,
            Number(task.created_at),
          );
          const goal = one(
            "SELECT goal_id FROM goal_links WHERE owner_id = ? AND kind = 'task' AND ref_id = ?",
            owner,
            taskId,
          );
          if (goal) {
            run(
              "INSERT INTO goal_work_links (owner_id, id, goal_id, work_id, role, work_version, created_at) VALUES (?, ?, ?, ?, 'primary', 1, ?)",
              owner,
              `gw_${workId}`,
              String(goal.goal_id),
              workId,
              input.now,
            );
          }
          appendEvent(owner, workId, "created", "system", { migrated: true, taskId }, input.now);
          created += 1;
          hidden += trivial ? 1 : 0;
          history += status === "succeeded" ? 1 : 0;
        });
      }
    }
    transaction(() => {
      run(
        "INSERT INTO store_flags (owner_id, key, value, updated_at) VALUES (?, ?, '1', ?) ON CONFLICT (owner_id, key) DO UPDATE SET value = '1', updated_at = excluded.updated_at",
        owner,
        WORKS_BACKFILL_KEY,
        input.now,
      );
    });
    return {
      dryRun: false as const,
      tasks: sample.length,
      created,
      hidden,
      historySucceeded: history,
    };
  };

  /** What the manual `status` command prints: applied migrations and the size of the main tables. */
  const workDataStatus = (input: { principal: Principal }) => {
    const owner = input.principal.ownerId;
    const migrations = all("SELECT id FROM schema_migrations ORDER BY id").map((row) =>
      String(row.id),
    );
    const counts: Record<string, number> = {};
    for (const table of COUNTED_TABLES) {
      counts[table] = c.hasTable(table)
        ? Number((one(`SELECT COUNT(*) AS c FROM ${table} WHERE owner_id = ?`, owner) as Row).c)
        : -1;
    }
    const flag = c.hasTable("store_flags")
      ? one(
          "SELECT value FROM store_flags WHERE owner_id = ? AND key = ?",
          owner,
          WORKS_BACKFILL_KEY,
        )
      : undefined;
    const tasksWithoutWork = c.hasTable("task_work_owner")
      ? Number(
          (
            one(
              "SELECT COUNT(*) AS c FROM nexus_tasks t WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') " +
                "AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.owner_id = t.owner_id AND o.task_id = t.id)",
              owner,
            ) as Row
          ).c,
        )
      : -1;
    return { migrations, counts, backfillDone: flag?.value === "1", tasksWithoutWork };
  };

  type Finding = { code: string; objectKind: string; objectId: string; detail?: string };

  /** Read-only diagnostics (design 12.6). Reports, never repairs: an automatic repair would hide the writer's bug. */
  const workIntegrity = (input: { principal: Principal; now: number }) => {
    const owner = input.principal.ownerId;
    const findings: Finding[] = [];
    const add = (code: string, objectKind: string, objectId: string, detail?: string) => {
      findings.push(
        detail === undefined
          ? { code, objectKind, objectId }
          : { code, objectKind, objectId, detail },
      );
    };
    for (const row of all(
      "SELECT t.id FROM nexus_tasks t WHERE t.owner_id = ? AND t.deleted_at IS NULL AND t.status NOT IN ('deleted','purging') " +
        "AND NOT EXISTS (SELECT 1 FROM task_work_owner o WHERE o.owner_id = t.owner_id AND o.task_id = t.id)",
      owner,
    )) {
      add("task_without_work", "task", String(row.id));
    }
    // Compatibility shadow: goal_links(kind='task') must equal the owning Work's primary Goal.
    for (const row of all(
      "SELECT l.ref_id AS task_id, l.goal_id AS shadow_goal, o.work_id, " +
        "(SELECT g.goal_id FROM goal_work_links g WHERE g.owner_id = o.owner_id AND g.work_id = o.work_id AND g.role = 'primary' AND g.ended_at IS NULL) AS primary_goal " +
        "FROM goal_links l LEFT JOIN task_work_owner o ON o.owner_id = l.owner_id AND o.task_id = l.ref_id WHERE l.owner_id = ? AND l.kind = 'task'",
      owner,
    )) {
      if (row.work_id === null || row.primary_goal !== row.shadow_goal) {
        add(
          "goal_shadow_mismatch",
          "task",
          String(row.task_id),
          `shadow=${String(row.shadow_goal)} primary=${String(row.primary_goal)}`,
        );
      }
    }
    for (const row of all(
      "SELECT g.work_id, g.goal_id FROM goal_work_links g WHERE g.owner_id = ? AND g.role = 'primary' AND g.ended_at IS NULL " +
        "AND EXISTS (SELECT 1 FROM task_work_owner o WHERE o.owner_id = g.owner_id AND o.work_id = g.work_id " +
        "AND NOT EXISTS (SELECT 1 FROM goal_links l WHERE l.owner_id = o.owner_id AND l.kind = 'task' AND l.ref_id = o.task_id AND l.goal_id = g.goal_id))",
      owner,
    )) {
      add("goal_shadow_missing", "work", String(row.work_id), `goal=${String(row.goal_id)}`);
    }
    // The same target cited twice in one Work (the unique index only stops the same role twice): a commitment that is both
    // "required" and "reference" shows up as two lines. Reported with the link ids; the page's role switch merges them
    // (`nexus.commitment.setRole`); nothing is repaired here.
    for (const row of all(
      "SELECT work_id, target_kind, target_id, COUNT(*) AS n, GROUP_CONCAT(role || ':' || id, ',') AS links FROM work_links " +
        "WHERE owner_id = ? AND ended_at IS NULL AND target_kind IN ('commitment','artifact') " +
        "GROUP BY work_id, target_kind, target_id HAVING COUNT(*) > 1 ORDER BY work_id, target_kind, target_id",
      owner,
    )) {
      add(
        "duplicate_link",
        "work",
        String(row.work_id),
        `${String(row.target_kind)}:${String(row.target_id)} cited ${Number(row.n)} times (${String(row.links)})`,
      );
    }
    for (const row of all(
      "SELECT id, work_id, target_kind, target_id FROM work_links WHERE owner_id = ? AND ended_at IS NULL",
      owner,
    )) {
      const kind = String(row.target_kind);
      const target = String(row.target_id);
      let exists = true;
      if (kind === "work") {
        exists =
          one(
            "SELECT 1 AS f FROM works WHERE owner_id = ? AND id = ? AND lifecycle IN ('live','archived')",
            owner,
            target,
          ) !== undefined;
      } else if (kind === "task_output") {
        exists =
          one(
            "SELECT 1 AS f FROM nexus_tasks WHERE owner_id = ? AND id = ? AND deleted_at IS NULL",
            owner,
            target,
          ) !== undefined;
      } else if (kind === "artifact") {
        const [fileId, seq] = target.split("#");
        exists =
          one(
            "SELECT 1 AS f FROM vault_versions WHERE owner_id = ? AND file_id = ? AND seq = ?",
            owner,
            fileId ?? "",
            Number(seq),
          ) !== undefined;
      }
      if (!exists) {
        add("link_target_missing", "work_link", String(row.id), `${kind}:${target}`);
      }
    }
    for (const work of all("SELECT id, original_result_id FROM works WHERE owner_id = ?", owner)) {
      const events = all(
        "SELECT id, previous_event_id FROM work_outcome_events WHERE owner_id = ? AND work_id = ?",
        owner,
        String(work.id),
      );
      const named = new Set(
        events.map((e) => e.previous_event_id).filter((v) => typeof v === "string"),
      );
      const heads = events.filter((e) => !named.has(String(e.id)));
      if (heads.length > 1) {
        add("outcome_chain_forked", "work", String(work.id), `${heads.length} heads`);
      }
    }
    for (const row of all(
      "SELECT a.task_id, a.work_id FROM task_adoptions a JOIN works w ON w.owner_id = a.owner_id AND w.id = a.work_id " +
        "WHERE a.owner_id = ? AND a.state = 'adopted' AND a.work_version < w.current_work_version",
      owner,
    )) {
      add("adoption_behind_version", "task", String(row.task_id), `work=${String(row.work_id)}`);
    }
    for (const row of all(
      "SELECT id, state FROM window_evaluation_requests WHERE owner_id = ? AND ((state = 'pending' AND window_end_at + 60000 < ?) OR (state = 'wrapping_up' AND close_deadline_at IS NOT NULL AND close_deadline_at < ?))",
      owner,
      input.now,
      input.now,
    )) {
      add("window_evaluation_overdue", "window_evaluation", String(row.id), String(row.state));
    }
    for (const row of all(
      "SELECT p.id, p.outcome_event_id, e.event_type FROM completion_presentations p LEFT JOIN work_outcome_events e ON e.owner_id = p.owner_id AND e.id = p.outcome_event_id " +
        "WHERE p.owner_id = ? AND (e.id IS NULL)",
      owner,
    )) {
      add("presentation_without_event", "presentation", String(row.id));
    }
    return { ok: findings.length === 0, findings };
  };

  return { workBackfill, workDataStatus, workIntegrity };
}
