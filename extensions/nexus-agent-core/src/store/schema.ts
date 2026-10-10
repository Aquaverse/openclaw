// Stage 1 migration SQL. The DDL below is the DESIGN.md section 6.3 text for the three Stage 1 tables,
// copied verbatim (comments included). Tables are STRICT; none of them may be altered after release
// (DESIGN section 13, Stage 1 "first-release table scope"): later stages only add tables.
// Regression group 11 in spikes/grant-rotation-sqlite.mjs checks this file against DESIGN.md.

export type Migration = { readonly id: string; readonly sql: string };

export const STAGE1_TASK_CORE_SQL = `
CREATE TABLE nexus_tasks (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL,               -- draft|clarifying|planning|awaiting_decision|executing|watching|succeeded|failed|cancelled|deleted|purging
                                      -- v0.12f：purging 是 purge 协议的第一步，
                                      -- A0 一律拒绝 purging 的 Task（§9.4）
  goal_json TEXT NOT NULL, entities_json TEXT,
  risk_ceiling TEXT NOT NULL DEFAULT 'R1',
  idempotency_key TEXT,               -- 服务端签发，见 §7.3
  request_fingerprint TEXT,
  origin_session_key TEXT NOT NULL, last_session_key TEXT,
  summary TEXT, revision INTEGER NOT NULL,
  deleted_at INTEGER, purged_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER,
  UNIQUE (owner_id, id)
) STRICT;
CREATE UNIQUE INDEX nexus_tasks_idem ON nexus_tasks(owner_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX nexus_tasks_active ON nexus_tasks(owner_id, status, updated_at DESC);

CREATE TABLE nexus_task_steps (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  seq INTEGER NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
  title TEXT NOT NULL, detail_json TEXT, flow_id TEXT,
  started_at INTEGER, ended_at INTEGER,
  UNIQUE (task_id, seq), UNIQUE (owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE nexus_task_sessions (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, session_key TEXT NOT NULL,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL,
  PRIMARY KEY (task_id, session_key),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE
) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: "stage1-0001-task-core", sql: STAGE1_TASK_CORE_SQL },
];
