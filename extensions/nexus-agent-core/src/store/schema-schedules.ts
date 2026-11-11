// Stage 7 (eighth migration): the Schedule group, object-model design section 4.5. W4a builds the tables and the two ledgers that
// write them (delegation-ledger.ts, schedule-ledger.ts); nothing here starts a check by itself (the dispatcher is slice W4b).
// Additive only. Pointers into published tables (goals, commitments) carry no foreign key; the ledgers check them in the writing
// transaction. The design names this migration "stage7-0004"; that id was already taken by the counterpart dismissals.
export const STAGE7_SCHEDULES_SQL = `
CREATE TABLE delegation_plans (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  work_version INTEGER NOT NULL,
  plan_owner_type TEXT NOT NULL,
  plan_owner_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  plan_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  gaps_json TEXT,
  start_intent TEXT NOT NULL DEFAULT 'none',
  accepted_responsibility_version INTEGER,
  accepted_contract_version INTEGER,
  replaces_plan_id TEXT,
  handoff_from_work_id TEXT,
  handoff_tx_ref TEXT,
  end_requested_at INTEGER,
  end_reason TEXT, wrapup_until INTEGER,
  request_ref TEXT,
  confirm_receipt_json TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, accepted_at INTEGER, ended_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (plan_owner_type IN ('work','personal_goal','commitment')),
  CHECK (status IN ('draft','accepted','ended','revoked')),
  CHECK (start_intent IN ('none','when_ready','now')),
  CHECK (created_by IN ('user','agent')),
  CHECK ((status IN ('accepted','ended')) = (accepted_at IS NOT NULL)),
  CHECK ((status = 'ended') = (ended_at IS NOT NULL)),
  CHECK (plan_owner_type <> 'commitment' OR status IN ('draft','revoked') OR accepted_responsibility_version IS NOT NULL),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX plan_one_accepted_per_commitment ON delegation_plans(owner_id, plan_owner_id)
  WHERE plan_owner_type = 'commitment' AND status = 'accepted';
CREATE UNIQUE INDEX plan_request_once ON delegation_plans(owner_id, request_ref) WHERE request_ref IS NOT NULL;
CREATE INDEX plan_by_work ON delegation_plans(owner_id, work_id, status);
CREATE INDEX plan_by_owner ON delegation_plans(owner_id, plan_owner_type, plan_owner_id, status);

CREATE TABLE schedules (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  work_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_ref TEXT NOT NULL,
  plan_id TEXT, plan_version INTEGER,
  schedule_kind TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expected_evidence_json TEXT,
  cadence_json TEXT NOT NULL,
  tz TEXT NOT NULL,
  next_due_at INTEGER,
  dispatch_window_ms INTEGER,
  stop_json TEXT,
  notify_json TEXT,
  session_key TEXT,
  executor_kind TEXT NOT NULL,
  executor_ref TEXT,
  status TEXT NOT NULL,
  pause_source TEXT,
  block_reasons_json TEXT,
  last_manual_trigger_at INTEGER,
  stop_reason TEXT, ended_at INTEGER,
  coverage_state TEXT NOT NULL DEFAULT 'on_plan',
  coverage_note TEXT,
  replaces_schedule_id TEXT,
  created_via TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (owner_type IN ('personal_goal','commitment','work','legacy_watch')),
  CHECK (owner_type <> 'legacy_watch' OR created_via = 'migration'),
  CHECK (owner_type = 'legacy_watch' OR (plan_id IS NOT NULL AND plan_version IS NOT NULL)),
  CHECK (schedule_kind IN ('once','recurring')),
  CHECK (status IN ('active','paused','blocked','ended','cancelled')),
  CHECK (executor_kind IN ('watch','check_task')),
  CHECK (executor_kind <> 'watch' OR executor_ref IS NOT NULL),
  CHECK (coverage_state IN ('on_plan','degraded','unavailable')),
  CHECK ((status IN ('ended','cancelled')) = (ended_at IS NOT NULL AND stop_reason IS NOT NULL)),
  CHECK (status <> 'paused' OR pause_source IS NOT NULL),
  CHECK (pause_source IS NULL OR pause_source IN ('user','work_control','system')),
  CHECK (status <> 'blocked' OR (block_reasons_json IS NOT NULL AND json_array_length(block_reasons_json) > 0)),
  CHECK (created_via IN ('plan','migration')),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE INDEX schedules_due ON schedules(owner_id, status, next_due_at) WHERE status = 'active';
CREATE INDEX schedules_owner ON schedules(owner_id, owner_type, owner_ref);
CREATE INDEX schedules_work ON schedules(owner_id, work_id);
CREATE INDEX schedules_plan ON schedules(owner_id, plan_id);
-- a schedule's work never changes after it is created (design 4.5.2)
CREATE TRIGGER schedules_work_fixed BEFORE UPDATE OF work_id ON schedules
WHEN NEW.work_id <> OLD.work_id
BEGIN SELECT RAISE(ABORT, 'schedules.work_id is immutable'); END;
-- ended and cancelled are final: no way back to active (design 4.5.2)
CREATE TRIGGER schedules_final BEFORE UPDATE OF status ON schedules
WHEN OLD.status IN ('ended','cancelled') AND NEW.status <> OLD.status
BEGIN SELECT RAISE(ABORT, 'schedule is final'); END;

CREATE TABLE schedule_triggers (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, schedule_id TEXT NOT NULL, schedule_revision INTEGER NOT NULL,
  occurrence_key TEXT NOT NULL,
  plan_version INTEGER NOT NULL,
  source TEXT NOT NULL,
  planned_at INTEGER NOT NULL,
  outcome TEXT NOT NULL,
  skip_reason TEXT,
  merged_occurrence_keys_json TEXT,
  task_id TEXT,
  slot_open INTEGER NOT NULL DEFAULT 0,
  fired_at INTEGER,
  coverage_after TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, schedule_id, occurrence_key),
  CHECK (source IN ('scheduled','manual','catch_up')),
  CHECK (outcome IN ('created','skipped','merged','missed','quarantined')),
  CHECK (outcome <> 'created' OR task_id IS NOT NULL),
  CHECK (slot_open IN (0,1)),
  CHECK (slot_open = 0 OR outcome = 'created'),
  FOREIGN KEY (owner_id, schedule_id) REFERENCES schedules(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX schedule_slot_once ON schedule_triggers(owner_id, schedule_id) WHERE slot_open = 1;

CREATE TABLE goal_briefing_policies (
  owner_id TEXT NOT NULL, goal_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  cadence_json TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, goal_id),
  CHECK (enabled IN (0,1)),
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id)
) STRICT;
`;
