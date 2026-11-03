// Stage 7 (first migration): the Work group, object-model design section 4.2 (plus the two bookkeeping tables of section 4.6).
// Additive only: no published table is touched. Pointers into published tables (nexus_tasks, goals via goal_links, vault files)
// carry no foreign key; the ledger checks them inside the writing transaction (design 4.1). Statuses and "implies" rules are
// CHECK constraints so they hold even if a caller forgets. The SQL is generated from the design document and then edited here:
// when the design changes before release, edit this file directly (unreleased: no repair migration, dev databases are reset).
// task_work_owner is write-once (INV-02): the triggers below reject UPDATE and DELETE unless a purge sets the release flag.
export const STAGE7_WORKS_SQL = `
CREATE TABLE works (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  title TEXT NOT NULL,
  request_text TEXT,
  outcome_text TEXT,
  original_result_id TEXT NOT NULL,
  context_mode TEXT NOT NULL,
  primary_context_id TEXT NOT NULL,
  context_semantic_version INTEGER NOT NULL DEFAULT 1,
  context_origin TEXT NOT NULL DEFAULT 'explicit',
  context_review TEXT NOT NULL DEFAULT 'none',
  entry_kind TEXT NOT NULL DEFAULT 'user_request',
  accepted_at INTEGER,
  escalation_ref TEXT,
  exclusion_reason TEXT,
  migrated_outcome TEXT,
  current_work_version INTEGER NOT NULL DEFAULT 1,
  origin TEXT NOT NULL,
  request_ref TEXT,
  lifecycle TEXT NOT NULL DEFAULT 'live',
  hidden INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  archived_at INTEGER, deleted_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (context_mode IN ('personal','executive')),
  CHECK (context_origin IN ('explicit','inherited','legacy_default')),
  CHECK (context_review IN ('none','pending','confirmed')),
  CHECK (context_origin <> 'legacy_default' OR context_review <> 'none'),
  CHECK (migrated_outcome IS NULL OR migrated_outcome IN ('succeeded','failed','cancelled')),
  CHECK (migrated_outcome IS NULL OR origin = 'migrated'),
  CHECK (origin IN ('migrated','user','agent')),
  CHECK (lifecycle IN ('live','archived','deleted','purging')),
  CHECK (hidden IN (0,1)),
  CHECK ((lifecycle = 'archived') = (archived_at IS NOT NULL) OR lifecycle IN ('deleted','purging')),
  CHECK ((lifecycle IN ('deleted','purging')) = (deleted_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX works_request ON works(owner_id, request_ref) WHERE request_ref IS NOT NULL;
CREATE INDEX works_list ON works(owner_id, lifecycle, updated_at DESC);

CREATE TABLE work_versions (
  owner_id TEXT NOT NULL, work_id TEXT NOT NULL, work_version INTEGER NOT NULL,
  context_mode TEXT NOT NULL,
  context_scope_id TEXT NOT NULL,
  context_semantic_version INTEGER NOT NULL DEFAULT 1,
  contract_version INTEGER NOT NULL,
  outcome_text TEXT,
  diff_json TEXT,
  accepted_basis TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, work_id, work_version),
  CHECK (context_mode IN ('personal','executive')),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;

CREATE TABLE task_work_owner (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, work_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, task_id),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE INDEX task_work_owner_work ON task_work_owner(owner_id, work_id);

CREATE TABLE work_links (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, work_id TEXT NOT NULL,
  role TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  task_plan_version INTEGER,
  output_ref TEXT,
  original_result_id TEXT,
  standard_scope_json TEXT,
  purpose TEXT,
  artifact_file_id TEXT,
  artifact_version_seq INTEGER,
  accept_tx_ref TEXT,
  link_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, ended_at INTEGER, end_basis TEXT,
  PRIMARY KEY (owner_id, id),
  CHECK (role IN ('required','reference','coordination','handoff_result','output_dependency')),
  CHECK (target_kind IN ('work','commitment','task_output','artifact')),
  CHECK (role NOT IN ('coordination','handoff_result') OR target_kind = 'work'),
  CHECK (role <> 'output_dependency' OR (target_kind = 'task_output' AND task_plan_version IS NOT NULL AND output_ref IS NOT NULL)),
  CHECK (role NOT IN ('required','reference') OR target_kind IN ('commitment','artifact')),
  CHECK (role <> 'handoff_result' OR original_result_id IS NOT NULL),
  CHECK (target_kind <> 'work' OR target_id <> work_id),
  CHECK (target_kind <> 'artifact' OR (artifact_file_id IS NOT NULL AND artifact_version_seq IS NOT NULL)),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX work_links_owner_file ON work_links(owner_id, artifact_file_id)
  WHERE target_kind = 'artifact' AND role = 'required' AND purpose = 'adopted_deliverable' AND ended_at IS NULL;
CREATE UNIQUE INDEX work_links_pair ON work_links(owner_id, work_id, role, target_kind, target_id) WHERE ended_at IS NULL;
CREATE INDEX work_links_target ON work_links(owner_id, target_kind, target_id) WHERE ended_at IS NULL;

CREATE TABLE goal_work_links (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, goal_id TEXT NOT NULL, work_id TEXT NOT NULL,
  role TEXT NOT NULL,
  work_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL, ended_at INTEGER, end_basis TEXT,
  PRIMARY KEY (owner_id, id),
  CHECK (role IN ('primary','reference')),
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX goal_work_primary_once ON goal_work_links(owner_id, work_id) WHERE role = 'primary' AND ended_at IS NULL;
CREATE UNIQUE INDEX goal_work_pair ON goal_work_links(owner_id, goal_id, work_id) WHERE ended_at IS NULL;

CREATE TABLE work_events (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, work_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, work_id, seq),
  CHECK (actor IN ('user','agent','system')),
  CHECK (kind IN (
    'created','retitled','outcome_changed','version_changed','goal_set','goal_cleared',
    'link_added','link_ended','archived','unarchived','deleted',
    'control_applied','control_released',
    'outcome_recorded',
    'terminal_recorded',
    'prerequisite_changed',
    'handoff_out','handoff_in',
    'merged_into','split_from',
    'incident_reported','incident_closed'))
  , FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;

CREATE TABLE work_lineage (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  from_work_id TEXT NOT NULL, to_work_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  original_result_id TEXT NOT NULL,
  carried_in_usage_json TEXT,
  reason TEXT, created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (kind IN ('merge','split','alias','handoff')), CHECK (from_work_id <> to_work_id)
) STRICT;

CREATE TABLE work_outcome_events (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  work_id TEXT NOT NULL, original_result_id TEXT NOT NULL,
  work_version INTEGER NOT NULL, contract_version INTEGER NOT NULL, scope_ref TEXT,
  event_type TEXT NOT NULL,
  basis TEXT NOT NULL,
  provenance TEXT NOT NULL DEFAULT 'live',
  assessment_refs_json TEXT NOT NULL,
  previous_event_id TEXT,
  reason TEXT, recorded_at INTEGER NOT NULL,
  business_fulfilled_at INTEGER,
  notify_key TEXT, outbox_ref TEXT,
  stat_correction_ref TEXT,
  PRIMARY KEY (owner_id, id),
  CHECK (event_type IN ('achieved','withdrawn','reinstated','superseded')),
  CHECK (basis IN ('source_verified','user_report','mixed')),
  CHECK (provenance IN ('live','legacy_backfill')),
  CHECK (previous_event_id IS NOT NULL OR event_type = 'achieved'),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX work_outcome_chain ON work_outcome_events(owner_id, work_id, original_result_id, COALESCE(previous_event_id,''));
CREATE UNIQUE INDEX work_outcome_notify ON work_outcome_events(owner_id, notify_key) WHERE notify_key IS NOT NULL;

CREATE TABLE work_terminal_events (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, work_id TEXT NOT NULL,
  work_version INTEGER NOT NULL, contract_version INTEGER NOT NULL,
  criteria_snapshot_json TEXT NOT NULL,
  evidence_snapshot_json TEXT NOT NULL,
  result_at_close TEXT NOT NULL,
  reason TEXT NOT NULL,
  decision_ref TEXT,
  stop_scope_json TEXT,
  inherit_scope_json TEXT,
  recorded_at INTEGER NOT NULL,
  window_evaluation_id TEXT,
  close_deadline_at INTEGER,
  reopened_at INTEGER, reopen_basis TEXT, new_boundary_id TEXT,
  PRIMARY KEY (owner_id, id),
  CHECK (result_at_close IN ('met_all','partial','not_met','stopped_before_completion','unknown')),
  CHECK (reason IN ('stop','accept_partial','window_ended','unrecoverable')),
  CHECK (reason NOT IN ('stop','accept_partial') OR decision_ref IS NOT NULL),
  CHECK (reason <> 'window_ended' OR window_evaluation_id IS NOT NULL),
  CHECK ((reopened_at IS NULL) = (reopen_basis IS NULL)),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE INDEX work_terminal_open ON work_terminal_events(owner_id, work_id) WHERE reopened_at IS NULL;

CREATE TABLE work_prerequisites (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, work_id TEXT NOT NULL, work_version INTEGER NOT NULL,
  kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  actor TEXT NOT NULL,
  request_text TEXT,
  valid_until INTEGER,
  state TEXT NOT NULL DEFAULT 'pending',
  resolution_basis TEXT, resolved_at INTEGER,
  first_plan_request_id TEXT, queue_ref TEXT, lease_until INTEGER, window_json TEXT, budget_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (kind IN ('input','result_confirmation','system','permission','source','reconnect_source')),
  CHECK (actor IN ('user','system')),
  CHECK (state IN ('pending','satisfied','withdrawn')),
  CHECK ((state = 'pending') = (resolved_at IS NULL)),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE INDEX work_prereq_open ON work_prerequisites(owner_id, work_id) WHERE state = 'pending';

CREATE TABLE work_controls (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, work_id TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_id TEXT,
  state TEXT NOT NULL,
  reason TEXT, initiated_by TEXT NOT NULL,
  reconcile_only INTEGER NOT NULL DEFAULT 0,
  control_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, released_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (scope_kind IN ('work','task','run','schedule')),
  CHECK (state IN ('pause_requested','paused','released')),
  CHECK (reconcile_only IN (0,1)),
  CHECK ((scope_kind = 'work') = (scope_id IS NULL)),
  CHECK ((state = 'released') = (released_at IS NOT NULL)),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX work_controls_open ON work_controls(owner_id, work_id, scope_kind, COALESCE(scope_id,''), COALESCE(reason,''))
  WHERE state <> 'released';

CREATE TABLE task_ext (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  end_kind TEXT,
  end_reason TEXT, ended_by TEXT,
  blocked_reason TEXT, blocked_since INTEGER,
  supersedes_task_id TEXT,
  revision INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, task_id),
  CHECK (end_kind IS NULL OR end_kind = 'partial')
) STRICT;

CREATE TABLE context_scopes (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  context_mode TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  parent_scope_id TEXT,
  label TEXT NOT NULL,
  semantic_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (context_mode IN ('personal','executive')),
  CHECK (scope_kind IN ('mode','project','client')),
  CHECK ((scope_kind = 'mode') = (parent_scope_id IS NULL)),
  CHECK (status IN ('active','archived')),
  CHECK ((status = 'archived') = (archived_at IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX context_scope_root ON context_scopes(owner_id, context_mode) WHERE scope_kind = 'mode';

CREATE TABLE task_adoptions (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  work_id TEXT NOT NULL, work_version INTEGER NOT NULL, contract_version INTEGER NOT NULL,
  task_id TEXT NOT NULL,
  predecessor_task_id TEXT,
  snapshot_hash TEXT NOT NULL,
  dependency_versions_json TEXT NOT NULL,
  accept_request_id TEXT, accepted_at INTEGER,
  isolation_generation INTEGER NOT NULL,
  adoption_check TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, task_id),
  CHECK (adoption_check IN ('passed','failed','stale')),
  CHECK (state IN ('pending','adopted','quarantined','superseded')),
  CHECK (state <> 'adopted' OR (accept_request_id IS NOT NULL AND accepted_at IS NOT NULL AND adoption_check = 'passed')),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE INDEX task_adoptions_work ON task_adoptions(owner_id, work_id, work_version);

CREATE TABLE completion_presentations (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  outcome_event_id TEXT NOT NULL, work_version INTEGER NOT NULL, contract_version INTEGER NOT NULL,
  presentation_kind TEXT NOT NULL,
  channel TEXT, channel_message_id TEXT, outbox_ref TEXT,
  delivery_state TEXT NOT NULL,
  occurred_at INTEGER NOT NULL,
  dedupe_key TEXT NOT NULL,
  correction_state TEXT NOT NULL DEFAULT 'none',
  correction_outbox_ref TEXT,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, dedupe_key),
  CHECK (presentation_kind IN ('channel_submitted','chat_published')),
  CHECK (delivery_state IN ('submitted','delivered','failed','unknown')),
  CHECK (correction_state IN ('none','required','sent','retrying'))
) STRICT;

CREATE TABLE window_evaluation_requests (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  job_type TEXT NOT NULL DEFAULT 'window_evaluation',
  work_id TEXT NOT NULL, contract_version INTEGER NOT NULL,
  window_end_at INTEGER NOT NULL, window_tz TEXT NOT NULL,
  state TEXT NOT NULL,
  attempt_id TEXT, attempts INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER, close_deadline_at INTEGER,
  result TEXT,
  outcome_event_id TEXT, terminal_event_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, work_id, contract_version, window_end_at),
  CHECK (job_type = 'window_evaluation'),
  CHECK (state IN ('pending','wrapping_up','done','superseded','failed')),
  CHECK (result IS NULL OR result IN ('achieved','window_ended','superseded_noop')),
  CHECK (NOT (outcome_event_id IS NOT NULL AND terminal_event_id IS NOT NULL)),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id)
) STRICT;
CREATE INDEX window_eval_due ON window_evaluation_requests(owner_id, state, window_end_at) WHERE state IN ('pending','wrapping_up');

CREATE TABLE store_flags (
  owner_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, key)
) STRICT;

CREATE TABLE migration_snapshots (
  owner_id TEXT NOT NULL, migration_key TEXT NOT NULL,
  mapping_version INTEGER NOT NULL,
  source_hash TEXT NOT NULL,
  source_summary_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, migration_key, mapping_version)
) STRICT;

CREATE TRIGGER task_work_owner_no_update BEFORE UPDATE ON task_work_owner
BEGIN SELECT RAISE(ABORT, 'INV-02 task owner immutable'); END;

CREATE TRIGGER task_work_owner_no_delete BEFORE DELETE ON task_work_owner
WHEN NOT EXISTS (
  SELECT 1 FROM store_flags WHERE owner_id = OLD.owner_id AND key = 'purge_task_owner_release' AND value = '1'
)
BEGIN SELECT RAISE(ABORT, 'INV-02 task owner immutable'); END;
`;
