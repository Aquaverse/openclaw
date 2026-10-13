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

// Stage 2 migration SQL: actions, decisions, decision_actions, action_grants, standing_grants, action_executions,
// grant_uses (DESIGN section 6.3, from "候选动作" up to "事实") followed by outbox and run_triggers (the two
// later blocks). Copied verbatim, comments included. It only ADDS tables: nothing from Stage 1 is altered.
// Regression group 11 checks this text against DESIGN.md and stacks it on the Stage 1 migration.
export const STAGE2_DECISION_SQL = `
---------- 候选动作：参数的唯一真相 ----------
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

---------- 人工决策 ----------
CREATE TABLE decisions (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  step_id TEXT,
  decision_type TEXT NOT NULL, risk_tier TEXT NOT NULL, question TEXT NOT NULL,
  facts_snapshot TEXT NOT NULL, options_snapshot TEXT NOT NULL, unknowns_snapshot TEXT NOT NULL,
  grant_policy_snapshot TEXT NOT NULL,   -- 这次批准将签发什么授权，进 authority_hash
  authority_hash TEXT NOT NULL,
  task_revision INTEGER NOT NULL,
  required_decider TEXT, deadline_at INTEGER,
  -- v0.6：等人决定时一律 pending，生命周期只受 decision 自己的 deadline_at 控制。
  -- core approval 的不可用/取消/超时只更新 core_approval_state，不动主状态。
  status TEXT NOT NULL,   -- pending|decided|effect_apply_failed|expired|superseded
                          -- v0.12c：原名 grant_write_failed。批准一条 set_preference
                          -- 决策后写偏好失败，不该被描述成"授权写入失败"（§8.12）。
  -- 结果与生命周期分开记（v0.5）：chosen_action_id IS NULL 不足以区分拒绝/取消/超时
  resolution TEXT,            -- approved|denied|cancelled|timed_out
  resolution_source TEXT,     -- core_approval|nexus_console
  resolved_by TEXT,           -- core 回调拿不到 reviewer 身份 → 'core-approval-reviewer-unavailable'
  resolved_at INTEGER,
  -- core approval 只是一次"尝试"，不是与决策页互斥的 surface（v0.5，见 §8.6）
  core_approval_state TEXT NOT NULL DEFAULT 'not_attempted',
                          -- not_attempted|attempted|resolved|cancelled|timed_out
  -- v0.8：attempted 是一个租约而不是终态。挂卡前拿租约，崩在返回前可被下一次重入接管。
  core_approval_attempt_at INTEGER,
  core_approval_attempt_by TEXT,
  -- v0.9：每次 claim 换一个新 token。onResolution 回调带着它签发时的 token，
  -- 对不上就说明这个回调来自已被取代的那次尝试，直接丢弃，不许覆盖状态。
  core_approval_attempt_id TEXT,
  -- v0.6：toolCallId 的唯一性 SDK 没有承诺跨 session/run/provider，必须加作用域
  session_key TEXT, run_id TEXT, tool_call_id TEXT,
  request_fingerprint TEXT,   -- sha256(taskId, decisionType, 排序后的 actionIds)
  approval_ref TEXT,      -- 仅 nexus_console 路径可填（core 不回传 approval id）
  chosen_action_id TEXT,
  -- v0.12：批准一条决策会产生什么，必须显式建模。此前 resolve 一律走"签发 grant +
  -- 预创建 execution"，于是"确认一条偏好"这种决策会掉进授权签发路径（§8.12）。
  effect_kind TEXT NOT NULL,              -- issue_action_grant|issue_standing_grant|set_preference|acknowledge
  effect_payload_canonical TEXT,          -- set_preference 的规范化 mutation，进 authority_hash
  UNIQUE (owner_id, task_id, id),
  -- v0.12b：把 effect_kind 放进唯一键，授权表才能用复合外键只引用"授权类决策"。
  -- 没有这个键时 CHECK 只能约束 decision 自己这一行，拦不住跨表引用（§8.12）。
  UNIQUE (owner_id, task_id, id, effect_kind),
  -- v0.12d：把 chosen_action_id 也放进唯一键。只绑"候选集成员"是不够的——实测可以
  -- 让 grant 绑 A1、同时把已批准 decision 的 chosen_action_id 改成 A2，
  -- 得到"用户选了 A2、实际签发 A1"。授权表改为直接引用这个键（§8.12）。
  UNIQUE (owner_id, task_id, id, chosen_action_id),
  -- v0.12e：连 status + resolution 一起进键。上面那个键不含批准状态，实测
  -- "pending + chosen_action_id=A1" 仍能签出 grant，denied / effect_apply_failed
  -- 保留 chosen 时同理。授权事实必须是**可被外键引用的整体**，不能靠 resolver
  -- 的调用顺序（§8.12）。resolution 为 NULL 的行天然当不了父行。
  UNIQUE (owner_id, task_id, id, effect_kind, status, resolution, chosen_action_id),
  CHECK (effect_kind IN ('issue_action_grant','issue_standing_grant','set_preference','acknowledge')),
  -- 只有 set_preference 带 payload；授权类与 acknowledge 必须为空
  CHECK ((effect_kind = 'set_preference') = (effect_payload_canonical IS NOT NULL)),
  -- 非授权类决策不得指定 action：它根本不该进入 execution 路径
  CHECK (effect_kind IN ('issue_action_grant','issue_standing_grant') OR chosen_action_id IS NULL),
  -- 批准一条授权类决策必须选定 action；pending 时为空是正常的。
  -- v0.12c：standing 也要——policy 必须能追溯到用户选中的那个样板动作（§8.6）。
  CHECK (NOT (status = 'decided' AND resolution = 'approved'
              AND effect_kind IN ('issue_action_grant','issue_standing_grant')
              AND chosen_action_id IS NULL)),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, step_id) REFERENCES nexus_task_steps(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, chosen_action_id) REFERENCES actions(owner_id, task_id, id),
  -- 被选中的那个 action 自己也必须是候选项（chosen_action_id 为 NULL 时外键自动满足）。
  -- deferred：resolve 事务里"写候选集"与"写 chosen"的先后不该被 schema 规定。
  FOREIGN KEY (owner_id, task_id, id, chosen_action_id)
    REFERENCES decision_actions(owner_id, task_id, decision_id, action_id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;
CREATE INDEX decisions_pending ON decisions(owner_id, status, deadline_at);
-- v0.8：session_key 也必须 IS NOT NULL。SQLite 的唯一索引把 NULL 当作互不相等，
-- 实测 session_key=NULL 时同 (owner, run, toolCall) 可以插入多行，幂等键直接失效。
CREATE UNIQUE INDEX decisions_toolcall
  ON decisions(owner_id, session_key, run_id, tool_call_id)
  WHERE tool_call_id IS NOT NULL AND run_id IS NOT NULL AND session_key IS NOT NULL;

-- v0.12b：决策的候选 action 集合必须规范化，否则 grant 可以绑一个根本不在
-- 这条决策候选里的 action——authority_hash 能发现它变了，但发现不了"从来不在里面"。
-- 带 decision_effect 冗余列 + CHECK，使得非授权类决策连候选行都挂不上。
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

---------- 授权 A：一次性、绑定 action（R2/R3） ----------
CREATE TABLE action_grants (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  from_decision_id TEXT NOT NULL,
  -- v0.12b：冗余但可被外键引用。写死成 'issue_action_grant' 之后，
  -- 这张表物理上无法引用 set_preference / acknowledge 的决策。
  from_decision_effect TEXT NOT NULL DEFAULT 'issue_action_grant',
  from_decision_status TEXT NOT NULL DEFAULT 'decided',
  from_decision_resolution TEXT NOT NULL DEFAULT 'approved',
  capability TEXT NOT NULL, tool_name TEXT NOT NULL,
  action_id TEXT NOT NULL, action_hash TEXT NOT NULL,
  currency TEXT, max_amount TEXT, allowed_variance_json TEXT,
  task_revision INTEGER NOT NULL, nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  consumed_at INTEGER, consumed_by_execution TEXT, revoked_at INTEGER,
  superseded_by TEXT,                    -- 签发新 grant 时作废同 action 的旧未消费 grant
  UNIQUE (owner_id, task_id, id),
  UNIQUE (owner_id, task_id, action_id, id),   -- v0.6：供 execution 四列复合 FK 引用
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  CHECK (from_decision_effect = 'issue_action_grant'),
  CHECK (from_decision_status = 'decided'),
  CHECK (from_decision_resolution = 'approved'),
  -- v0.12e：一条外键同时绑住四件事——这条决策是**授权类**、已经 **decided**、
  -- 结果是 **approved**、而且 grant 绑的正是用户**选中的那个** action。
  -- 任一条不成立就签不出 grant；事后改 status / resolution / chosen 都会被挡住。
  -- （chosen 必须是候选项由 decisions → decision_actions 的外键传递保证。）
  FOREIGN KEY (owner_id, task_id, from_decision_id, from_decision_effect,
               from_decision_status, from_decision_resolution, action_id)
    REFERENCES decisions(owner_id, task_id, id, effect_kind, status, resolution,
                         chosen_action_id),
  FOREIGN KEY (owner_id, task_id, action_id) REFERENCES actions(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, consumed_by_execution)
    REFERENCES action_executions(owner_id, task_id, id) DEFERRABLE INITIALLY DEFERRED,
  -- v0.6：self-FK 必须 deferred，否则轮换事务无解（§8.5 有实测）
  FOREIGN KEY (owner_id, task_id, superseded_by)
    REFERENCES action_grants(owner_id, task_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;
-- 同一个 action 同时最多只有一条未消费未作废的授权
CREATE UNIQUE INDEX action_grants_live ON action_grants(owner_id, action_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL AND superseded_by IS NULL;

---------- 授权 B：持续政策（R1） ----------
CREATE TABLE standing_grants (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  from_decision_id TEXT NOT NULL,
  from_decision_effect TEXT NOT NULL DEFAULT 'issue_standing_grant',
  from_decision_status TEXT NOT NULL DEFAULT 'decided',
  from_decision_resolution TEXT NOT NULL DEFAULT 'approved',
  -- v0.12c：standing policy 必须能追溯到"用户看到并选中的那个候选动作"。
  -- 只校验 decision 的 effect 时，候选集只有 A1 而 chosen_action_id=A2 的已批准决策
  -- 照样能签出 standing grant（实测被接受）。
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
  -- v0.12e：与 action_grants 同一个七列外键（理由见那里）
  FOREIGN KEY (owner_id, task_id, from_decision_id, from_decision_effect,
               from_decision_status, from_decision_resolution, source_action_id)
    REFERENCES decisions(owner_id, task_id, id, effect_kind, status, resolution,
                         chosen_action_id)
) STRICT;

---------- 执行：本地 admission + 结果状态机（v0.4 新增） ----------
-- v0.5：在**签发授权的同一事务里**预创建 state='prepared' 的行。
-- execution_id 因此是一张受约束的执行凭证，绑定唯一的 action + 唯一的 grant，
-- 而不是模型可以自由配对的字符串。commit 工具只收 executionId。
CREATE TABLE action_executions (
  id TEXT NOT NULL PRIMARY KEY,          -- execution_id，服务端签发
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, action_id TEXT NOT NULL,
  -- 不用多态 grant_kind+grant_id（无法加外键），改双列 + CHECK
  action_grant_id TEXT, standing_grant_id TEXT,
  provider_idempotency_key TEXT NOT NULL,      -- 服务端签发，传给供应商
  provider_idempotency_supported INTEGER NOT NULL,  -- 0/1，决定能否重试，见 §8.4
  state TEXT NOT NULL,                   -- prepared|executing|succeeded|failed|unknown
  provider_operation_id TEXT,
  result_canonical TEXT, result_hash TEXT, error_canonical TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_reconcile_at INTEGER,             -- state=unknown 时的对账时间
  prepared_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
  CHECK ((action_grant_id IS NOT NULL AND standing_grant_id IS NULL)
      OR (action_grant_id IS NULL AND standing_grant_id IS NOT NULL)),
  UNIQUE (owner_id, provider_idempotency_key),
  UNIQUE (owner_id, task_id, id),
  -- v0.7：同一 action + 同一 standing grant 最多只有一条未执行的 prepared execution，
  -- 否则重复调 nexus_action_authorize 会拿到多个可提交的凭证（§8.6）

  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, action_id) REFERENCES actions(owner_id, task_id, id),
  -- v0.6：四列复合 FK，schema 层杜绝"execution 绑 action B、grant 却属于 action A"
  FOREIGN KEY (owner_id, task_id, action_id, action_grant_id)
    REFERENCES action_grants(owner_id, task_id, action_id, id) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (owner_id, task_id, standing_grant_id)
    REFERENCES standing_grants(owner_id, task_id, id)
) STRICT;
-- v0.7：同一 action + 同一 standing grant 只允许一条 prepared execution，
-- 否则重复调 nexus_action_authorize 会拿到多个可提交的凭证（§8.6）
CREATE UNIQUE INDEX action_executions_prepared
  ON action_executions(owner_id, action_id, standing_grant_id)
  WHERE state = 'prepared' AND standing_grant_id IS NOT NULL;

CREATE TABLE grant_uses (               -- standing grant 的每次使用
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  standing_grant_id TEXT NOT NULL, execution_id TEXT NOT NULL,
  used_at INTEGER NOT NULL,
  UNIQUE (owner_id, execution_id),
  FOREIGN KEY (owner_id, task_id, standing_grant_id)
    REFERENCES standing_grants(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, execution_id)
    REFERENCES action_executions(owner_id, task_id, id)
) STRICT;

---------- 通知 outbox：与 decision 同事务写入（v0.7 新增） ----------
CREATE TABLE outbox (
  id TEXT NOT NULL PRIMARY KEY,
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  event_key TEXT NOT NULL,              -- 幂等键，如 decision_pending:<decisionId>
  kind TEXT NOT NULL,                   -- decision_pending|task_done|effect_apply_failed|...
  payload_canonical TEXT NOT NULL,      -- 只放 id + 摘要，不放敏感内容
  decision_id TEXT,
  state TEXT NOT NULL,                  -- pending|delivering|delivered|failed
  attempts INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT, claimed_at INTEGER,  -- 投递认领，防止多进程重复发
  next_attempt_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL, delivered_at INTEGER, last_error TEXT,
  UNIQUE (owner_id, event_key),         -- 同一事件只会有一行
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, decision_id) REFERENCES decisions(owner_id, task_id, id)
) STRICT;
CREATE INDEX outbox_due ON outbox(state, next_attempt_at);

---------- run 触发源账本：把 prompt 阶段的 trigger 带到 tool 阶段（v0.7 新增，见 §8.8） ----------
CREATE TABLE run_triggers (
  -- v0.9：主键是 (owner_id, run_id)。宿主的 run id 只保证在一个运行上下文内唯一，
  -- 单列主键会让第二个 owner 的同名 run 写不进去（ON CONFLICT DO NOTHING 静默跳过），
  -- 回读又因 owner 不符而 fail closed —— 等于被别人的 run 挡住。
  run_id TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  trigger TEXT NOT NULL,                -- user|cron|heartbeat
  session_key TEXT NOT NULL,            -- v0.8：回查必须比对，不允许 NULL
  job_id TEXT,                          -- cron turn 才有
  watch_id TEXT,                        -- 认证通过的 watcher 才有
  recorded_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,          -- v0.8：显式新鲜度，不依赖 GC
  PRIMARY KEY (owner_id, run_id)
) STRICT;
CREATE INDEX run_triggers_gc ON run_triggers(expires_at);
`;

// Stage 3 (slice 1) migration SQL: the claim / evidence ledger plus the two tables it must reference to have its final
// shape (evidence.blob_key -> blob_objects, blob_objects -> process_incarnations). DESIGN section 6.3, two segments copied
// verbatim: "事实：投影 + 追加事件" up to (not including) blob_reservations, and "完成条件". It only ADDS tables.
// Blob reservations, purge runs / work items, watches, preferences and purge_receipts arrive with later migrations.
// Regression group 11 checks this text against DESIGN.md and stacks it on the Stage 1 + Stage 2 migrations.
export const STAGE3_LEDGER_SQL = `
---------- 事实：投影 + 追加事件 ----------
CREATE TABLE claims (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  subject TEXT NOT NULL, predicate TEXT NOT NULL, value_json TEXT,
  state TEXT NOT NULL, verification_policy TEXT,
  head_event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE (owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  -- 循环引用：与首个 claim_event 同事务写入
  FOREIGN KEY (owner_id, task_id, id, head_event_id)
    REFERENCES claim_events(owner_id, task_id, claim_id, id) DEFERRABLE INITIALLY DEFERRED
) STRICT;

CREATE TABLE claim_events (             -- 不可变历史，唯一真相
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL, seq INTEGER NOT NULL,
  transition TEXT NOT NULL, source TEXT NOT NULL, actor TEXT NOT NULL,
  payload_canonical TEXT NOT NULL, prev_digest TEXT, digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, seq),
  UNIQUE (owner_id, task_id, id),
  UNIQUE (owner_id, task_id, claim_id, id),   -- 供 claims.head_event_id 复合引用
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id),   -- 不级联，见 §9.4
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
    DEFERRABLE INITIALLY DEFERRED
) STRICT;

-- evidence 关联改成关系表，不再用 JSON 数组（v0.4 修正）。
-- v0.12b：关联必须带**方向**和**有效性**。此前只有两个 id，于是验证 SQL 统计的是
-- 这条 claim 历史上关联过的全部来源——被反证、被撤回、被新版本取代的证据永久计数，
-- 两条"反证来源"甚至能凑够 COUNT(DISTINCT source_group) >= 2 把 claim 升成 VERIFIED。
-- 这张表仍是 append-only 的**链接事件**；当前有效集合由下面的投影表给出。
CREATE TABLE claim_event_evidence (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_event_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL,              -- supports|contradicts|unclassified|detach
  relation_rule_version INTEGER NOT NULL,  -- 判定用的 verifier 规则版本（§9.5.5）
  relation_reason TEXT NOT NULL,       -- 判定理由，给审计与决策卡片用
  supersedes_evidence_id TEXT,         -- 新版本材料取代旧版本时指向旧的那条
  PRIMARY KEY (claim_event_id, evidence_id),
  CHECK (relation IN ('supports','contradicts','unclassified','detach')),
  -- unclassified = verifier 判不出来。它既不支撑也不反证，**不会**进投影，
  -- 所以绝不会被当成 supports 计数（§9.5.5）。
  -- detach 是"取消这条关联"，它自己不带来支撑也不带来反证
  CHECK (relation NOT IN ('detach','unclassified') OR supersedes_evidence_id IS NULL),
  FOREIGN KEY (owner_id, task_id, claim_event_id)
    REFERENCES claim_events(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, evidence_id)
    REFERENCES evidence(owner_id, task_id, id),
  FOREIGN KEY (owner_id, task_id, supersedes_evidence_id)
    REFERENCES evidence(owner_id, task_id, id)
) STRICT;

-- 当前有效关联的投影：验证函数只读这张表。与链接事件在同一个同步事务里更新，
-- 所以"状态是当前有效支持集的函数、与到达顺序无关"这句话才成立。
CREATE TABLE claim_evidence_links (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  claim_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  relation TEXT NOT NULL,              -- supports|contradicts
  effective INTEGER NOT NULL,          -- 1=当前有效；0=已被 detach/supersede/撤回
  head_link_event_id TEXT NOT NULL,    -- 指向最后一条改动它的链接事件
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, task_id, claim_id, evidence_id),
  CHECK (relation IN ('supports','contradicts')),
  CHECK (effective IN (0, 1)),
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
    ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, evidence_id)
    REFERENCES evidence(owner_id, task_id, id),
  -- v0.12c：必须带 claim_id。只有三列时 C1 的投影可以把 C2 的事件当作最后改动事件
  -- （实测被接受）——而这张投影直接决定 SUPPORTED/VERIFIED/REFUTED，是跨 claim 漏洞。
  FOREIGN KEY (owner_id, task_id, claim_id, head_link_event_id)
    REFERENCES claim_events(owner_id, task_id, claim_id, id)
) STRICT;
CREATE INDEX claim_evidence_links_live
  ON claim_evidence_links(owner_id, task_id, claim_id, relation)
  WHERE effective = 1;

CREATE TABLE evidence (
  id TEXT NOT NULL PRIMARY KEY, owner_id TEXT NOT NULL, task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  -- v0.12g：blob_key 是 '<content_hash>.<generation>'，绑定到**具体那个物理对象**；
  -- 单条证据删除时置 NULL（§9.4），NULL 自动满足外键
  blob_key TEXT, content_hash TEXT NOT NULL, byte_size INTEGER,
  -- 证据只能按引用登记，字节从不经过模型（§9.5）
  source_ref_kind TEXT NOT NULL,        -- tool_output|execution|blob
  source_ref_id TEXT NOT NULL,          -- toolCallId | executionId | blobKey
  -- v0.12：VERIFIED 的判据必须有数据承载，不能放在 meta_json 里。
  -- 两列都由服务端从 ref 推导（§9.5.3），模型碰不到。
  -- v0.12b：身份必须标定"一份具体的材料"，不是"一个实体或位置"。
  -- 用供应商+账户+confirmation number 或裸 URL 当身份，会把同一订单的多次回执、
  -- 同一页面的不同时点、同一账户的不同期账单压成一行，复用旧行就丢了新内容。
  source_locator_canonical TEXT NOT NULL,  -- 规范化位置：mailbox+Message-ID、URL 规范形、provider+订单号
  source_version TEXT NOT NULL,            -- 来源给出的版本标识：Message-ID、ETag、回执修订号；
                                           -- 来源不给版本则固定为 'content:<content_hash>'（§9.5.3）。
                                           -- 绝不要用捕获时刻：同一位置的相同字节会算出两个身份，去重失效。
  source_identity_hash TEXT NOT NULL,      -- sha256(canonical({locator, version, contentHash}))
  source_run_id TEXT,                      -- source_ref_kind='tool_output' 时必填：toolCallId 没有跨 run 唯一性
  source_session_key TEXT,                 -- 同上，构成可回溯的作用域
  source_group TEXT NOT NULL,           -- 独立来源类；VERIFIED 按它去重计数
  source_group_rule_version INTEGER NOT NULL,  -- 规则改版后可重算、可审计
  content_classification TEXT NOT NULL DEFAULT 'personal',
  retention_policy TEXT NOT NULL, redaction_state TEXT NOT NULL DEFAULT 'raw',
  delete_requested_at INTEGER, purged_at INTEGER,
  meta_json TEXT, captured_at INTEGER NOT NULL,
  UNIQUE (owner_id, task_id, id),
  -- v0.12h：把 content_hash 一起绑进去。只校验 (owner, blob_key) 时 schema 接受
  -- "blob_key=A.1 但 content_hash=B"，来源身份、审计 hash 与真实字节就脱钩了。
  FOREIGN KEY (owner_id, content_hash, blob_key)
    REFERENCES blob_objects(owner_id, content_hash, blob_key),
  CHECK (blob_key IS NULL OR byte_size IS NOT NULL),
  -- 同一份材料在同一 Task 内只有一行：否则把一封邮件登记两次就能凑出"两条证据"。
  -- 注意身份含 content_hash，所以"同一位置的新版本"是另一行，不会被复用覆盖。
  UNIQUE (owner_id, task_id, source_identity_hash),
  -- tool_output 的引用必须带 run/session 作用域，否则重启后定位不回原始来源
  CHECK (source_ref_kind <> 'tool_output'
         OR (source_run_id IS NOT NULL AND source_session_key IS NOT NULL)),
  -- Agent 的自述永远不是证据，这条由 schema 兜住而不是靠调用方自觉
  CHECK (source_group <> '' AND source_group <> 'agent_assertion'),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id)   -- 不级联
) STRICT;

-- v0.12e：promote 了但还没提交的字节必须有一个**算进配额的持有者**。
-- 否则 A2 写进正式区、B 失败 → 没有 evidence 行 → 这些字节在按 evidence.byte_size
-- 累加的软配额里完全不可见，连续用过期的 expectedHeadEventId 失败就能稳定泄漏容量，
-- 六个接近 100 MB 的条目即可顶到插件的 512 MB 硬上限，而且运行期没有恢复路径。
-- v0.12g：物理对象的生命周期必须自己有一张表，而且 key **不能**等于稳定的
-- content_hash。只要 key 是内容寻址的，事务外的 I/O 就没法 fence：
--   · A2 的 registerIfAbsent 迟到返回，会在 GC 已经置 abandoned 之后写出无主字节；
--   · GC1 的删除调用迟到返回，会删掉后来重新投入使用的同名对象。
-- attempt id 只能丢弃迟到的 **SQL** 收尾，撤销不了已经发出的 I/O。
-- 所以物理 key 带 generation，且**永不复用**：旧 attempt 只能动自己的 generation。
-- v0.12j：进程 incarnation 的权威记录。v0.12i 写"不在存活列表里"，但没人定义
-- 这张列表；现在它就是这张表。incarnation 由 service.start 生成（随机 id，
-- 作用域是**一个 nexus.sqlite**），"旧 incarnation 已不存在"只能由
-- 新 incarnation 在**持有 Gateway 状态目录排他锁**之后，于同一个同步事务里
-- 把所有未终止的旧行置 gone 来声明（§9.5.1）。这依赖 OpenClaw 的单进程排他
-- （src/infra/gateway-lock.ts 的 gateway.state.lock），是耦合契约，Stage 0 spike 3 验证。
CREATE TABLE process_incarnations (
  incarnation_id TEXT NOT NULL PRIMARY KEY,
  -- v0.12k：同一个 Gateway 进程内 service 可以 reload/replacement（services.ts 的
  -- reload：stop 最多 5 秒观察期，再 start），这时锁从未换手，新 start 不能证明旧
  -- incarnation 属于"已经消失的进程"。所以每行记所属进程的 boot id，
  -- superseded_under_gateway_lock 只允许替换 **boot id 不同** 的旧行；同进程的前任只能
  -- 由它自己在所有 writer 都真实 settle 之后写 clean_shutdown。
  process_boot_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  gone_at INTEGER,
  gone_basis TEXT,                       -- clean_shutdown|superseded_under_gateway_lock
  CHECK ((gone_at IS NULL) = (gone_basis IS NULL)),
  CHECK (gone_basis IS NULL
         OR gone_basis IN ('clean_shutdown','superseded_under_gateway_lock'))
) STRICT;
-- v0.12n：**没有**"至多一个当前 incarnation"的唯一索引。v0.12j–m 有过这个索引，
-- 代价是旧行一旦遗留（崩溃后再也写不了 clean_shutdown），新 service.start 就永远登记不进去，
-- 整个插件服务起不来。"同一个库不允许两个并存的 Gateway writer"本来就是 Gateway 状态目录锁
-- 的职责，不需要在这张表里再实现一遍。非 gone 的旧行只意味着"这个旧 incarnation 的 writer
-- 还没有静默依据"，只影响 incarnation_gone 这条路径，不影响服务可用性（§9.5.1）。
-- 本表（与 blob_* / purge_* 一起）属于 Stage 3 的 migration，Stage 0 spike 3 冻结 boot id 来源
-- 之前不得进入任何发布的 migration；本文件里的 SQL 只是设计形状，回归第 11 组据此验证形状。

CREATE TABLE blob_objects (
  owner_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  generation INTEGER NOT NULL,           -- 同一内容的第 n 次物理落地，单调
  blob_key TEXT NOT NULL,                -- '<content_hash>.<generation>'，store 里的真 key
  byte_size INTEGER NOT NULL,
  state TEXT NOT NULL,                   -- writing|live|reclaiming|deleted
  ref_count INTEGER NOT NULL,            -- 引用它的 live evidence 行数（投影）
  -- v0.12h：writer 与 reclaim 各有自己的租期，不共用一个含义模糊的 lease_until。
  -- 没有 writer 租期的话，A2 超时/崩溃会留下永远进不了回收的 writing 对象:
  -- 它被 blob_objects_live_hash 当作未删除 generation 挡住新 generation，
  -- 又占着 owner 软配额，而"迟到写由墓碑重删"也永远不会发生。
  writer_attempt_id TEXT,                -- state='writing' 时的 A2 认领者
  writer_lease_until INTEGER,            -- state='writing' 的租期；过期即可被回收认领
  writer_incarnation TEXT,               -- v0.12i：发起该 writer 的进程 incarnation（落盘时就记）
  reclaim_attempt_id TEXT,               -- state='reclaiming' 时的回收认领者
  reclaim_lease_until INTEGER,           -- 回收租期，过期可被 maintenance 接管
  -- v0.12h：hard purge 的"字节确实不存在"证明。只有 state='deleted' 且这几列有值，
  -- 才允许写成功回执（§9.4 的 P5）；否则 purge 只能返回 cleanup_pending。
  absence_verified_at INTEGER,
  absence_verified_attempt_id TEXT,
  -- v0.12i：证明必须绑定"**哪个** writer 已经静默"。租期过期只撤销数据库授权，
  -- 取消不了同进程里仍在 await 的 registerIfAbsent（§9.5.1）。
  -- writing → reclaiming / live 都会清掉 writer token，所以转移的**同一个事务**里
  -- 要把 writer_attempt_id / writer_incarnation 抄进 settled_writer_*：
  --   writing → live        抄走并写 reason='committed'（A2 已返回、B 已赢）
  --   writing → reclaiming  抄走，reason 留空，等确认静默后才写
  -- reason 非空才表示"这个 writer 的 I/O 已确认静默"。
  settled_writer_attempt_id TEXT,
  settled_writer_incarnation TEXT,
  writer_settled_reason TEXT,            -- committed|awaited|incarnation_gone
  -- v0.12j：缺失证明被作废的次数。字节在"已确认缺失"之后又出现，只作废
  -- absence_verified_*（当前这次检查的结论），**不**清 settled_writer_*
  -- （writer 的身份与静默依据是生命周期事实，崩溃恢复要靠它重新签发）。
  absence_invalidated_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, content_hash, generation),
  UNIQUE (owner_id, blob_key),
  -- v0.12h：供 evidence 复合引用，把它声称的 content_hash 和物理对象绑死
  UNIQUE (owner_id, content_hash, blob_key),
  -- v0.12j：供 purge_work_items 引用，把"声明的 (hash, generation)"与它携带的
  -- blob_key 绑死（只绑前三列时，工作项可以声明 H1.1 却携带 H2.1）
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
  -- 只有没人引用了才允许进 reclaiming / deleted
  CHECK (state NOT IN ('reclaiming','deleted') OR ref_count = 0),
  -- 缺失证明只可能出现在墓碑上
  CHECK (absence_verified_at IS NULL OR state = 'deleted'),
  CHECK ((absence_verified_at IS NULL) = (absence_verified_attempt_id IS NULL)),
  CHECK (writer_settled_reason IS NULL
         OR writer_settled_reason IN ('committed','awaited','incarnation_gone')),
  -- 声称某 writer 已静默，就必须说得出是哪个 writer
  CHECK (writer_settled_reason IS NULL
         OR (settled_writer_attempt_id IS NOT NULL
             AND settled_writer_incarnation IS NOT NULL)),
  -- 没有"哪个 writer 已静默"的记录，就不准签发缺失证明
  CHECK (absence_verified_at IS NULL
         OR (settled_writer_attempt_id IS NOT NULL
             AND settled_writer_incarnation IS NOT NULL
             AND writer_settled_reason IS NOT NULL))
) STRICT;
-- 同一内容同时最多只有一个未删除的 generation：新 generation 只能在旧的
-- 进入 deleted 之后创建，于是物理 key 永不复用，迟到的删除伤不到新对象。
CREATE UNIQUE INDEX blob_objects_live_hash ON blob_objects(owner_id, content_hash)
  WHERE state IN ('writing','live','reclaiming');
-- deleted 行是**墓碑**，不能马上丢：A2 的迟到写可能把字节又创回来，
-- 维护扫描要能按 blob_key 再删一次（key 不复用，所以重删永远安全）。
-- 墓碑扫描：优先处理还没拿到缺失证明的
CREATE INDEX blob_objects_tombstone ON blob_objects(owner_id, updated_at)
  WHERE state = 'deleted' AND absence_verified_at IS NULL;
-- 回收扫描：writing 租期过期的、以及 reclaiming 租期过期要接管的
CREATE INDEX blob_objects_stale_writing ON blob_objects(owner_id, writer_lease_until)
  WHERE state = 'writing';

---------- 完成条件 ----------
CREATE TABLE nexus_task_completion_claims (
  owner_id TEXT NOT NULL, task_id TEXT NOT NULL, claim_id TEXT NOT NULL,
  required_state TEXT NOT NULL DEFAULT 'VERIFIED',
  PRIMARY KEY (task_id, claim_id),
  FOREIGN KEY (owner_id, task_id) REFERENCES nexus_tasks(owner_id, id) ON DELETE CASCADE,
  FOREIGN KEY (owner_id, task_id, claim_id) REFERENCES claims(owner_id, task_id, id)
) STRICT;
`;

export const MIGRATIONS: readonly Migration[] = [
  { id: "stage1-0001-task-core", sql: STAGE1_TASK_CORE_SQL },
  { id: "stage2-0001-decision-grant-execution", sql: STAGE2_DECISION_SQL },
  { id: "stage3-0001-claim-evidence-ledger", sql: STAGE3_LEDGER_SQL },
];
