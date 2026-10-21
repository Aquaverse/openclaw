// Stage 1 migration SQL. The DDL below is the nexus-agent-core-design.md section 6.3 text for the three Stage 1 tables,
// copied verbatim apart from the comments (English here, Chinese in the doc). Tables are STRICT; none of them may be altered after release
// (DESIGN section 13, Stage 1 "first-release table scope"): later stages only add tables.
// Regression group 11 in spikes/grant-rotation-sqlite.mjs checks this file's DDL against nexus-agent-core-design.md, ignoring comments.

export type Migration = { readonly id: string; readonly sql: string };

export const STAGE1_TASK_CORE_SQL = `
CREATE TABLE nexus_tasks (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL,
  kind TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL,               -- draft|clarifying|planning|awaiting_decision|executing|watching|succeeded|failed|cancelled|deleted|purging
                                      -- v0.12f: purging is the first step of the purge protocol;
                                      -- A0 always rejects a Task in purging (§9.4)
  goal_json TEXT NOT NULL, entities_json TEXT,
  risk_ceiling TEXT NOT NULL DEFAULT 'R1',
  idempotency_key TEXT,               -- issued by the server, see §7.3
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

// Stage 2 migration SQL: actions, decisions, decision_actions, action_grants, standing_grants, action_executions,
// grant_uses (DESIGN section 6.3, from "Candidate actions" up to "Facts") followed by outbox and run_triggers (the two
// later blocks). Copied verbatim, comments included. It only ADDS tables: nothing from Stage 1 is altered.
// Regression group 11 checks this text against nexus-agent-core-design.md and stacks it on the Stage 1 migration.
export const STAGE2_DECISION_SQL = `
---------- Candidate actions: the single source of truth for parameters ----------
CREATE TABLE actions (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  tool_name TEXT NOT NULL, capability TEXT NOT NULL,
  params_canonical TEXT NOT NULL,
  action_hash TEXT NOT NULL,
  amount TEXT, currency TEXT, merchant TEXT, reversible INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, action_hash), UNIQUE (owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE
) STRICT;

---------- Human decisions ----------
CREATE TABLE decisions (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  step_id TEXT,
  decision_type TEXT NOT NULL, risk_tier TEXT NOT NULL, question TEXT NOT NULL,
  facts_snapshot TEXT NOT NULL, options_snapshot TEXT NOT NULL, unknowns_snapshot TEXT NOT NULL,
  grant_policy_snapshot TEXT NOT NULL,   -- what grant this approval will issue; goes into authority_hash
  authority_hash TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  required_decider TEXT, deadline_at INTEGER,
  -- v0.6: while awaiting a human decision it is always pending; the lifecycle is controlled only by the decision's own deadline_at.
  -- core approval being unavailable/cancelled/timed out only updates core_approval_state, never the primary status.
  status TEXT NOT NULL,   -- pending|decided|effect_apply_failed|expired|superseded
                          -- v0.12c: formerly grant_write_failed. A failure to write the preference after approving a set_preference
                          -- decision should not be described as a "grant write failure" (§8.12).
  -- Outcome and lifecycle are recorded separately (v0.5): chosen_action_id IS NULL cannot tell rejected/cancelled/timed out apart
  resolution TEXT,            -- approved|denied|cancelled|timed_out
  resolution_source TEXT,     -- core_approval|nexus_console
  resolved_by TEXT,           -- the core callback cannot obtain the reviewer identity → 'core-approval-reviewer-unavailable'
  resolved_at INTEGER,
  -- core approval is just an "attempt", not a surface mutually exclusive with the decision page (v0.5, see §8.6)
  core_approval_state TEXT NOT NULL DEFAULT 'not_attempted',
                          -- not_attempted|attempted|resolved|cancelled|timed_out
  -- v0.8: attempted is a lease, not a terminal state. The lease is taken before posting the card; a crash before returning can be taken over by the next re-entry.
  core_approval_attempt_at INTEGER,
  core_approval_attempt_by TEXT,
  -- v0.9: every claim swaps in a new token. The onResolution callback carries the token it was issued with;
  -- on mismatch the callback comes from a superseded attempt and is dropped outright; it must not overwrite state.
  core_approval_attempt_id TEXT,
  -- v0.6: the SDK does not promise toolCallId uniqueness across session/run/provider; it must be scoped
  session_key TEXT, run_id TEXT, tool_call_id TEXT,
  request_fingerprint TEXT,   -- sha256(taskId, decisionType, sorted actionIds)
  approval_ref TEXT,      -- fillable only on the nexus_console path (core does not return an approval id)
  chosen_action_id TEXT,
  -- v0.12: what approving a decision produces must be modeled explicitly. Previously resolve always took the "issue grant +
  -- pre-create execution" path, so a decision like "confirm a preference" fell into the grant-issuing path (§8.12).
  effect_kind TEXT NOT NULL,              -- issue_action_grant|issue_standing_grant|set_preference|acknowledge
  effect_payload_canonical TEXT,          -- canonical mutation of set_preference; goes into authority_hash
  UNIQUE (owner_id, task_id, id),
  -- v0.12b: put effect_kind into the unique key so the grant tables can use a composite FK to reference only "grant-type decisions".
  -- Without this key a CHECK can only constrain the decision's own row and cannot stop cross-table references (§8.12).
  UNIQUE (owner_id, task_id, id, effect_kind),
  -- v0.12d: put chosen_action_id into the unique key too. Binding only to "a member of the candidate set" is not enough: testing showed
  -- a grant can be bound to A1 while an approved decision's chosen_action_id is changed to A2,
  -- yielding "the user chose A2 but A1 was actually issued". The grant tables now reference this key directly (§8.12).
  UNIQUE (owner_id, task_id, id, chosen_action_id),
  -- v0.12e: status + resolution also go into the key. The key above did not include approval state; testing showed
  -- "pending + chosen_action_id=A1" could still issue a grant, and likewise denied / effect_apply_failed
  -- rows that keep chosen. The grant fact must be a **whole that a foreign key can reference**, not depend on the resolver's
  -- call order (§8.12). A row with resolution NULL cannot be a parent row.
  UNIQUE (owner_id, task_id, id, effect_kind, status, resolution, chosen_action_id),
  CHECK (effect_kind IN ('issue_action_grant','issue_standing_grant','set_preference','acknowledge')),
  -- only set_preference carries a payload; grant-type and acknowledge must have none
  CHECK ((effect_kind = 'set_preference') = (effect_payload_canonical IS NOT NULL)),
  -- non-grant decisions must not specify an action: they should never enter the execution path
  CHECK (effect_kind IN ('issue_action_grant','issue_standing_grant') OR chosen_action_id IS NULL),
  -- approving a grant-type decision must select an action; empty while pending is normal.
  -- v0.12c: standing needs it too: the policy must be traceable to the template action the user selected (§8.6).
  CHECK (NOT (status = 'decided' AND resolution = 'approved'
              AND effect_kind IN ('issue_action_grant','issue_standing_grant')
              AND chosen_action_id IS NULL)),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, step_id) REFERENCES nexus_task_steps(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, chosen_action_id) REFERENCES actions(owner_id, task_id, id),
  -- the selected action itself must also be a candidate (the FK is satisfied automatically when chosen_action_id is NULL).
  -- deferred: the order of "write candidate set" vs "write chosen" in the resolve transaction should not be dictated by the schema.
  FOREIGN KEY (owner_id, task_id, id, chosen_action_id)
    REFERENCES decision_actions(owner_id, task_id, decision_id, action_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX decisions_pending ON decisions(owner_id, status, deadline_at);
-- v0.8: session_key must also be IS NOT NULL. A SQLite unique index treats NULLs as mutually distinct;
-- testing showed that with session_key=NULL multiple rows can be inserted for the same (owner, run, toolCall), defeating the idempotency key.
CREATE UNIQUE INDEX decisions_toolcall
  ON decisions(owner_id, session_key, run_id, tool_call_id)
  WHERE tool_call_id IS NOT NULL AND run_id IS NOT NULL AND session_key IS NOT NULL;

-- v0.12b: a decision's candidate action set must be normalized, otherwise a grant can bind an action that is not in
-- this decision's candidates at all: authority_hash can detect that it changed, but not that it "was never in it".
-- A redundant decision_effect column + CHECK means non-grant decisions cannot even attach candidate rows.
CREATE TABLE decision_actions (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  decision_id TEXT NOT NULL, action_id TEXT NOT NULL,
  decision_effect TEXT NOT NULL,
  PRIMARY KEY (owner_id, task_id, decision_id, action_id),
  CHECK (decision_effect IN ('issue_action_grant','issue_standing_grant')),
  FOREIGN KEY (owner_id, task_id, decision_id, decision_effect)
    REFERENCES decisions(owner_id, task_id, id, effect_kind) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, action_id) REFERENCES actions(owner_id, task_id, id)
) STRICT;

---------- Grant A: one-time, bound to an action (R2/R3) ----------
CREATE TABLE action_grants (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  from_decision_id TEXT NOT NULL,
  -- v0.12b: redundant but FK-referenceable. Hard-coding it as 'issue_action_grant'
  -- makes it physically impossible for this table to reference set_preference / acknowledge decisions.
  from_decision_effect TEXT NOT NULL DEFAULT 'issue_action_grant',
  from_decision_status TEXT NOT NULL DEFAULT 'decided',
  from_decision_resolution TEXT NOT NULL DEFAULT 'approved',
  capability TEXT NOT NULL, tool_name TEXT NOT NULL,
  action_id TEXT NOT NULL, action_hash TEXT NOT NULL,
  currency TEXT, max_amount TEXT, allowed_variance_json TEXT,
  task_revision INTEGER NOT NULL, nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, consumed_by_execution TEXT, revoked_at INTEGER,
  superseded_by TEXT,                    -- issuing a new grant voids the older unconsumed grant for the same action
  UNIQUE (owner_id, task_id, id),
  UNIQUE (owner_id, task_id, action_id, id),   -- v0.6: referenced by the four-column composite FK of execution
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  CHECK (from_decision_effect = 'issue_action_grant'),
  CHECK (from_decision_status = 'decided'),
  CHECK (from_decision_resolution = 'approved'),
  -- v0.12e: one FK binds four things at once: this decision is **grant-type**, already **decided**,
  -- its outcome is **approved**, and the grant is bound to exactly the action the user **selected**.
  -- If any one fails no grant can be issued; later changes to status / resolution / chosen are blocked.
  -- (That chosen must be a candidate is guaranteed transitively by the decisions → decision_actions FK.)
  FOREIGN KEY (owner_id, task_id, from_decision_id, from_decision_effect,
               from_decision_status, from_decision_resolution, action_id)
    REFERENCES decisions(owner_id, task_id, id, effect_kind, status, resolution,
                         chosen_action_id),
  FOREIGN KEY (owner_id, task_id, action_id) REFERENCES actions(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, consumed_by_execution)
    REFERENCES action_executions(owner_id, task_id, id) DEFERRABLE INITIALLY DEFERRED,
  -- v0.6: the self-FK must be deferred, otherwise the rotation transaction is unsolvable (tested in §8.5)
  FOREIGN KEY (owner_id, task_id, superseded_by)
    REFERENCES action_grants(owner_id, task_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- at most one unconsumed, unvoided grant per action at a time
CREATE UNIQUE INDEX action_grants_live ON action_grants(owner_id, action_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL AND superseded_by IS NULL;

---------- Grant B: standing policy (R1) ----------
CREATE TABLE standing_grants (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  from_decision_id TEXT NOT NULL,
  from_decision_effect TEXT NOT NULL DEFAULT 'issue_standing_grant',
  from_decision_status TEXT NOT NULL DEFAULT 'decided',
  from_decision_resolution TEXT NOT NULL DEFAULT 'approved',
  -- v0.12c: a standing policy must be traceable to "the candidate action the user saw and selected".
  -- If only the decision's effect is checked, an approved decision whose candidate set has only A1 but chosen_action_id=A2
  -- can still issue a standing grant (accepted in testing).
  source_action_id TEXT NOT NULL,
  capability TEXT NOT NULL, tool_name TEXT,
  merchant TEXT, recipient_pattern TEXT,
  max_uses INTEGER, max_uses_per_day INTEGER,
  task_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, revoked_at INTEGER,
  UNIQUE (owner_id, task_id, id),
  CHECK (from_decision_effect = 'issue_standing_grant'),
  CHECK (from_decision_status = 'decided'),
  CHECK (from_decision_resolution = 'approved'),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  -- v0.12e: same seven-column FK as action_grants (rationale there)
  FOREIGN KEY (owner_id, task_id, from_decision_id, from_decision_effect,
               from_decision_status, from_decision_resolution, source_action_id)
    REFERENCES decisions(owner_id, task_id, id, effect_kind, status, resolution,
                         chosen_action_id)
) STRICT;

---------- Execution: local admission + result state machine (new in v0.4) ----------
-- v0.5: pre-create the row with state='prepared' **in the same transaction that issues the grant**.
-- execution_id is thus a constrained execution credential, bound to exactly one action + one grant,
-- not a string the model can pair freely. The commit tool accepts only executionId.
CREATE TABLE action_executions (
  id TEXT NOT NULL PRIMARY KEY,          -- execution_id, issued by the server
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, action_id TEXT NOT NULL,
  -- no polymorphic grant_kind+grant_id (cannot have an FK); use two columns + CHECK instead
  action_grant_id TEXT, standing_grant_id TEXT,
  provider_idempotency_key TEXT NOT NULL,      -- issued by the server, passed to the provider
  provider_idempotency_supported INTEGER NOT NULL,  -- 0/1, decides whether retry is possible, see §8.4
  state TEXT NOT NULL,                   -- prepared|executing|succeeded|failed|unknown
  provider_operation_id TEXT,
  result_canonical TEXT, result_hash TEXT, error_canonical TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_reconcile_at INTEGER,             -- reconcile time when state=unknown
  prepared_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
  CHECK ((action_grant_id IS NOT NULL AND standing_grant_id IS NULL)
      OR (action_grant_id IS NULL AND standing_grant_id IS NOT NULL)),
  UNIQUE (owner_id, provider_idempotency_key),
  UNIQUE (owner_id, task_id, id),
  -- v0.7: at most one unexecuted prepared execution per action + standing grant,
  -- otherwise repeated nexus_action_authorize calls would yield several committable credentials (§8.6)

  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, action_id) REFERENCES actions(owner_id, task_id, id),
  -- v0.6: four-column composite FK; the schema layer rules out "execution bound to action B while the grant belongs to action A"
  FOREIGN KEY (owner_id, task_id, action_id, action_grant_id)
    REFERENCES action_grants(owner_id, task_id, action_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, task_id, standing_grant_id)
    REFERENCES standing_grants(owner_id, task_id, id)
) STRICT;
-- v0.7: only one prepared execution allowed per action + standing grant,
-- otherwise repeated nexus_action_authorize calls would yield several committable credentials (§8.6)
CREATE UNIQUE INDEX action_executions_prepared
  ON action_executions(owner_id, action_id, standing_grant_id)
  WHERE state = 'prepared' AND standing_grant_id IS NOT NULL;

CREATE TABLE grant_uses (               -- each use of a standing grant
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  standing_grant_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  UNIQUE (owner_id, execution_id),
  FOREIGN KEY (owner_id, task_id, standing_grant_id)
    REFERENCES standing_grants(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, execution_id)
    REFERENCES action_executions(owner_id, task_id, id)
) STRICT;

---------- Notification outbox: written in the same transaction as the decision (new in v0.7) ----------
CREATE TABLE outbox (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  event_key TEXT NOT NULL,              -- idempotency key, e.g. decision_pending:<decisionId>
  kind TEXT NOT NULL,                   -- decision_pending|task_done|effect_apply_failed|...
  payload_canonical TEXT NOT NULL,      -- only id + summary, no sensitive content
  decision_id TEXT,
  state TEXT NOT NULL,                  -- pending|delivering|delivered|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT, claimed_at INTEGER,  -- delivery claim, prevents duplicate sends across processes
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, delivered_at INTEGER, last_error TEXT,
  UNIQUE (owner_id, event_key),         -- only one row per event
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, decision_id) REFERENCES decisions(owner_id, task_id, id)
) STRICT;
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);

---------- run trigger-source ledger: carries the prompt-stage trigger to the tool stage (new in v0.7, see §8.8) ----------
CREATE TABLE run_triggers (
  -- v0.9: the primary key is (owner_id, run_id). The host's run id is only unique within one run context;
  -- a single-column PK would keep a second owner's same-named run from being written (ON CONFLICT DO NOTHING skips silently),
  -- and the read-back would fail closed due to owner mismatch, i.e. it is blocked by someone else's run.
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  trigger TEXT NOT NULL,                -- user|cron|heartbeat
  session_key TEXT NOT NULL,            -- v0.8: must be compared on lookup, NULL not allowed
  job_id TEXT,                          -- only for cron turns
  watch_id TEXT,                        -- only for authenticated watchers
  recorded_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,          -- v0.8: explicit freshness, does not depend on GC
  PRIMARY KEY (owner_id, run_id)
) STRICT;
CREATE INDEX run_triggers_gc ON run_triggers(expires_at);
`;

// Stage 3 (slice 1) migration SQL: the claim / evidence ledger plus the two tables it must reference to have its final
// shape (evidence.blob_key -> blob_objects, blob_objects -> process_incarnations). DESIGN section 6.3, two segments copied
// verbatim: "Facts: projection + append-only events" up to (not including) blob_reservations, and "Completion criteria". It only ADDS tables.
// Blob reservations, purge runs / work items, watches, preferences and purge_receipts arrive with later migrations.
// Regression group 11 checks this text against nexus-agent-core-design.md and stacks it on the Stage 1 + Stage 2 migrations.
export const STAGE3_LEDGER_SQL = `
---------- Facts: projection + append-only events ----------
CREATE TABLE claims (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  subject TEXT NOT NULL, predicate TEXT NOT NULL, value_json TEXT,
  state TEXT NOT NULL, verification_policy TEXT,
  head_event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  -- circular reference: written in the same transaction as the first claim_event
  FOREIGN KEY (owner_id, task_id, id, head_event_id)
    REFERENCES claim_events(owner_id, task_id, claim_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE claim_events (             -- immutable history, the single source of truth
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL, seq INTEGER NOT NULL,
  transition TEXT NOT NULL, source TEXT NOT NULL, actor TEXT NOT NULL,
  payload_canonical TEXT NOT NULL, prev_digest TEXT, digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, seq),
  UNIQUE (owner_id, task_id, id),
  UNIQUE (owner_id, task_id, claim_id, id),   -- for the composite reference from claims.head_event_id
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id),   -- no cascade, see §9.4
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- evidence links become a relation table, no longer a JSON array (v0.4 fix).
-- v0.12b: a link must carry **direction** and **validity**. Previously it had only two ids, so the verification SQL counted
-- every source ever linked to the claim: evidence that was refuted, withdrawn, or superseded by a newer version counted forever,
-- and two "refuting sources" could even reach COUNT(DISTINCT source_group) >= 2 and promote the claim to VERIFIED.
-- This table is still an append-only **link event** table; the currently effective set is given by the projection table below.
CREATE TABLE claim_event_evidence (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_event_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL,              -- supports|contradicts|unclassified|detach
  relation_rule_version INTEGER NOT NULL,  -- verifier rule version used for the judgment (§9.5.5)
  relation_reason TEXT NOT NULL,       -- reason for the judgment, for audit and decision cards
  supersedes_evidence_id TEXT,         -- points to the old one when a new version of the material supersedes it
  PRIMARY KEY (claim_event_id, evidence_id),
  CHECK (relation IN ('supports','contradicts','unclassified','detach')),
  -- unclassified = the verifier cannot tell. It neither supports nor refutes and **does not** enter the projection,
  -- so it is never counted as supports (§9.5.5).
  -- detach means "cancel this link"; it brings neither support nor refutation by itself
  CHECK (relation NOT IN ('detach','unclassified') OR supersedes_evidence_id IS NULL),
  FOREIGN KEY (owner_id, task_id, claim_event_id)
    REFERENCES claim_events(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, evidence_id)
    REFERENCES evidence(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, supersedes_evidence_id)
    REFERENCES evidence(owner_id, task_id, id)
) STRICT;

-- Projection of currently effective links: the verification function reads only this table. It is updated in the same synchronous transaction as the link events,
-- so the statement "status is a function of the current effective support set, independent of arrival order" holds.
CREATE TABLE claim_evidence_links (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL,              -- supports|contradicts
  effective INTEGER NOT NULL,          -- 1=currently effective; 0=superseded by detach/supersede/withdrawal
  head_link_event_id TEXT NOT NULL,    -- points to the last link event that changed it
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, task_id, claim_id, evidence_id),
  CHECK (relation IN ('supports','contradicts')),
  CHECK (effective IN (0, 1)),
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, evidence_id)
    REFERENCES evidence(owner_id, task_id, id),
  -- v0.12c: claim_id is required. With only three columns, C1's projection could take C2's event as its last-changing event
  -- (accepted in testing), and this projection directly decides SUPPORTED/VERIFIED/REFUTED, so it was a cross-claim hole.
  FOREIGN KEY (owner_id, task_id, claim_id, head_link_event_id)
    REFERENCES claim_events(owner_id, task_id, claim_id, id)
) STRICT;
CREATE INDEX claim_evidence_links_live
  ON claim_evidence_links(owner_id, task_id, claim_id, relation)
  WHERE effective = 1;

CREATE TABLE evidence (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- v0.12g: blob_key is '<content_hash>.<generation>', bound to **that specific physical object**;
  -- set to NULL when a single evidence is deleted (§9.4); NULL satisfies the FK automatically
  blob_key TEXT, content_hash TEXT NOT NULL, byte_size INTEGER,
  -- evidence is registered by reference only; the bytes never pass through the model (§9.5)
  source_ref_kind TEXT NOT NULL,        -- tool_output|execution|blob
  source_ref_id TEXT NOT NULL,          -- toolCallId | executionId | blobKey
  -- v0.12: the VERIFIED criteria must be carried by data columns, not kept in meta_json.
  -- Both columns are derived by the server from the ref (§9.5.3); the model cannot touch them.
  -- v0.12b: identity must identify "one specific piece of material", not "an entity or a location".
  -- Using vendor+account+confirmation number or a bare URL as identity would collapse multiple receipts of one order,
  -- different points in time of one page, and different periods' statements of one account into a single row; reusing the old row loses the new content.
  source_locator_canonical TEXT NOT NULL,  -- canonicalized location: mailbox+Message-ID, canonical URL form, provider+order number
  source_version TEXT NOT NULL,            -- version identifier given by the source: Message-ID, ETag, receipt revision number;
                                           -- if the source gives no version, fixed as 'content:<content_hash>' (§9.5.3).
                                           -- Never use capture time: identical bytes at the same location would yield two identities, breaking dedup.
  source_identity_hash TEXT NOT NULL,      -- sha256(canonical({locator, version, contentHash}))
  source_run_id TEXT,                      -- required when source_ref_kind='tool_output': toolCallId is not unique across runs
  source_session_key TEXT,                 -- same as above, forms a traceable scope
  source_group TEXT NOT NULL,           -- independent source class; VERIFIED dedups and counts by it
  source_group_rule_version INTEGER NOT NULL,  -- recomputable and auditable after a rule revision
  content_classification TEXT NOT NULL DEFAULT 'personal',
  retention_policy TEXT NOT NULL, redaction_state TEXT NOT NULL DEFAULT 'raw',
  delete_requested_at INTEGER, purged_at INTEGER,
  meta_json TEXT, captured_at INTEGER NOT NULL,
  UNIQUE (owner_id, task_id, id),
  -- v0.12h: bind content_hash in as well. Checking only (owner, blob_key), the schema accepts
  -- "blob_key=A.1 but content_hash=B", detaching source identity, audit hash, and the actual bytes.
  FOREIGN KEY (owner_id, content_hash, blob_key)
    REFERENCES blob_objects(owner_id, content_hash, blob_key),
  CHECK (blob_key IS NULL OR byte_size IS NOT NULL),
  -- one row per piece of material within the same Task: otherwise registering one email twice would produce "two pieces of evidence".
  -- Note the identity includes content_hash, so "a new version at the same location" is a different row and is not reused/overwritten.
  UNIQUE (owner_id, task_id, source_identity_hash),
  -- a tool_output ref must carry run/session scope, otherwise after a restart it cannot be traced back to the original source
  CHECK (source_ref_kind <> 'tool_output'
         OR (source_run_id IS NOT NULL AND source_session_key IS NOT NULL)),
  -- The Agent's own statements are never evidence; this is enforced by the schema rather than by caller discipline
  CHECK (source_group <> '' AND source_group <> 'agent_assertion'),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id)   -- no cascade
) STRICT;

-- v0.12e: bytes that were promoted but not yet committed must have a **holder that counts toward quota**.
-- Otherwise, A2 is written to the permanent area and B fails → no evidence row → these bytes are completely invisible to the soft quota
-- that sums evidence.byte_size; consecutive failures with a stale expectedHeadEventId leak capacity steadily,
-- six entries near 100 MB hit the plugin's 512 MB hard cap, and there is no recovery path at runtime.
-- v0.12g: the physical object's lifecycle needs its own table, and the key **must not** equal the stable
-- content_hash. If the key is content-addressed, I/O outside the transaction cannot be fenced:
--   · A late return of A2's registerIfAbsent writes ownerless bytes after GC has already set abandoned;
--   · A late return of GC1's delete call deletes a same-named object that was later put back into use.
-- An attempt id can only discard a late **SQL** finalization; it cannot undo I/O already issued.
-- So the physical key carries a generation and is **never reused**: an old attempt can only touch its own generation.
-- v0.12j: authoritative record of process incarnations. v0.12i wrote "not in the live list", but nobody defined
-- that list; now it is this table. An incarnation is generated by service.start (a random id,
-- scoped to **one nexus.sqlite**); "the old incarnation no longer exists" can only be declared by the
-- new incarnation, **after holding the Gateway state directory exclusive lock**, by setting all non-terminated old rows to gone
-- in one synchronous transaction (§9.5.1). This relies on OpenClaw's single-process exclusivity
-- (gateway.state.lock in src/infra/gateway-lock.ts); it is a coupling contract, verified by Stage 0 spike 3.
CREATE TABLE process_incarnations (
  incarnation_id TEXT NOT NULL PRIMARY KEY,
  -- v0.12k: within the same Gateway process a service can be reloaded/replaced (reload in services.ts:
  -- stop with a grace period of up to 5 seconds, then start); the lock never changes hands, so the new start cannot prove the old
  -- incarnation belongs to a "process that is gone". So each row records the boot id of its process;
  -- superseded_under_gateway_lock may only replace old rows with a **different boot id**; a same-process predecessor can only
  -- write clean_shutdown itself after all its writers have truly settled.
  process_boot_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  gone_at INTEGER,
  gone_basis TEXT,                       -- clean_shutdown|superseded_under_gateway_lock
  CHECK ((gone_at IS NULL) = (gone_basis IS NULL)),
  CHECK (gone_basis IS NULL
         OR gone_basis IN ('clean_shutdown','superseded_under_gateway_lock'))
) STRICT;
-- v0.12n: there is **no** unique index for "at most one current incarnation". v0.12j–m had one,
-- at the cost that once a stale old row was left behind (crashed, can never write clean_shutdown), a new service.start could never register,
-- and the whole plugin service would not start. "No two coexisting Gateway writers on the same database" is already
-- the job of the Gateway state directory lock; it need not be implemented again in this table. A non-gone old row only means "this old incarnation's writer
-- has no quiescence basis yet"; it affects only the incarnation_gone path, not service availability (§9.5.1).
-- This table (together with blob_* / purge_*) belongs to the Stage 3 migration and must not enter any released migration
-- before Stage 0 spike 3 freezes the boot id source; the SQL in this file is only the design shape, validated by regression group 11.

CREATE TABLE blob_objects (
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,           -- n-th physical landing of the same content, monotonic
  blob_key TEXT NOT NULL,                -- '<content_hash>.<generation>', the real key in the store
  byte_size INTEGER NOT NULL,
  state TEXT NOT NULL,                   -- writing|live|reclaiming|deleted
  ref_count INTEGER NOT NULL,            -- number of live evidence rows referencing it (projection)
  -- v0.12h: writer and reclaim each have their own lease, not one ambiguous lease_until.
  -- Without a writer lease, an A2 timeout/crash leaves a writing object that can never enter reclamation:
  -- blob_objects_live_hash treats it as an undeleted generation and blocks new generations,
  -- and it also occupies the owner soft quota, while "late writes re-deleted by the tombstone" never happens.
  writer_attempt_id TEXT,                -- claimant (A2) when state='writing'
  writer_lease_until INTEGER,            -- lease for state='writing'; once expired it can be claimed for reclamation
  writer_incarnation TEXT,               -- v0.12i: process incarnation that started this writer (recorded at persist time)
  reclaim_attempt_id TEXT,               -- reclaim claimant when state='reclaiming'
  reclaim_lease_until INTEGER,           -- reclaim lease; once expired, maintenance can take over
  -- v0.12h: proof of "the bytes truly do not exist" for hard purge. Only with state='deleted' and these columns set
  -- may a success receipt be written (P5 in §9.4); otherwise purge can only return cleanup_pending.
  absence_verified_at INTEGER,
  absence_verified_attempt_id TEXT,
  -- v0.12i: the proof must bind **which** writer has gone quiet. Lease expiry only revokes database authorization,
  -- it cannot cancel a registerIfAbsent still awaiting in the same process (§9.5.1).
  -- writing → reclaiming / live both clear the writer token, so **in the same transaction** as the transition
  -- writer_attempt_id / writer_incarnation must be copied into settled_writer_*:
  --   writing → live        copy and write reason='committed' (A2 has returned, B has won)
  --   writing → reclaiming  copy, leave reason empty, write it only after quiescence is confirmed
  -- a non-empty reason means "this writer's I/O is confirmed quiet".
  settled_writer_attempt_id TEXT,
  settled_writer_incarnation TEXT,
  writer_settled_reason TEXT,            -- committed|awaited|incarnation_gone
  -- v0.12j: number of times an absence proof was invalidated. If the bytes reappear after being "confirmed missing", only
  -- absence_verified_* (the conclusion of the current check) is invalidated; settled_writer_* is **not** cleared
  -- (the writer's identity and quiescence basis are lifecycle facts, which crash recovery needs to re-issue).
  absence_invalidated_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, content_hash, generation),
  UNIQUE (owner_id, blob_key),
  -- v0.12h: for evidence's composite reference, binding the content_hash it claims to the physical object
  UNIQUE (owner_id, content_hash, blob_key),
  -- v0.12j: for purge_work_items to reference, binding the "declared (hash, generation)" to the
  -- blob_key it carries (with only the first three columns bound, a work item can declare H1.1 but carry H2.1)
  UNIQUE (owner_id, content_hash, generation, blob_key),
  FOREIGN KEY (writer_incarnation) REFERENCES process_incarnations(incarnation_id),
  FOREIGN KEY (settled_writer_incarnation) REFERENCES process_incarnations(incarnation_id),
  CHECK (absence_invalidated_count >= 0),
  CHECK (state IN ('writing','live','reclaiming','deleted')),
  CHECK (byte_size > 0),
  CHECK (ref_count >= 0),
  CHECK ((state = 'writing')
         = (writer_attempt_id IS NOT NULL AND writer_lease_until IS NOT NULL
            AND writer_incarnation IS NOT NULL)),
  CHECK ((state = 'reclaiming')
         = (reclaim_attempt_id IS NOT NULL AND reclaim_lease_until IS NOT NULL)),
  -- may enter reclaiming / deleted only when nobody references it
  CHECK (state NOT IN ('reclaiming','deleted') OR ref_count = 0),
  -- an absence proof can only appear on a tombstone
  CHECK (absence_verified_at IS NULL OR state = 'deleted'),
  CHECK ((absence_verified_at IS NULL) = (absence_verified_attempt_id IS NULL)),
  CHECK (writer_settled_reason IS NULL
         OR writer_settled_reason IN ('committed','awaited','incarnation_gone')),
  -- claiming some writer has gone quiet requires saying which writer
  CHECK (writer_settled_reason IS NULL
         OR (settled_writer_attempt_id IS NOT NULL
             AND settled_writer_incarnation IS NOT NULL)),
  -- without a record of "which writer has gone quiet", no absence proof may be issued
  CHECK (absence_verified_at IS NULL
         OR (settled_writer_attempt_id IS NOT NULL
             AND settled_writer_incarnation IS NOT NULL
             AND writer_settled_reason IS NOT NULL))
) STRICT;
-- at most one undeleted generation per content at a time: a new generation can only be created after the old one
-- enters deleted, so physical keys are never reused and late deletes cannot hurt the new object.
CREATE UNIQUE INDEX blob_objects_live_hash ON blob_objects(owner_id, content_hash)
  WHERE state IN ('writing','live','reclaiming');
-- a deleted row is a **tombstone** and cannot be dropped right away: A2's late write may recreate the bytes,
-- the maintenance scan must be able to delete again by blob_key (keys are not reused, so re-deletion is always safe)
-- tombstone scan: prioritize those that have not yet obtained an absence proof
CREATE INDEX blob_objects_tombstone ON blob_objects(owner_id, updated_at)
  WHERE state = 'deleted' AND absence_verified_at IS NULL;
-- reclaim scan: writing with an expired lease, and reclaiming with an expired lease to be taken over
CREATE INDEX blob_objects_stale_writing ON blob_objects(owner_id, writer_lease_until)
  WHERE state = 'writing';

---------- Completion criteria ----------
CREATE TABLE nexus_task_completion_claims (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  required_state TEXT NOT NULL DEFAULT 'VERIFIED',
  PRIMARY KEY (task_id, claim_id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
) STRICT;
`;

// Stage 3 (slice 2) migration SQL: blob_reservations, DESIGN section 6.3 copied verbatim (from `CREATE TABLE
// blob_reservations` through the `blob_reservations_hash_live` index). It references blob_objects (slice 1) and nexus_tasks.
// purge_runs / purge_work_items / purge_receipts are in the next migration (STAGE3_PURGE_SQL). Regression group 11 checks this text.
export const STAGE3_RESERVATIONS_SQL = `
CREATE TABLE blob_reservations (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,           -- v0.12g: bound to that specific physical object
  byte_size INTEGER NOT NULL,
  -- v0.12f: added reclaiming. GC must claim atomically before deleting bytes, otherwise phase B could consume the reservation
  -- and write evidence between "evidence check done" and "blob delete",
  -- leaving GC to delete bytes that were just referenced (TOCTOU). B can only go reserved→consumed,
  -- GC can only go reserved→reclaiming; the two are mutually exclusive and only one wins.
  state TEXT NOT NULL,                   -- reserved|reclaiming|consumed|abandoned
  reclaim_attempt_id TEXT,               -- claimant identity, used to discard late finalizing writes
  reclaim_lease_until INTEGER,           -- when the lease runs out, maintenance may take over
  expires_at INTEGER NOT NULL,           -- only a row past this and still reserved may be claimed
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, task_id, id),
  CHECK (state IN ('reserved','reclaiming','consumed','abandoned')),
  CHECK (byte_size > 0),
  CHECK ((state = 'reclaiming')
         = (reclaim_attempt_id IS NOT NULL AND reclaim_lease_until IS NOT NULL)),
  -- v0.12f: **no cascade**. The bytes in the permanent area are not in this transaction; cascading would only delete the record of
  -- "who owns these bytes" and leave ownerless bytes (tested: after DELETE nexus_tasks, two reserved rows silently vanished).
  -- No cascade → purge must settle reservations before deleting the Task, see the purge protocol in §9.4.
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id),
  FOREIGN KEY (owner_id, content_hash, generation)
    REFERENCES blob_objects(owner_id, content_hash, generation)
) STRICT;
-- quota computation and GC both scan this index: bytes in reserved and reclaiming still occupy quota
CREATE INDEX blob_reservations_live ON blob_reservations(owner_id, task_id, expires_at)
  WHERE state IN ('reserved','reclaiming');
-- v0.12f: at most one live holder at a time for the same bytes of the same owner.
-- Otherwise, when an old reservation expires and GC processes it, checking only evidence misses "another reservation
-- is using the same physical blob between A2/B" (tested: two reserved rows can coexist).
CREATE UNIQUE INDEX blob_reservations_hash_live
  ON blob_reservations(owner_id, content_hash)
  WHERE state IN ('reserved','reclaiming');
`;

// Stage 3 (slice 3) migration SQL: the purge machinery, DESIGN section 6.3 copied verbatim in two pieces (purge_runs +
// purge_work_items, then purge_receipts). purge_receipts has no foreign key to nexus_tasks on purpose (it outlives the Task),
// and it carries the preference shape too (section 11.5) because a published table cannot be altered later.
// Regression group 11 checks this text.
export const STAGE3_PURGE_SQL = `
-- v0.12j: the run owner of hard purge. v0.12i had only purge_work_items, and the P5 precondition
-- "all work items of this purge_id are terminal" holds vacuously for an empty set: a crash after P1 commits but before P3,
-- or a retry with a new purge_id (evidence.blob_key is already cleared, so the new id cannot infer the work set),
-- P5 would delete the ledger without having settled the references. So purge must have a **persistent run and phase**:
--   · a Task has exactly one purge run for life (PK = owner+task); retries **reuse the same purge_id**;
--   · worker_attempt_id is separate from the business purge_id (who is working ≠ which purge this is);
--   · workset_item_count is written when P3 commits (may be 0); P5 uses it to judge "whether the work set is truly sealed".
-- P1 sets nexus_tasks.status to purging and creates this row in the same transaction (cross-table consistency is guaranteed by the transaction).
CREATE TABLE purge_runs (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  purge_id TEXT NOT NULL,
  phase TEXT NOT NULL,                   -- sealed|reservations_settled|workset_sealed
  workset_item_count INTEGER,            -- written when P3 commits; 0 is a legal value
  workset_sealed_at INTEGER,
  worker_attempt_id TEXT, worker_lease_until INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, task_id),
  UNIQUE (owner_id, task_id, purge_id),
  CHECK (phase IN ('sealed','reservations_settled','workset_sealed')),
  CHECK ((phase = 'workset_sealed')
         = (workset_sealed_at IS NOT NULL AND workset_item_count IS NOT NULL)),
  CHECK (workset_item_count IS NULL OR workset_item_count >= 0),
  CHECK ((worker_attempt_id IS NULL) = (worker_lease_until IS NULL)),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id)
) STRICT;

-- work set of hard purge. P3 sets all of this Task's evidence.blob_key to NULL,
-- and the attach_live_object branch creates no reservation at all, so after P3 commits,
-- nothing in the database records "which physical objects this purge affected". If the process crashes right then,
-- the coordinator after restart cannot enumerate them. Work items are persisted in the same transaction as reference release.
CREATE TABLE purge_work_items (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  purge_id TEXT NOT NULL,
  content_hash TEXT NOT NULL, generation INTEGER NOT NULL,
  blob_key TEXT NOT NULL,                -- copied before P3 clears evidence.blob_key
  -- v0.12k: work items have two sources. evidence: copied by P3 from evidence.blob_key;
  -- reservation: copied by P2 from the Task's not-yet-consumed reservations: A1/A2 have already produced a
  -- physical object while phase B has not yet produced evidence; this kind of object is invisible to v0.12j's P3,
  -- and once P5 deletes the reservation, the Task's last persistent relation to it is gone.
  source_kind TEXT NOT NULL,             -- evidence|reservation
  refs_released INTEGER NOT NULL,        -- evidence source: how many references were detached; always 0 for the reservation source
  -- disposition is the conclusion of the **latest recomputation**, not a permanent classification from the time of P3:
  -- between P3 and P4 another Task can attach or release the same object, so P4 rewrites it by CAS in a synchronous transaction
  -- against the latest authoritative reference count, and only then takes the corresponding path (§9.4).
  disposition TEXT NOT NULL,             -- shared_retained|reclaim_pending
  state TEXT NOT NULL,                   -- pending|absence_verified|retained_verified|failed
  -- v0.12k: when P4 sets absence_verified it records the absence_verified_attempt_id on the object **at that time**.
  -- The terminal state is a snapshot of P4 at one moment; the proof on the object may later be invalidated (tombstone re-check in §9.5.1),
  -- P5 must compare it with the object's **current** token and not let it through if they differ.
  absence_proof_attempt_id TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, task_id, purge_id, blob_key),
  CHECK (source_kind IN ('evidence','reservation')),
  CHECK ((source_kind = 'evidence' AND refs_released > 0)
         OR (source_kind = 'reservation' AND refs_released = 0)),
  CHECK ((state = 'absence_verified') = (absence_proof_attempt_id IS NOT NULL)),
  CHECK (disposition IN ('shared_retained','reclaim_pending')),
  CHECK (state IN ('pending','absence_verified','retained_verified','failed')),
  -- the terminal state must match disposition: what stays can only be retained_verified,
  -- what is to be deleted can only be absence_verified (P5 in §9.4 judges completion by this)
  CHECK (state NOT IN ('absence_verified','retained_verified')
         OR (disposition = 'reclaim_pending') = (state = 'absence_verified')),
  FOREIGN KEY (owner_id, task_id, purge_id)
    REFERENCES purge_runs(owner_id, task_id, purge_id),
  -- four columns: (hash, generation) and blob_key must point to the **same** physical object
  FOREIGN KEY (owner_id, content_hash, generation, blob_key)
    REFERENCES blob_objects(owner_id, content_hash, generation, blob_key)
) STRICT;
CREATE INDEX purge_work_items_open
  ON purge_work_items(owner_id, task_id, purge_id)
  WHERE state IN ('pending','failed');

---------- Purge receipts: independent of the Task, purge does not delete them (new in v0.4) ----------
CREATE TABLE purge_receipts (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL,
  subject_kind TEXT NOT NULL,            -- task|preference (v0.12: preferences also have hard purge, §11.5)
  task_id TEXT,                       -- required when subject_kind='task'; deliberately no FK: the target row has been deleted
  task_title_hash TEXT,               -- hash only, no content
  preference_key_hash TEXT,           -- filled when subject_kind='preference', likewise hash only
  ledger_head_digest TEXT,               -- digest of the destroyed ledger tail
  claim_event_count INTEGER, evidence_count INTEGER, revision_count INTEGER,
  purged_scope TEXT NOT NULL,            -- ledger|evidence|all|preferences
  requested_by TEXT NOT NULL, executed_at INTEGER NOT NULL,
  CHECK (subject_kind IN ('task','preference')),
  -- v0.12b: the two shapes are mutually exclusive. Previously only "this type's fields are complete" was required, with no ban on the other type's fields coexisting,
  -- so a preference receipt could still carry a Task title hash and ledger digest, violating the minimization promise.
  CHECK (CASE subject_kind
    WHEN 'task' THEN
      task_id IS NOT NULL AND task_title_hash IS NOT NULL
      AND preference_key_hash IS NULL AND revision_count IS NULL
      AND purged_scope IN ('ledger','evidence','all')
    ELSE
      preference_key_hash IS NOT NULL AND revision_count IS NOT NULL
      AND task_id IS NULL AND task_title_hash IS NULL
      AND ledger_head_digest IS NULL
      AND claim_event_count IS NULL AND evidence_count IS NULL
      AND purged_scope = 'preferences'
  END)
) STRICT;
`;

// Stage 4 (preferences) migration SQL: preferences + preference_revisions, DESIGN section 6.3 copied verbatim (from the
// "Preferences and personal context" banner up to, not including, the "Watches" banner). It references nexus_tasks only (task_exception rows cascade
// with the Task, section 11.5); purge_receipts already carries the preference shape from stage3-0003. The watches table
// arrives with its own migration. Regression group 11 checks this text against nexus-agent-core-design.md.
export const STAGE4_PREFERENCE_SQL = `
---------- Preferences and personal context (§11)----------
CREATE TABLE preferences (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL,
  scope TEXT NOT NULL,                   -- global|domain:<name>
  key TEXT NOT NULL, value_json TEXT NOT NULL,
  origin TEXT NOT NULL,                  -- stated|observed|task_exception
  task_id TEXT,                          -- non-null only for origin='task_exception'
  asserted_by TEXT NOT NULL,             -- user|agent (combination with origin is constrained by CHECK)
  -- records the decision id when confirmed by an R0 decision. Deliberately no FK: the decisions unique key includes task_id,
  -- while a preference outlives a Task; after the Task is purged the preference must remain (same as purge_receipts, §9.4)
  decision_ref TEXT,
  confidence REAL,                       -- only for origin='observed'
  head_revision_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  deleted_at INTEGER, purged_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, id),
  CHECK (origin IN ('stated','observed','task_exception')),
  -- v0.12: the body's origin invariant must be enforced by the schema. A single store/RPC implementation bug
  -- could write "an exception for one Task" as an owner-level long-term preference, a silent privilege escalation.
  CHECK ((origin = 'task_exception') = (task_id IS NOT NULL)),
  CHECK (CASE WHEN origin = 'observed'
              THEN confidence IS NOT NULL AND confidence > 0.0 AND confidence <= 1.0
              ELSE confidence IS NULL END),
  -- v0.12b: asserted_by used to be arbitrary text; the DB accepted stated+agent and observed+user,
  -- directly overturning the source semantics of §11.2. The asserter and the origin must match.
  CHECK (asserted_by IN ('user','agent')),
  CHECK (CASE origin
    WHEN 'stated'   THEN asserted_by = 'user'
    WHEN 'observed' THEN asserted_by = 'agent'
    ELSE 1 END),                         -- task_exception allows both
  -- only stated preferences may come from a decision (set_preference in §8.12)
  CHECK (decision_ref IS NULL OR (origin = 'stated' AND asserted_by = 'user')),
  -- cascade: a task_exception only makes sense for that Task and disappears when the Task is hard purged.
  -- This is the opposite of the ledger in §9.4: the ledger does not cascade in order to leave a trace; preferences have no obligation to leave a trace,
  -- and not cascading would let one preference block purge (seen in regression group 12 testing).
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  -- circular reference: written in the same transaction as the first revision, same as claims/claim_events (§9.1)
  FOREIGN KEY (owner_id, id, head_revision_id)
    REFERENCES preference_revisions(owner_id, preference_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- the three origins can coexist under the same (scope, key); reads resolve by the priority in §11.3
CREATE UNIQUE INDEX preferences_active
  ON preferences(owner_id, scope, key, origin, COALESCE(task_id, ''))
  WHERE deleted_at IS NULL;

CREATE TABLE preference_revisions (      -- append-only; not in the claim chain, see §11.5
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, preference_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  op TEXT NOT NULL,                      -- set|supersede|delete
  value_json TEXT, origin TEXT NOT NULL, asserted_by TEXT NOT NULL,
  decision_ref TEXT, source_note TEXT,   -- observed must state its basis (which Tasks it was induced from)
  created_at INTEGER NOT NULL,
  UNIQUE (preference_id, seq),
  UNIQUE (owner_id, preference_id, id),  -- for the composite reference from preferences.head_revision_id
  CHECK (op IN ('set','supersede','delete')),
  CHECK (origin IN ('stated','observed','task_exception')),
  CHECK (asserted_by IN ('user','agent')),
  CHECK (CASE origin
    WHEN 'stated'   THEN asserted_by = 'user'
    WHEN 'observed' THEN asserted_by = 'agent'
    ELSE 1 END),
  CHECK (decision_ref IS NULL OR origin = 'stated'),
  -- observed must state its induction basis, otherwise it is indistinguishable from the model's fabrication (§11.2)
  CHECK (origin <> 'observed' OR source_note IS NOT NULL),
  FOREIGN KEY (owner_id, preference_id) REFERENCES preferences(owner_id, id)
    ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
) STRICT;
`;

// Stage 4 (second migration): the watches table, DESIGN section 6.3 copied verbatim (from `---------- Watches` up to the outbox
// block). `run_triggers.watch_id` and the outbox already exist from stage2-0001. Regression group 11 checks this text.
export const STAGE4_WATCHES_SQL = `
---------- Watches ----------
CREATE TABLE watches (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_id TEXT, expect_json TEXT NOT NULL, revision INTEGER NOT NULL,
  scheduler_job_id TEXT,
  scheduler_revision INTEGER,           -- revision written at scheduling time, compared with revision on authentication
  session_key TEXT NOT NULL, cron_tag TEXT NOT NULL,
  scheduled_for INTEGER, next_check_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL,
  status TEXT NOT NULL,   -- pending_schedule|scheduled|firing|satisfied|exhausted|cancelled
  UNIQUE (owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
) STRICT;
-- watcher authentication requires exactly one row; see §10.2
CREATE UNIQUE INDEX watches_job ON watches(owner_id, scheduler_job_id)
  WHERE scheduler_job_id IS NOT NULL;
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: "stage1-0001-task-core", sql: STAGE1_TASK_CORE_SQL },
  { id: "stage2-0001-decision-grant-execution", sql: STAGE2_DECISION_SQL },
  { id: "stage3-0001-claim-evidence-ledger", sql: STAGE3_LEDGER_SQL },
  { id: "stage3-0002-blob-reservations", sql: STAGE3_RESERVATIONS_SQL },
  { id: "stage3-0003-purge", sql: STAGE3_PURGE_SQL },
  { id: "stage4-0001-preferences", sql: STAGE4_PREFERENCE_SQL },
  { id: "stage4-0002-watches", sql: STAGE4_WATCHES_SQL },
];
