// Stage 7 (third migration): the Commitment group, object-model design section 4.4. W2 builds every table; the ledger
// (commitment-ledger.ts) writes the commitment, responsibility version and event rows and the manual lifecycle paths. The
// verification engine (assessments, evidence attributions, source_verified resolution) is wired in a later slice.
// origin_* columns are write-once (INV-27): the trigger at the end rejects any UPDATE that changes them.
export const STAGE7_COMMITMENTS_SQL = `
CREATE TABLE commitments (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  requirement_text TEXT NOT NULL,
  responsible_counterpart_id TEXT,
  responsible_raw TEXT,
  mapping_ref_json TEXT,
  ambiguity_json TEXT,
  responsibility_version INTEGER NOT NULL DEFAULT 1,
  context_mode TEXT NOT NULL,
  context_scope_id TEXT NOT NULL,
  context_semantic_version INTEGER NOT NULL DEFAULT 1,
  period_request_id TEXT, period_key TEXT, period_index INTEGER,
  period_start INTEGER, period_end INTEGER, period_tz TEXT,
  origin_kind TEXT NOT NULL,
  origin_ref_id TEXT NOT NULL,
  origin_source_json TEXT,
  decision_ref TEXT,
  due_state TEXT NOT NULL,
  due_at INTEGER, due_tz TEXT,
  depends_json TEXT,
  standard_json TEXT,
  contract_version INTEGER NOT NULL DEFAULT 1,

  communication_state TEXT NOT NULL DEFAULT 'draft',
  communication_action_ref TEXT,
  communication_receipt_level TEXT,
  communication_at INTEGER,
  acceptance_state TEXT NOT NULL DEFAULT 'unknown',
  acceptance_basis_kind TEXT,
  acceptance_basis TEXT,
  acceptance_at INTEGER,
  lifecycle TEXT NOT NULL DEFAULT 'open',
  verification TEXT NOT NULL DEFAULT 'unverified',
  current_assessment_id TEXT,
  verification_commit_version INTEGER NOT NULL DEFAULT 0,
  resolution_basis TEXT,
  resolution_reason TEXT, resolved_at INTEGER,
  cancel_reason TEXT, cancelled_at INTEGER,
  next_step TEXT, escalation_json TEXT,
  created_by TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (responsible_counterpart_id IS NOT NULL OR responsible_raw IS NOT NULL),
  CHECK (context_mode IN ('personal','executive')),
  CHECK (origin_kind IN ('task_run','system_job_run','native_record')),
  CHECK (due_state IN ('known','pending','none')),
  CHECK ((period_key IS NULL) = (period_request_id IS NULL)),
  CHECK (period_key IS NULL OR (period_index BETWEEN 1 AND 12 AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_tz IS NOT NULL)),
  CHECK ((due_state = 'known') = (due_at IS NOT NULL AND due_tz IS NOT NULL)),
  CHECK (communication_state IN ('draft','submitted','confirmed','unknown','failed')),
  CHECK (acceptance_state IN ('unknown','accepted','declined','needs_clarification')),
  CHECK (acceptance_state <> 'accepted' OR (acceptance_basis_kind IS NOT NULL AND acceptance_basis IS NOT NULL AND acceptance_at IS NOT NULL)),
  CHECK (acceptance_basis_kind IS NULL OR acceptance_basis_kind IN ('counterpart_source','user_report')),
  CHECK (lifecycle IN ('open','waiting','resolved','cancelled')),
  CHECK (verification IN ('unverified','verified_complete','verified_exception','conflicting_evidence')),
  CHECK (resolution_basis IS NULL OR resolution_basis IN ('source_verified','manual_override')),
  CHECK ((lifecycle = 'resolved') = (resolution_basis IS NOT NULL AND resolved_at IS NOT NULL)),

  CHECK (resolution_basis IS NOT 'source_verified' OR (verification = 'verified_complete' AND current_assessment_id IS NOT NULL)),
  CHECK (verification <> 'verified_complete' OR current_assessment_id IS NOT NULL),
  CHECK (resolution_basis IS NOT 'manual_override' OR resolution_reason IS NOT NULL),
  CHECK ((lifecycle = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK (created_by IN ('user','agent','review_batch')),
  FOREIGN KEY (owner_id, responsible_counterpart_id) REFERENCES counterparts(owner_id, id)
) STRICT;
CREATE INDEX commitments_cp ON commitments(owner_id, responsible_counterpart_id, lifecycle) WHERE responsible_counterpart_id IS NOT NULL;
CREATE INDEX commitments_unresolved ON commitments(owner_id, responsible_raw) WHERE responsible_counterpart_id IS NULL;
CREATE INDEX commitments_due ON commitments(owner_id, lifecycle, due_at);
CREATE UNIQUE INDEX commitments_period ON commitments(owner_id, period_request_id, period_key) WHERE period_key IS NOT NULL;

CREATE TABLE commitment_responsibility_versions (
  owner_id TEXT NOT NULL, commitment_id TEXT NOT NULL, responsibility_version INTEGER NOT NULL,
  responsible_counterpart_id TEXT, responsible_raw TEXT,
  requirement_text TEXT NOT NULL, due_state TEXT NOT NULL, due_at INTEGER, due_tz TEXT, contract_version INTEGER NOT NULL,
  communication_state TEXT NOT NULL, communication_action_ref TEXT, acceptance_state TEXT NOT NULL, acceptance_basis TEXT,
  superseded_at INTEGER NOT NULL, superseded_reason TEXT,
  PRIMARY KEY (owner_id, commitment_id, responsibility_version),
  FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id)
) STRICT;
CREATE TABLE commitment_events (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, commitment_id TEXT NOT NULL, seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, commitment_id, seq),
  CHECK (actor IN ('user','agent','system','engine')),
  CHECK (kind IN ('created','edited','responsible_resolved','responsible_changed','due_changed','standard_changed',
    'responsibility_versioned','communication_changed','acceptance_changed','lifecycle_changed','verification_changed',
    'assessment_committed',
    'resolved_source_verified','resolved_manual','cancelled','reopened',
    'evidence_attached','evidence_reassessed','linked_to_work','unlinked_from_work',
    'follow_up_started','follow_up_stopped')),
  FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id)
) STRICT;
CREATE TABLE outcome_contract_versions (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,
  subject_id TEXT NOT NULL, version INTEGER NOT NULL,
  template_id TEXT NOT NULL,
  template_version INTEGER NOT NULL,
  params_json TEXT NOT NULL,
  criteria_json TEXT NOT NULL,
  window_end_at INTEGER, window_tz TEXT,
  window_policy TEXT NOT NULL DEFAULT 'none',
  accepted_basis_policy TEXT NOT NULL DEFAULT 'source_only',
  provenance TEXT NOT NULL,
  accepted_by_user INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, superseded_at INTEGER,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, subject_kind, subject_id, version),
  CHECK (subject_kind IN ('work','task','commitment')),
  CHECK (provenance IN ('user','agent_proposed','template_default','migration')),
  CHECK (template_id IN ('meeting_arranged','requested_delivery_received','usable_file_delivered','user_confirmed_delivery','reservation_confirmed','approval_or_signature_obtained') OR (template_id = 'legacy_task_success' AND provenance = 'migration')),
  CHECK (window_policy IN ('none','remind_only','end_at_window')),
  CHECK ((window_policy = 'none') = (window_end_at IS NULL)),
  CHECK (window_end_at IS NULL OR window_tz IS NOT NULL),
  CHECK (accepted_basis_policy IN ('source_only','user_report_allowed')),
  CHECK (accepted_by_user IN (0,1))
) STRICT;

CREATE TABLE commitment_assessments (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, commitment_id TEXT NOT NULL,
  assessment_version INTEGER NOT NULL,
  responsibility_version INTEGER NOT NULL,
  contract_version INTEGER NOT NULL,
  evidence_set_hash TEXT NOT NULL,
  overall TEXT NOT NULL,
  assessed_at INTEGER NOT NULL, superseded_at INTEGER,
  PRIMARY KEY (owner_id, id), UNIQUE (owner_id, commitment_id, assessment_version),
  CHECK (overall IN ('met','not_met','insufficient_evidence','conflicting_evidence')),
  FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX commitment_assessment_current ON commitment_assessments(owner_id, commitment_id) WHERE superseded_at IS NULL;

CREATE TABLE criterion_assessments (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  contract_id TEXT NOT NULL, criterion_id TEXT NOT NULL,
  assessment_id TEXT,
  verdict TEXT NOT NULL,
  attribution_ids_json TEXT,
  assessor TEXT NOT NULL,
  limits_text TEXT,
  user_override INTEGER NOT NULL DEFAULT 0,
  override_reason TEXT,
  assessed_at INTEGER NOT NULL, superseded_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (verdict IN ('met','not_met','insufficient_evidence','conflicting_evidence')),
  CHECK (assessor IN ('engine','user','agent_proposal')),
  CHECK (user_override = 0 OR override_reason IS NOT NULL),
  CHECK (assessor <> 'agent_proposal' OR verdict <> 'met' OR attribution_ids_json IS NOT NULL),
  FOREIGN KEY (owner_id, contract_id) REFERENCES outcome_contract_versions(owner_id, id)
) STRICT;
CREATE INDEX criterion_assessments_cur ON criterion_assessments(owner_id, contract_id, criterion_id) WHERE superseded_at IS NULL;
CREATE TABLE evidence_attributions (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, commitment_id TEXT NOT NULL,
  evidence_kind TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  external_record_id TEXT,
  endpoint_id TEXT,
  actor_role TEXT NOT NULL,
  submitted_by_counterpart TEXT,
  event_at INTEGER NOT NULL,
  mapping_refs_json TEXT,
  identity_verdict TEXT NOT NULL,
  relevance_verdict TEXT NOT NULL,
  content_summary_json TEXT,
  authenticity_limits TEXT,
  assessed_at INTEGER NOT NULL, superseded_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (evidence_kind IN ('nexus_evidence','vault_file','external_record')),
  CHECK (actor_role IN ('submitter','author','forwarded_mention','signature_mention','user_declared')),
  CHECK (identity_verdict IN ('matched','unmatched','ambiguous','unknown','user_declared')),
  CHECK (relevance_verdict IN ('relevant','irrelevant','unknown')),

  CHECK (actor_role NOT IN ('forwarded_mention','signature_mention') OR identity_verdict IN ('unmatched','unknown')),
  FOREIGN KEY (owner_id, commitment_id) REFERENCES commitments(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX attributions_once ON evidence_attributions(owner_id, commitment_id, evidence_kind, evidence_ref)
  WHERE superseded_at IS NULL;

CREATE TRIGGER commitments_origin_immutable BEFORE UPDATE ON commitments
WHEN NEW.origin_kind IS NOT OLD.origin_kind OR NEW.origin_ref_id IS NOT OLD.origin_ref_id OR NEW.origin_source_json IS NOT OLD.origin_source_json
BEGIN SELECT RAISE(ABORT, 'INV-27 commitment origin immutable'); END;
`;
