// Stage 7 (second migration): the Counterpart group, object-model design section 4.3. W2 creates the tables and writes only the
// owner's self identity row (INV-01); naming, relations, endpoints and identity links are business logic of slice W3.
// Additive only. Pointers into published tables carry no foreign key; the ledger checks them in the writing transaction.
// When the design changes before release, edit this file directly (unreleased: no repair migration, dev databases are reset).
export const STAGE7_COUNTERPARTS_SQL = `
CREATE TABLE counterparts (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  kind TEXT NOT NULL,
  display_name TEXT NOT NULL,
  confirmation TEXT NOT NULL,
  origin TEXT NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'live',
  inactive_reason TEXT,
  merged_into TEXT,
  merge_tx_id TEXT,
  context_json TEXT,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, inactive_at INTEGER, merged_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (kind IN ('person','organization','team')),
  CHECK (confirmation IN ('stated','confirmed','proposed')),
  CHECK (origin IN ('user','agent','review_batch','system')),
  CHECK (lifecycle IN ('live','inactive','merged','deleted')),
  CHECK ((lifecycle = 'inactive') = (inactive_at IS NOT NULL AND inactive_reason IS NOT NULL)),
  CHECK ((lifecycle = 'merged') = (merged_into IS NOT NULL AND merged_at IS NOT NULL)),
  CHECK (origin <> 'agent' OR confirmation <> 'confirmed')
) STRICT;
CREATE INDEX counterparts_list ON counterparts(owner_id, lifecycle, display_name);

CREATE TABLE owner_identity (
  owner_id TEXT NOT NULL PRIMARY KEY,
  self_counterpart_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (owner_id, self_counterpart_id) REFERENCES counterparts(owner_id, id)
) STRICT;
CREATE TABLE counterpart_names (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, counterpart_id TEXT NOT NULL,
  name TEXT NOT NULL, name_kind TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (name_kind IN ('display','alias','raw_mention')),
  FOREIGN KEY (owner_id, counterpart_id) REFERENCES counterparts(owner_id, id)
) STRICT;
CREATE INDEX counterpart_names_lookup ON counterpart_names(owner_id, name) WHERE revoked_at IS NULL;

CREATE TABLE counterpart_relations (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, counterpart_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  scope_label TEXT,
  basis_text TEXT NOT NULL,
  status TEXT NOT NULL,
  valid_from INTEGER, valid_to INTEGER,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (relation IN ('direct_report','colleague','client','supplier','other')),
  CHECK (status IN ('stated','revoked')),
  FOREIGN KEY (owner_id, counterpart_id) REFERENCES counterparts(owner_id, id)
) STRICT;

CREATE TABLE work_participant_links (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, work_id TEXT NOT NULL, counterpart_id TEXT NOT NULL,
  role TEXT NOT NULL,
  work_version INTEGER NOT NULL,
  purpose TEXT, basis_text TEXT NOT NULL,
  status TEXT NOT NULL,
  valid_from INTEGER, valid_to INTEGER, created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (role IN ('coordinator','participant','approver','recipient')),
  CHECK (status IN ('stated','confirmed','revoked')),
  FOREIGN KEY (owner_id, work_id) REFERENCES works(owner_id, id),
  FOREIGN KEY (owner_id, counterpart_id) REFERENCES counterparts(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX work_participant_once ON work_participant_links(owner_id, work_id, counterpart_id, role) WHERE status <> 'revoked';

CREATE TABLE commitment_participant_links (
  owner_id TEXT NOT NULL, id TEXT NOT NULL, commitment_id TEXT NOT NULL, counterpart_id TEXT NOT NULL,
  role TEXT NOT NULL,
  responsibility_version INTEGER NOT NULL,
  purpose TEXT, basis_text TEXT NOT NULL,
  status TEXT NOT NULL,
  valid_from INTEGER, valid_to INTEGER, created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (owner_id, id),
  CHECK (role IN ('participant','approver','recipient')),
  CHECK (status IN ('stated','confirmed','revoked')),
  FOREIGN KEY (owner_id, counterpart_id) REFERENCES counterparts(owner_id, id)
) STRICT;
CREATE UNIQUE INDEX commitment_participant_once ON commitment_participant_links(owner_id, commitment_id, counterpart_id, role) WHERE status <> 'revoked';
CREATE TABLE counterpart_endpoints (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  endpoint_type TEXT NOT NULL,
  provider TEXT NOT NULL,
  connector_account TEXT,
  workspace TEXT,
  provider_subject_id TEXT,
  handle TEXT,
  id_strength TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  visible_scope_ids_json TEXT NOT NULL DEFAULT '[]', scope_set_version INTEGER NOT NULL DEFAULT 1,
  valid_from INTEGER, valid_to INTEGER,
  source_ref TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (endpoint_type IN ('email','shared_mailbox','calendar','doc_account','im','telegram_user','whatsapp_jid','phone','manual','other')),
  CHECK (id_strength IN ('strong','weak')),
  CHECK (id_strength = 'weak' OR provider_subject_id IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX endpoints_subject ON counterpart_endpoints
  (owner_id, provider, COALESCE(connector_account,''), COALESCE(workspace,''), provider_subject_id)
  WHERE provider_subject_id IS NOT NULL;
CREATE INDEX endpoints_handle ON counterpart_endpoints(owner_id, provider, handle) WHERE handle IS NOT NULL;
CREATE TABLE identity_links (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  counterpart_id TEXT NOT NULL, endpoint_id TEXT NOT NULL,
  status TEXT NOT NULL,
  basis_kind TEXT NOT NULL,
  basis_json TEXT NOT NULL,
  scope_kind TEXT NOT NULL,
  scope_ref TEXT,
  pairing_event_id TEXT, binding_version INTEGER,
  purpose_scope TEXT,
  visible_scope_ids_json TEXT NOT NULL DEFAULT '[]', scope_set_version INTEGER NOT NULL DEFAULT 1,
  confirmed_by TEXT, confirmed_at INTEGER,
  valid_from INTEGER NOT NULL, valid_to INTEGER,
  version INTEGER NOT NULL,
  supersedes_id TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (status IN ('candidate','confirmed','source_verified','disputed','stale','revoked')),
  CHECK (basis_kind IN ('owner_pairing','user_confirmed','user_statement','adapter_directory','calendar_participant','doc_mention_id','name_similarity','email_pattern','domain_match','voice_match','model_score')),
  CHECK (scope_kind IN ('task','project','account')),

  CHECK (basis_kind NOT IN ('name_similarity','email_pattern','domain_match','voice_match','model_score') OR status IN ('candidate','disputed','stale','revoked')),

  CHECK (status <> 'confirmed' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL)),
  CHECK (status <> 'source_verified' OR basis_kind = 'adapter_directory'),
  CHECK (basis_kind <> 'owner_pairing' OR (pairing_event_id IS NOT NULL AND binding_version IS NOT NULL AND purpose_scope IS NOT NULL)),
  FOREIGN KEY (owner_id, counterpart_id) REFERENCES counterparts(owner_id, id),
  FOREIGN KEY (owner_id, endpoint_id) REFERENCES counterpart_endpoints(owner_id, id)
) STRICT;
CREATE INDEX identity_links_cp ON identity_links(owner_id, counterpart_id, status);
CREATE INDEX identity_links_ep ON identity_links(owner_id, endpoint_id, status);
CREATE TABLE unresolved_mentions (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  source_record_id TEXT NOT NULL, source_version TEXT NOT NULL,
  fragment_locator TEXT NOT NULL,
  raw_name TEXT NOT NULL,
  group_key TEXT,
  candidates_json TEXT,
  state TEXT NOT NULL DEFAULT 'open',
  resolved_counterpart_id TEXT, resolve_scope TEXT,
  resolved_link_id TEXT,
  created_at INTEGER NOT NULL, resolved_at INTEGER,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, scope_id, source_record_id, source_version, fragment_locator),
  CHECK (state IN ('open','resolved','dismissed','stale')),
  CHECK (resolve_scope IS NULL OR resolve_scope IN ('this_time_only','this_scope','account')),
  CHECK ((state = 'resolved') = (resolved_counterpart_id IS NOT NULL AND resolve_scope IS NOT NULL))
) STRICT;
`;

// stage7-0004: a typed name the user said does not point at any person ("会场", "待定", design 7.6 "这不是一个人" way 3). The
// Commitments keep their typed name; the name just stops appearing as a group waiting to be confirmed, until the user restores it.
export const STAGE7_DISMISSALS_SQL = `
CREATE TABLE counterpart_dismissals (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  normalized_raw TEXT NOT NULL,
  raw TEXT NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (owner_id, id)
) STRICT;
CREATE UNIQUE INDEX counterpart_dismissals_once ON counterpart_dismissals(owner_id, normalized_raw) WHERE revoked_at IS NULL;
`;
