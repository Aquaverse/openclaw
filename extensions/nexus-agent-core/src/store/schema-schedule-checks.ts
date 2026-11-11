// Stage 7 (ninth migration): what a fired check needs after its trigger row exists (slice W4b). One check turn per fired trigger:
// pending (Task created, host turn not scheduled yet) -> scheduled (host job exists) -> claimed (the turn was authenticated as ours)
// -> reported (the turn called nexus_schedule_check_report) or failed (it ended without a report, never started, or was refused).
// Additive only. `none` is every trigger that has no check turn (skipped, merged, missed, quarantined, and rows written before W4b).
export const STAGE7_SCHEDULE_CHECKS_SQL = `
ALTER TABLE schedule_triggers ADD COLUMN turn_state TEXT NOT NULL DEFAULT 'none'
  CHECK (turn_state IN ('none','pending','scheduled','claimed','reported','failed'));
ALTER TABLE schedule_triggers ADD COLUMN turn_job_id TEXT;
ALTER TABLE schedule_triggers ADD COLUMN turn_session_key TEXT;
ALTER TABLE schedule_triggers ADD COLUMN turn_run_id TEXT;
ALTER TABLE schedule_triggers ADD COLUMN turn_changed_at INTEGER;
ALTER TABLE schedule_triggers ADD COLUMN turn_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE schedule_triggers ADD COLUMN report_json TEXT;
ALTER TABLE schedule_triggers ADD COLUMN fail_reason TEXT;
CREATE INDEX schedule_triggers_turn ON schedule_triggers(owner_id, turn_state, created_at) WHERE turn_state IN ('pending','scheduled','claimed');
CREATE UNIQUE INDEX schedule_triggers_job ON schedule_triggers(owner_id, turn_job_id) WHERE turn_job_id IS NOT NULL;
`;
