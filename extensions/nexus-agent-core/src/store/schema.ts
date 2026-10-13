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

export const MIGRATIONS: readonly Migration[] = [
  { id: "stage1-0001-task-core", sql: STAGE1_TASK_CORE_SQL },
  { id: "stage2-0001-decision-grant-execution", sql: STAGE2_DECISION_SQL },
];
