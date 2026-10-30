# Nexus Agent Core — 组件架构

> 配套文档：[`nexus-agent-core-design.md`](./nexus-agent-core-design.md) 讲**为什么这么设计**（含被实测推翻的假设与威胁模型）。
> 本文讲**有哪些组件、各自挂在 OpenClaw 的哪个扩展点、什么时候被触发、读写哪些表**。
> 先读本文建立地图，需要判断某个设计取舍时再回 nexus-agent-core-design.md 查对应小节。

---

## 1. 一句话分层

```
┌─ Nexus Agent Core Plugin（extensions/nexus-agent-core/）
│
│   提示层     把"进行中的事项"注入对话，把工具面按风险收窄
│   工具层     nexus_task_* / nexus_action_* / nexus_decision_* / nexus_claim_*
│   策略层     风险分级、授权求值、决策生成（全部服务端判定，不信模型）
│   存储层     自有 SQLite：Task / Action / Decision / Grant / Execution / Ledger
│   接口层     nexus.* Gateway RPC + plugin.nexus-agent-core.* 事件（给桌面 App / Control UI）
│   后台层     Watcher（定时回检）、gateway_start 对账、通知
│
└─ 全部通过 openclaw/plugin-sdk/* 挂载，不改 OpenClaw src/
```

对应关系：**OpenClaw 提供"一次对话怎么跑"，Nexus 提供"一件事怎么跨很多次对话跑完，并且能证明跑完了"。**

---

## 2. 挂载点总览

| Nexus 组件         | OpenClaw 扩展点                         | SDK / 文件                                                                                                | 触发时机                                                                                                                                |
| ------------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Prompt 注入器      | `before_prompt_build` 钩子              | `api.on("before_prompt_build", …, {requiresToolAuthority:true})`                                          | 每个 **attempt** 的提示装配阶段                                                                                                         |
| run 触发源账本     | 同上（顺手记账）                        | 把 `PluginHookAgentContext` 的 `runId`+`trigger`+`jobId` 写进 `run_triggers`（主键 `(owner_id, run_id)`） | 提示装配阶段写入（缺 runId/sessionKey 则不写）；工具阶段按 **owner + runId + sessionKey** 回查并校验 `expires_at`，任一不符 fail closed |
| 通知 outbox        | 自有表 + 投递器                         | 与 decision **同一个同步事务**写入                                                                        | 决策创建时入队；投递器认领后发送                                                                                                        |
| Watcher 认证器     | 同上（同一个 handler 的前置分支）       | `ctx.trigger === "cron"` + `ctx.jobId`                                                                    | 定时 turn 的提示装配阶段                                                                                                                |
| 工具面             | 工具注册                                | `api.registerTool` + manifest `contracts.tools`                                                           | 模型调用时                                                                                                                              |
| 通用工具拦截（T6） | `before_tool_call` 钩子                 | `matcher: 通用高危工具`                                                                                   | 模型调用非 Nexus 工具时                                                                                                                 |
| 决策卡片           | `before_tool_call` 钩子（独立 matcher） | `requireApproval{…}`                                                                                      | 模型调用 `nexus_decision_request` 时                                                                                                    |
| 授权与执行         | **工具处理器内部**（不是钩子）          | `nexus_action_commit.execute()`                                                                           | 模型调用 commit 时                                                                                                                      |
| 存储层             | 插件自有 SQLite                         | `resolveStateDir()` + `runSqliteImmediateTransactionSync`                                                 | 全程                                                                                                                                    |
| 证据 blob          | 插件 blob store                         | `api.runtime.state.openBlobStore`                                                                         | 写证据时                                                                                                                                |
| RPC                | Gateway 方法注册                        | `api.registerGatewayMethod(name, handler, {scope})`                                                       | 客户端调用时                                                                                                                            |
| 事件推送           | Gateway 事件                            | `ctx.gatewayEvents.emit` **（只在 `api.registerService` 的 ctx 上）**                                     | 状态变更时                                                                                                                              |
| 会话投影           | Session extension                       | `api.session.state.registerSessionExtension`                                                              | Task 绑定会话时                                                                                                                         |
| 定时回检           | Cron 驱动的 session turn                | `api.session.workflow.scheduleSessionTurn`                                                                | 排程时 / 到点时                                                                                                                         |
| 带外回灌           | 下一轮注入队列                          | `api.session.workflow.enqueueNextTurnInjection`                                                           | 后台产生进展时                                                                                                                          |
| 启动对账           | `gateway_start` 钩子                    | `api.on("gateway_start", …)`                                                                              | 网关启动                                                                                                                                |
| 通知               | 系统事件 + 心跳                         | `enqueueSystemEvent` / `requestHeartbeat`                                                                 | 待决策、任务完成                                                                                                                        |

---

## 3. 一次用户对话里的触发顺序

OpenClaw 侧的真实顺序（已在仓库核对）：运行时准备 → 提示装配 → 工具循环 → 收尾。
提示装配内部的次序是 `queued injections → agent_turn_prepare → heartbeat_prompt_contribution
→ before_prompt_build`（`run/attempt-prompt-helpers.ts:114-162`）。

```
用户发一条消息
│
├─[运行时准备]  before_model_resolve            ← adaptive-model 插件在这里换模型
│                                                 Nexus 不参与
│
├─[提示装配]    ① 排队注入被 drain（按 runId 缓存，一轮只 drain 一次）
│               ② agent_turn_prepare
│               ③ before_prompt_build ★ Nexus 提示注入器
│                    · 解析 principal → 查 open nexus_tasks
│                    · prependSystemContext = Task 协议（静态，provider 可缓存）
│                    · prependContext       = 进行中事项清单（每轮几十 token）
│                    · toolsAllow           = riskLockdownFor(当前会话的 active Task)
│                  ⚠ 这一步是**按 attempt** 跑的，重试/压缩后会再跑一次 → 必须幂等
│
├─[工具循环]    模型决定调工具
│               │
│               ├─ before_tool_call ★ Nexus 两个独立 matcher
│               │    · matcher = [nexus_decision_request]  → 建 decision + 通知 + 挂卡片
│               │    · matcher = 通用高危工具              → T6 启发式拦截
│               │    ⚠ 所有插件的 hook 顺序跑完再合并；未请求审批时后续插件仍可改参数/block
│               │      （src/plugins/hooks.ts:1294-1300）→ 所以授权判定不在这里
│               │
│               ├─ 工具 execute() ★ Nexus 授权与执行都在这里
│               │    · nexus_action_commit：同步事务 admit → 外部 I/O → 同步事务 settle
│               │
│               └─ after_tool_call（Nexus 目前不用）
│
└─[收尾]        before_agent_finalize / agent_end（Nexus 目前不用）
```

**为什么授权不在 `before_tool_call`**：那一层的结果会被后续插件合并、覆盖、拦截，
详见 nexus-agent-core-design.md §8.1–§8.2。这是整个架构里最容易踩错的一处。

---

## 4. 组件清单

每节格式：**职责 / 挂载点 / 时机 / 数据 / 失败处理 / 工作表对应行**。

### 4.1 Prompt 注入器（Task Priming）

- **职责**：让模型"看得见"这个用户手上还有哪些没办完的事，从而自然选择
  `nexus_task_get(#T7)` 而不是新建；同时按当前会话的 active Task 收窄工具面。
- **挂载点**：`before_prompt_build`，注册时带 `{requiresToolAuthority: true}`
  （这样能在宿主敲定工具面之后运行，`ctx.toolAuthority` 可用）。
- **时机**：每个 attempt。重试与压缩会重复触发，注入内容必须是纯函数式的。
- **数据**：只读 `nexus_tasks`、`nexus_task_sessions`；不写。
- **失败处理**：解析不出 principal 就**不注入**，不能退化成全量查询。
- **工作表**：Task / Workflow Manager（M1）。
- **nexus-agent-core-design.md**：§7.1。

### 4.2 Watcher 认证器（Authenticate-and-Claim）

- **职责**：识别"这一轮 cron turn 是不是我排的 watcher"，并**当场认领**，
  保证重复触发只有一个赢家；赢家拿只读工具面，失效的同 job 轮次 fail closed。
- **挂载点**：与 4.1 同一个 `before_prompt_build` handler，但分支**前置**在
  `trigger !== "user"` 的过滤之前——否则 cron turn 会被一起挡掉。
- **时机**：`ctx.trigger === "cron" | "heartbeat"` 的提示装配阶段。
- **数据**：对 `watches` 做一条 CAS（`scheduled → firing`，比对
  `scheduler_job_id` + `scheduler_revision` + `session_key` + owner）。
- **失败处理**：三态——不是 Nexus 的 job（不干预）、是且认领成功（注入只读面）、
  是但状态失效（`toolsAllow: []` + no-op 指令，**不能**当普通 cron 放行）。
- **工作表**：Watcher / Long-running Task Manager（M2）。
- **nexus-agent-core-design.md**：§10.2。

### 4.3 工具面（模型的唯一入口）

| 工具                                   | 风险     | 有无副作用 | 作用                                                                                                                  |
| -------------------------------------- | -------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| `nexus_task_reserve`                   | R0       | 无         | 领一个服务端幂等令牌                                                                                                  |
| `nexus_task_create`                    | R0       | 无         | 建 Task（内置去重，无 `force`）                                                                                       |
| `nexus_task_get` / `_update` / `_note` | R0       | 无         | 读写目标与进展（必须显式带 taskId）                                                                                   |
| `nexus_task_search`                    | R0       | 无         | 清单被截断或会话未注入时找候选，**不自动绑定**                                                                        |
| `nexus_claim_add`                      | R0       | 无         | 记事实；`state` 只收 `ASSERTED`/`UNKNOWN`（DESIGN §9.5）                                                              |
| `nexus_evidence_add`                   | R0       | 无         | 登记证据并挂到一条 claim 上：收 `{taskId, claimId, ref, expectedHeadEventId?}`，**只收引用不收字节**（DESIGN §9.5.1） |
| `nexus_claim_verify`                   | R0       | 无         | 只读"还缺什么才能达标"，不触发验证（DESIGN §9.5）                                                                     |
| `nexus_action_prepare`                 | R0       | 无         | 规范化参数 → 登记 `actions` 行                                                                                        |
| `nexus_action_authorize`               | R0       | 无         | **R1 专用**：按 standing policy 现场签发 `prepared` execution                                                         |
| `nexus_decision_request`               | R0       | 无         | 生成待决策（卡片挂在它上面）                                                                                          |
| `nexus_action_commit`                  | R1/R2/R3 | **有**     | 消费授权并执行；只收 `executionId`                                                                                    |
| `nexus_preference_get` / `_set`        | R0       | 无         | 偏好；`get` 带可选 `taskId`（不传则排除 `task_exception`），`_set` **写不了 `stated`**（DESIGN §11.3/§11.4）          |

- **挂载点**：`api.registerTool`；工具名必须在 manifest `contracts.tools` 里声明，
  否则注册会被拒（`src/plugins/tool-contracts.ts:20`）。
- **关键约束**：所有工具 schema `additionalProperties: false`。
  因为 hook 返回的 `params` 在 core 那边是**浅合并**，删不掉字段
  （`agent-tools.before-tool-call.approval.ts:74-85`）。
- **工作表**：Task / Workflow Manager、Permission Engine、Evidence Ledger、
  Personal Context / Preference Store。逐行映射见 nexus-agent-core-design.md §12，
  **那张表是工具名的唯一真相**；本表只说风险与副作用。

### 4.4 决策管理器（Human Decision Manager）

- **职责**：把"需要人拍板"这件事变成一条可审计的记录：
  服务端从 `claims` 生成事实、从 `actions` 生成选项、补齐未知项，
  算出可重算的 `authority_hash`，然后尝试呈现给人。
- **挂载点**：`before_tool_call`，`matcher: ["nexus_decision_request"]`（独立 matcher，
  不与任何执行路径共用）。
- **拿不到 trigger**：`PluginHookToolContext` 没有 `trigger`/`jobId`（`hook-types.ts:707`），
  所以"是不是 user turn"要靠 `ctx.runId` 回查 `run_triggers`（提示阶段记的账），
  查不到一律 fail closed 当作非 user turn。见 nexus-agent-core-design.md §8.8.1。
- **时机**：模型调用 `nexus_decision_request` 时。
- **顺序很重要**：**先落盘 → 先推事件 → 再尝试 core 卡片**。
  因为 core 判定审批面不可用时会**直接 block 工具**并只回调一个无区分度的
  `"cancelled"`（`approval.ts:272-283`），若 decision 是在 `execute()` 里创建的，
  用户会什么都看不到。
- **数据**：写 `decisions`（含 `resolution` / `core_approval_state` / `tool_call_id` 幂等键、
  以及 `effect_kind` / `effect_payload_canonical`）。
- **core 回调与 App RPC 共用一个 `resolveDecisionEffectAtomically`**：重算 authority hash
  → CAS `pending → decided` → 按 effect 分派。两条入口不能各写一份（DESIGN §8.9）。
- **resolve 按 effect 分派**：`issue_action_grant` 签 action grant + 预创建 execution；
  `issue_standing_grant` 只签 standing grant（execution 由 `nexus_action_authorize` 现场签）；
  `set_preference` 只写偏好两张表（4.12），**不签发任何授权、不通知 Agent 去 commit**；
  `acknowledge` 只改自身。
- **隔断靠复合外键，不只是 CHECK**：`decisions` 的 `effect_kind` 进了唯一键，
  两张授权表用一条**七列**外键引用 `decisions(owner_id, task_id, id, effect_kind,
  status, resolution, chosen_action_id)`——同时绑住 effect 对得上、已 `decided`、
  结果 `approved`、绑的正是用户选中那个 action；`decisions.chosen_action_id` 再复合
  引用 `decision_actions`，保证所选项是候选项。CHECK 只管得住 decision 自己那一行。
  见 nexus-agent-core-design.md §8.12。
- **状态机**：等人决定时 decision **恒为 `pending`**，生命周期只受它自己的 `deadline_at`
  控制；core 的不可用 / `cancelled` / timeout **只更新 `core_approval_state`**，不动主状态。
  （一个可选的卡片不该给主决策套上超时——这是 v0.5 踩过的坑。）
- **幂等**：唯一键是 `(owner_id, session_key, run_id, tool_call_id)` + request fingerprint
  ——SDK 没有承诺 `toolCallId` 跨 session/run 全局唯一，而且**索引谓词必须要求
  `session_key IS NOT NULL`**（SQLite 的唯一索引把 NULL 当作互不相等，实测会漏）；
  缺 session 一律 fail closed。
- **副作用幂等**：`getOrCreateWithNotice` 在**一个同步事务**里同时写 decision 与 outbox，
  返回 `{decision, created, noticeEnqueued}`——`created=false` 但 `noticeEnqueued=true`
  说明上次崩在两步之间、这次补上了，**实现时别漏掉这个恢复分支**。
  core 卡片单独做一次带租期的 claim（`not_attempted` 或租约已过期才能拿到），
  只有赢家返回 `requireApproval`；崩在返回前不会永久占住。
  **租期由 `approvalTimeoutMs + 60s` 推导，不是独立常量**：`claimCoreApprovalAttempt`
  只收 `approvalTimeoutMs`，租期在 store 内部算，调用方没有 `leaseMs` 这个参数。
  租期短于卡片寿命会在旧卡还等着用户时重挂第二张；正常路径靠 `onResolution` 提前释放，
  超时只是崩溃兜底。每次 claim 换一个 attempt token，被取代的尝试的迟到回调会被丢弃。
- **失败处理**：回调完全丢失时我们**没有证据**证明用户批准过，decision 停在 `pending`
  等人处理，**不显示"已批准但保存失败"**；只有确实收到 `allow-once` 而那个事务失败，
  才写 best-effort 的 `effect_apply_failed`；抛在事务之前/之中与回调丢失不可区分，
  一律保持 `pending`（DESIGN §8.9）。
- **工作表**：Human Decision / Approval Manager（M1）。
- **nexus-agent-core-design.md**：§8.6、§8.7、§8.8。

### 4.5 授权引擎（Grant Engine）

- **职责**：回答"这一次具体动作，现在允许做吗"。OpenClaw **没有**金额/能力级权限模型
  （全仓 grep `maxAmount|spendLimit` 零结果），这一层完全自建。
- **挂载点**：**不是钩子**。它是 `nexus_action_commit.execute()` 里的第一段同步事务。
- **时机**：commit 被调用的瞬间，拿到的是经过所有 hook、schema 校验后的最终参数。
- **数据**：
  - `action_grants`（R2/R3，一次性，绑唯一 action）——选定唯一候选后条件更新 + `RETURNING`；
  - `standing_grants`（R1，政策，不写 `consumed_at`）+ `grant_uses`；
  - `action_executions`（执行凭证，在**签发授权时**就预创建好并绑定）。
- **轮换**：签发新 grant 的事务顺序是有坑的——先插新行撞部分唯一索引，
  先标旧行撞 self-FK 立即检查，而且**已过期但没退休的 grant 仍占着 live 槽位**
  （部分索引的谓词引用不了"当前时间"）。三点都在 SQLite 3.45.1 上实测过，
  权威顺序见 nexus-agent-core-design.md §8.5。
- **R1 与 R2/R3 的 execution 来源不同**：R2/R3 在批准时与 grant 同事务预创建；
  R1 是可复用政策，批准时未来的动作还不存在，所以由 `nexus_action_authorize`
  在每次具体动作上重新校验政策后现场签发。`grant_uses` 在 **admission CAS** 时才写，
  不在 authorize 时写——否则反复 authorize 会把频率额度刷光。见 nexus-agent-core-design.md §8.6。
- **失败处理**：授权缺失/过期/撤销/revision 变更 → `rejected`，工具返回原因，不碰供应商。
- **工作表**：Permission / Authorization Engine（M1）。
- **nexus-agent-core-design.md**：§8.2–§8.4。

### 4.6 执行 Admission（Execution State Machine）

- **职责**：保证"本地准入恰好一次"，并把"结果不确定"建模成一等状态而不是错误。
- **execution 的两种来源**：R2/R3 在决策被批准时与 `action_grants` 同事务预创建；
  **R1 由 `nexus_action_authorize` 在每次具体动作上现场签发**。
  同一 action + 同一 standing grant 最多只有一条 `prepared`（部分唯一索引保证），
  重复 authorize 返回同一个 `executionId`。
- **时机**：commit 内部，夹在两段同步事务之间。
- **状态**：`prepared → executing → succeeded | failed | unknown`，`unknown` 靠对账收敛。
- **判定五类结果**（`replay` 有 succeeded / failed 两个终态，共六个名字）：
  `replay_succeeded` / `replay_failed` / `reconcile_only` /
  `retry_provider_idempotently` / `execute_new` / `rejected`。
  **`unknown` 与无法证明未发出的 stale `executing` 一律 `reconcile_only`，绝不重放。**
- **口径**：对外**不承诺 exactly-once**，只承诺"本地 admission 恰好一次 +
  结果不确定进入对账"——供应商不支持幂等时，重复下单只能靠对账收敛。
- **约束**：写事务必须同步（`AGENTS.md:58`：No Promise or `await` in a transaction callback），
  所以是"同步事务 → 外部 I/O → 同步事务"，不是一个大事务包住网络调用。
- **nexus-agent-core-design.md**：§8.2–§8.4。

### 4.7 事实账本（Claim / Evidence Ledger）

- **职责**：把"商家说退款了"和"银行显示到账了"分开，并让"这件事办完了"可被证明。
  OpenClaw 的 Gateway audit 只存元数据且对插件只读，所以自建。
- **挂载点**：工具（`nexus_claim_add` / `nexus_evidence_add` / `nexus_claim_verify`）+ 存储层
  - `nexus.claim.retract`（用户显式撤回，`REFUTED` 的唯一非 store 来源）
  - `nexus.claim.unlinkEvidence`（`detach` 的唯一来源）两个 RPC。
    入参契约、**A0 初检 / A1 暂存 / A2 promote / B 最终 admission** 四个阶段
    （A0 在读字节之前就拒掉跨 owner 的引用）、以及"等级由服务端判定、
    证据只按引用登记"见 nexus-agent-core-design.md §9.5.1。
- **relation 由服务端 verifier 判定**，不是工具入参；判不出来写 `unclassified`，
  不进投影、不计入任何一侧（DESIGN §9.5.5）。
- **独立来源**：`VERIFIED` 按 `evidence.source_group` **去重计数**，且只统计
  `claim_evidence_links` 里 `relation='supports' AND effective=1` 的关联——被反证、
  被 detach、被新版本取代的证据不再计数，反证单独算（DESIGN §9.5.4）。
- **来源身份**：`source_identity_hash = sha256(locator + version + content_hash)`，
  标定的是**一份材料**而不是一个位置或实体。（设计里 `tool_output` 还要另存 run/session 作用域，但 `tool_output` 引用**尚未实现**，是后续 spike，见下。）
  同一份材料在一个 Task 内只有一行，`agent_assertion` 被 CHECK 挡在表外（DESIGN §9.5.3）。
- **当前真实可用的证据路径（2026-10-15）**：只有 `execution`（settle 时自动登记）与操作员上传的 `blob`。`tool_output`（按 `{runId, sessionKey, toolCallId}` 持久化并重启后取回原始工具输出字节）**未实现**，需要先 spike 确认宿主能稳定回溯；工具和账本现在都返回 `ref_kind_not_supported`。所以 Watcher 用 `web_fetch` 找到的材料，不能直接挂到 Claim：必须由操作员把材料上传成 blob（`nexus.evidence.upload`，来源组 `user_upload`），再挂到 Claim（`nexus.evidence.link` 或上传时带 `claimId`）。
- **时机**：任何获得新事实或新证据时；watcher 回检时；commit 拿到结果时。
- **四个阶段**：A0 同步初检（读字节前就拒掉跨 owner 的 ref）→ A1 异步**取原始
  `Uint8Array` → 算 hash/identity → 同步事务判三分支**（`reuse_evidence` /
  `attach_live_object` / `new_object`），**只有 `new_object` 才暂存**，
  判定期间字节由调用栈局部变量持有、不拷贝；`new_object` 末尾用一次小同步事务
  登记 `blob_reservations` 并在那里执行软配额 →
  A2 异步 promote 进正式 namespace（最后一次 await）→ B 开一个同步事务，
  重读全部权威状态、原子消费 reservation、再写五张表。
  promote 了但没提交的字节由 `reserved` 的 reservation 占着配额，所以
  反复让 B 失败只能打满自己的软限，打不到插件的 512 MB 硬限。blob store 的 `register`/`lookup` 返回 `Promise`
  （`plugin-blob-store.types.ts:14`）而写事务必须同步（`AGENTS.md:58`），所以 promote
  不可能在事务内。容量受 SDK 的 512 MB 插件总量硬限，owner/Task 配额由我们自己算。
  见 nexus-agent-core-design.md §9.5.1 与 §9.4。
- **数据**：`claim_events`（append-only、按 task 分链、hash chain）是唯一真相，
  `claims` 是当前投影；`claim_event_evidence` 关系表带 owner/task 复合外键；
  证据字节进 `openBlobStore`。
- **完成判定**：`nexus_task_completion_claims` 全部达标才允许 `succeeded`，
  **在 store 层校验**，`nexus_task_update(status:"succeeded")` 直接拒。
- **工作表**：Evidence / Claim Ledger（M2，但决策要引用 claim，建议与 M1 同期）。
- **nexus-agent-core-design.md**：§9。

### 4.8 Watcher（Long-running Task Manager）

- **职责**：几小时后回来看一眼"退款到账了吗"。
- **挂载点**：`api.session.workflow.scheduleSessionTurn`（Cron 驱动一次真实 turn）。
  **不能**在后台直接 `subagent.run`——那个 API 只在 gateway request 期间可用
  （`plugin-sdk/error-runtime.ts:7`）。
- **时机**：排程时写 `scheduler_job_id` + `scheduler_revision`；到点时由 4.2 认证认领。
- **权限**：watcher turn 默认**不得触发 R1/R2/R3**，需要对外动作时只能生成 decision。
  外部内容（邮件、网页、通话转写）视为敌意输入，只进 evidence。
- **恢复**：`ensureScheduled(watchId, revision)` 幂等重建；
  `gateway_start` 兜底重试 `pending_schedule`。
- **风险**：`scheduleSessionTurn` 在整个 `extensions/` 里**没有生产先例** → Stage 0 spike 4。
- **nexus-agent-core-design.md**：§10。

### 4.9 Gateway 接口层

- **RPC**：`api.registerGatewayMethod("nexus.task.list", handler, {scope:"operator.read"})`。
  方法名全局唯一（与 core 冲突会注册失败），一律加 `nexus.` 前缀。
- **事件**：`plugin.nexus-agent-core.task_changed` / `.decision_pending` / `.claim_verified`（事件名不能带 `.`，见 DESIGN §13 Stage 1）。
  **必须从 `api.registerService(...)` 的 service ctx 上 emit** ——那是唯一注入
  `gatewayEvents` 的地方（`src/plugins/services.ts:499`）。无订阅模型，按 scope 广播，
  payload 只带 id + 摘要，客户端回查。
- **Control UI**：`defineControlUiPlugin` + `host.ui.registerPage/Widget`，
  bundled 插件自动加载。若 Nexus 桌面 App 是独立客户端，可以跳过这层，
  直接连 gateway 用 RPC + 事件。
- **工作表**：Nexus extension services WebSocket command/event（M1）。

### 4.10 会话投影与带外回灌

- **`registerSessionExtension`**：只放轻量投影
  `{ activeTaskIds: ["T7"], pendingDecisionCount: 1 }`，
  **不复制 Task 主数据**；用作候选，执行前一律回库确认。
- **`enqueueNextTurnInjection`**：后台产生的进展在用户下次开口时自然带出来，
  而不是硬推一条消息。注意它在提示装配阶段被 drain，且按 runId 缓存。

### 4.11 通知

- OpenClaw **没有**"插件直接发推送"的 API。可用的是
  `enqueueSystemEvent` + `requestHeartbeat`；`question.request` 会触发 web push。
- 待决策、任务完成、`effect_apply_failed` 都走这条路，并同时推 gateway 事件让 App 亮红点。

### 4.12 偏好存储（Personal Context / Preference Store）

- **职责**：存"用户倾向哪个选项"，并且让决策卡片能解释默认值从哪来。
  OpenClaw 有 memory，但那是会话记忆、无结构、无 owner 隔离、读不到优先级，
  当不了可执行偏好的真相源，所以自建。
- **挂载点**：工具（`nexus_preference_get` / `_set`）+ RPC（`nexus.preference.*`）+ 存储层。
  **没有 hook**——偏好不参与任何自动放行路径，这是故意的。
- **时机**：决策卡片渲染默认值时读；Agent 观察到倾向时写 `observed`；
  用户在 App 偏好页改时经 RPC 写 `stated`，或批准一条 `set_preference` 决策（4.4）。
- **读取要带 Task 上下文**：`get` 的 `taskId` 可选——传了只看该 Task 的 `task_exception`
  并回库确认 Task 未终态，不传则**排除所有 exception**。没有这个参数时多个 Task
  的同键例外无法区分（DESIGN §11.3）。
- **数据**：`preferences`（当前投影，带 `revision`）+ `preference_revisions`（append-only）。
  **不进 claim 链**——偏好是可变的主体状态，不是关于世界的事实（DESIGN §11.5）。
- **硬边界**：偏好只能收窄候选集或改默认排序，**不能提升风险档、不能替代 grant**
  （DESIGN §11.1）。`stated` 只能由用户或一条 R0 决策产生，模型写不了。
- **不变量在 schema 里**：`origin` 与 `task_id` / `confidence` / `source_note` 的四条
  CHECK（DESIGN §11.6），防一次实现错误把 Task 例外静默写成 owner 级长期偏好。
- **失败处理**：读不到就当没有偏好，走原本的默认值；绝不因为"偏好缺失"而降级授权检查。
- **工作表**：Personal Context / Preference Store（M2）。
- **nexus-agent-core-design.md**：§11。

### 4.13 Purge Coordinator 与 Blob 回收器

nexus-agent-core-design.md §9.4 的 purge 现在是 P1–P5 的多阶段协议、§9.5.1 的回收是两层状态机，
这两件事都有"谁推进、重启后怎么接上"的问题，所以单独记一个组件。

- **职责**：推进 `nexus.task.purge` 的 P1–P5；回收**重算后引用数确为 0** 的物理对象
  （`live` 与 **`writer_lease_until` 过期的 `writing`** 两条入口）；
  重删 `deleted` 墓碑并为它写缺失证明（收掉 A2 迟到写重新创出来的字节）。
- **挂载点**：没有 hook。入口有三个——`nexus.task.purge` RPC（只做 P1 封口然后排程）、
  `api.registerService` 里的周期 maintenance、以及 `gateway_start`。
- **谁置 `purging`**：只有 `nexus.task.purge` 的 P1 那个同步事务。它是 CAS，
  重复调用不会产生第二个 coordinator。
- **谁执行 P2–P5**：maintenance service 里的单个 worker，按 `purging` 状态**枚举**
  待处理 Task（每个 Task 一个 **`purge_runs`**，记 `purge_id` 与阶段，重试沿用同一个 id），
  再按 **`purge_work_items`** 枚举该 Task 受影响的物理对象，所以
  **gateway 重启后接得上**。v0.12h 写的"按 `purging` 枚举即可"不成立：P3 会把
  `evidence.blob_key` 清空，而 `attach_live_object` 不建 reservation，`blob_objects`
  又没有 task_id，P3 提交后再没有任何地方记着"这次影响了哪些对象"。所以
  P3 把 `(blob_key, generation, refs_released, disposition)` 与"清 `blob_key` +
  扣 `ref_count`"**同事务**写进 `purge_work_items`，并把 run 封成 `workset_sealed`
  （记工作项数，可为 0）。工作集有两种来源：P3 从 `evidence.blob_key` 抄的，和 P2 从该 Task
  未 consumed 的 reservation 抄的（A1/A2 已落地、B 未提交的对象，否则 P5 删掉 reservation
  就失去了与 Task 的最后一条持久关系）；P2 本身是"同步认领 → 事务外回收 → 同步条件 CAS 推
  phase"三小步，不是单个事务；P4 逐条**先重算引用数、改写 `disposition`**（别的 Task 可在
  P3 与 P4 之间 attach 或释放同一对象）再推进到 `absence_verified` / `retained_verified`；
  P4 把工作项置 `absence_verified` 是一个**同步条件更新**（对象仍是带同一 token 的 `deleted` 墓碑才命中），与证明作废的事务互相串行化，不会留下没人驱动的过期终态；P4 的枚举还会捡起 token 已过期的终态项作兜底。P2 写 reservation 来源项是**按物理对象聚合的幂等写**（`ON CONFLICT DO NOTHING`），崩溃重入安全。P5 要求 run 已封口、工作项数相符、全部终态，**且每条 `absence_verified` 项的 proof token
  等于对象当前的缺失证明**（终态只是 P4 某一刻的快照，墓碑复查可以事后作废证明；作废的同一事务
  会把相关项退回 `pending`）、本 Task 无在世 reservation，才动手；所有读写都带
  `{ownerId, taskId, purgeId}`。进度全在表里，没有内存状态。
- **`ref_count` 只是投影**：权威事实是 `evidence.blob_key`
  （`SELECT COUNT(*) FROM evidence WHERE owner_id=? AND blob_key=?`）。P3 更新后同事务
  重算比对、不等整段回滚；P4 的 `→reclaiming` 事务重算；P5 遇不一致走 `cleanup_pending`
  并修复，**不**把 `ref_count > 0` 解读成"别的 Task 在用"；增减都用条件更新校验行数。
- **与普通 GC 共用认领机制**：两者都用同一套 `CAS → 租期 → 新 attempt id 接管`
  （reservation 层与对象层各一套 CAS），所以 purge 与 GC 同时盯上一个对象时
  只有一个能赢，不需要额外的互斥。
- **谁保证 P5 只在字节确实没了之后执行**：前置**不是**"对象进了 `deleted`"
  ——墓碑之后仍可能被 A2 的迟到写重新创出字节。前置是 run 已 `workset_sealed`、工作项数等于 `workset_item_count`，且每条工作项
  都在终态：`shared_retained` 已重算确认仍被别人引用（`retained_verified`），
  `reclaim_pending` 已 `state='deleted'` **且拿到了缺失证明**
  （`absence_verified_at`，并带 `settled_writer_*`：writer 已静默 + 异步确认 store 里查不到该 blob_key）。
  **writer 租期过期 ≠ 写已静默**：租期只撤销数据库授权，取消不了仍在 await 的
  `registerIfAbsent`，而且该方法**没有 `AbortSignal`**。静默的依据只有三种——阶段 B 已提交
  （`committed`，`writing→live` 同事务写入）、同进程 **in-flight writer registry**
  里的**真实 Promise 已 settle**（`awaited`，停止等待包装 Promise 不算），或
  `blob_objects.writer_incarnation` 指向的 `process_incarnations` 行已被标 gone
  （`incarnation_gone`，依赖 `gateway.state.lock` 单进程排他等五条未验证契约（含同进程 service reload 与 boot id 来源），默认关闭）；复查发现字节回来时只作废 `absence_verified_*`（`settled_writer_*` 保留）、再删再重签。
  这个判断在 P5 自己的同步事务里重读一次,不信任 P4 的返回值;条件不满足时
  `nexus.task.purge` 返回 `cleanup_pending`，**不写成功回执**。
  见 nexus-agent-core-design.md §9.4 / §9.5.1。
- **失败处理**：任何阶段失败都停在 `purging`，不写回执、不宣称完成，下一轮重试。
  回执的语义是"引用已摘除、降到 0 的对象已删"，不是"所有相关字节都不存在"。
- **工作表**：无直接对应行；是 Evidence / Claim Ledger 与 Task Manager 的运行期支撑。
- **nexus-agent-core-design.md**：§9.4、§9.5.1。

---

## 5. 三条端到端时序

### 5.1 新建 Task

```
用户: "帮我订 3/12 去东京的机票，我和我太太"
 └ before_prompt_build  清单为空 → 只注入静态协议
 └ 模型 nexus_task_reserve        → operationToken
 └ 模型 nexus_task_create(token,…)  → 服务端去重 → 无命中 → #T7 (clarifying)
 └ 模型追问预算/时段 → nexus_task_update
 └ 事件 plugin.nexus-agent-core.task_changed → App 任务中心出现 #T7
```

### 5.2 跨 session 查询进展（三天后，新会话）

```
用户: "我那个机票怎么样了"
 └ before_prompt_build  注入 "#T7 订东京机票 planning — 已比价 3 个方案"
 └ 模型 nexus_task_get(#T7)      ← 因为清单在上下文里，不会新建
 └ 回复三个方案 + 各自满足/不满足哪些条件 + 还有哪些未知
```

### 5.3 R3 付款：授权与执行分离

```
turn N
 └ 模型 nexus_action_prepare(...)        → actionId（规范化参数，无副作用）
 └ 模型 nexus_decision_request([action]) → ① decision 落盘 + 推 decision.pending 事件
                                            ② user turn 才尝试挂 core 卡片(payment scope)
                                            ③ 若 core 判不可用 → 工具被 block，
                                               但 App 决策页已经能看到这条待决策
 └ 用户批准（core 卡片 或 nexus.decision.resolve，两路竞争同一条 CAS）
      → 同一事务：decision=decided + 签发 action_grant + 预创建 execution(prepared)
      → enqueueNextTurnInjection 通知 Agent 可以 commit 了

turn N+1
 └ 模型 nexus_action_commit(executionId)
      ├ 同步事务：校验归属 → 选定唯一 grant 条件消费 → execution=executing
      ├ 外部 I/O：provider.execute(params_canonical, idempotencyKey)
      └ 同步事务：execution=succeeded|failed|unknown
 └ nexus_claim_add("订单 ABC123 已确认", ASSERTED) + nexus_evidence_add(claimId, 确认邮件 ref)
      └ store：verifier 判定 relation=supports → 投影 → 重算 → SUPPORTED
 └ watch_create("24h 内出票状态变 ticketed")
```

### 5.4 R1：standing grant 的复用

```
首次（需要一次决策建立政策）
 └ nexus_action_prepare → actionId
 └ nexus_decision_request → 用户批准 "可以替我联系这家供应商"
      → 签发 standing_grant（政策：capability=communicate, merchant=X, 有效期, 频率上限）

第二次、第三次（不再打扰用户）
 └ nexus_action_prepare(具体这次要联系谁/说什么) → actionId
 └ nexus_action_authorize(actionId)
      └ 同步事务：重读 standing policy → 校验 capability/recipient/有效期/频率/revision
                  → 签发 prepared execution + provider idempotency key
 └ nexus_action_commit(executionId)
      └ admission CAS 里写 grant_uses（这时才算"用掉一次额度"）
      └ 外部 I/O → settle
```

政策不覆盖这次动作时（换了供应商、超出频率、Task revision 变了），
`nexus_action_authorize` 返回拒绝原因并提示去走 `nexus_decision_request`，
**不会**悄悄放行。

---

## 6. 数据所有权

原则是**一个 aggregate owner 定义这张表的全部写操作**，而不是"只有一处代码会写"——
`decisions` 和 `watches` 都有多条写路径，但它们都由同一个 owner 定义并共用同一条 CAS。

| 表                                                                                       | 唯一写入者                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nexus_tasks` / `nexus_task_steps` / `nexus_task_sessions`                               | Task 管理器（工具层）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `actions`                                                                                | `nexus_action_prepare`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `decision_actions`                                                                       | 决策管理器（4.4）在创建决策时一次写入；此后不变，供授权表的复合外键校验                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `decisions`                                                                              | 决策管理器（4.4）；hook 与 `nexus.decision.resolve` RPC 两条路径共用同一条 `pending → decided` CAS                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `action_grants` / `standing_grants` / `grant_uses`                                       | 授权引擎（4.5）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `action_executions`                                                                      | R2/R3 在签发授权时预创建、R1 由 `nexus_action_authorize` 签发；此后只有 commit 的两段事务改它                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `claims` / `claim_events` / `claim_event_evidence` / `claim_evidence_links` / `evidence` | 账本（4.7）；链接事件 append-only，`claim_evidence_links` 是当前有效投影                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `watches`                                                                                | 排程写 job 信息；**状态转移只由认证 CAS 负责**（4.2）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `preferences` / `preference_revisions`                                                   | 偏好存储（4.12）；`stated` 只由 `nexus.preference.set` RPC 与 `effect_kind='set_preference'` 的决策 resolve 两条路径写，工具写不了                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `blob_reservations`                                                                      | 账本（4.7）：A1 登记 `reserved`、阶段 B 的 new 分支 `→consumed`、回收器 `→reclaiming→abandoned`（两条 CAS 互斥）；未提交字节的配额持有者，**不随 Task 级联删除**                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `blob_objects`                                                                           | 账本（4.7）+ purge coordinator（4.13）：A1 的 `new_object` 分支建 `writing`、阶段 B `writing→live`（同时清空 writer token/租期）、`ref_count` 是 `evidence.blob_key` 的**投影**、只由"写 evidence / 摘 blob_key"的那个事务维护且每次重算、回收器 `live                                                                                                                                                                                                                                                                                                                                                                                   | writing→reclaiming→deleted→缺失证明`（缺失证明带 `settled_writer_*`）。物理 key 带 generation 且永不复用 |
| `purge_runs`                                                                             | purge coordinator（4.13）：P1 与 `purging` 同事务建，一个 Task 一行；记 `purge_id`、阶段、工作项数；P5 校验后销毁                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `purge_work_items`                                                                       | purge coordinator（4.13）：P2 写 reservation 来源项，P3 写 evidence 来源项并与"清 `blob_key` + 扣 `ref_count` + 封 run"同事务写入，P4 重算后改写 disposition 并推进到终态，P5 校验后销毁；以四列外键绑定物理对象；崩溃后靠它枚举受影响对象                                                                                                                                                                                                                                                                                                                                                                                               |
| `process_incarnations`                                                                   | blob 回收器（4.13），**Stage 3 的 migration**：`service.start` 登记一行新 incarnation（带 `process_boot_id`），**登记永不依赖旧行状态**——没有"至多一个当前"的唯一索引，旧行遗留（崩溃）不会卡住服务启动。同事务把 **boot id 不同**的旧行置 gone（崩溃恢复靠这条），同进程 reload 的前任只能自己写 `clean_shutdown`。boot id 来源目前是**两个候选、都不是规范**（A. SDK 暴露只读进程实例 id，upstream 提案、SDK 里现在没有；B. `globalThis[Symbol.for]`），只允许出现在 Stage 0 实验代码里；冻结后只实现选定的一个 `resolveProcessBootId`（无开关、无来源枚举），冻结前 `incarnation_gone` 关闭。`blob_objects.writer_incarnation` 引用它 |
| `purge_receipts`                                                                         | task purge 与 preference purge 两个 RPC（`subject_kind` 区分），故意不对 `nexus_tasks` 建外键                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

---

## 7. 与 OpenClaw 的耦合面（升级时要重新验的清单）

"不改 core"不等于"不依赖 core"。下面每一条都是我们建在上面的行为契约，
OpenClaw 升级后应逐条回归——尤其标 ⚠ 的几条，它们是被实测发现、且没有文档保证的。

| 依赖                                                                                                  | 位置                                                                              | 风险                                             |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------ |
| `before_prompt_build` 能返回 `toolsAllow` / `prependSystemContext`                                    | `hook-before-agent-start.types.ts:37-46`                                          | 低                                               |
| 提示装配内部次序                                                                                      | `run/attempt-prompt-helpers.ts:114-162`                                           | 低                                               |
| ⚠ `before_tool_call` 多插件合并语义（未请求审批时后续可改参/block）                                   | `plugins/hooks.ts:1294-1300`                                                      | **高**——授权不落 hook 的全部理由                 |
| ⚠ hook 返回的 `params` 是浅合并，删不掉字段                                                           | `approval.ts:74-85`                                                               | **高**——commit 只收 `executionId` 的理由         |
| ⚠ `onResolution` 是 fire-and-forget，且拿不到 approval id                                             | `approval.ts:112`，测试 `e2e.test.ts:3147`                                        | **高**                                           |
| ⚠ 审批面不可用时 core 直接 block 工具 + 回调无区分度的 `"cancelled"`                                  | `approval.ts:185-196`、`272-283`                                                  | **高**——决策页必须是主路径的理由                 |
| `requireApproval` 无 `detail`，title 80 / description 512                                             | `hook-before-tool-call-result.ts:18`、`plugin-approvals.ts:86-87`                 | 中                                               |
| approval scope 只有 4 种，**无 booking / contact**                                                    | `gateway-protocol/schema/approvals.ts:77-107`                                     | 中                                               |
| `ctx.trigger ∈ {cron, heartbeat, user}` 且 cron turn 带 `ctx.jobId`                                   | `hook-types.ts:243,299`、`cron/isolated-agent/run-executor.ts:541`                | 中                                               |
| ⚠ `scheduleSessionTurn` 返回 job handle，但**无生产先例**                                             | `plugin-api.types.ts:128`、`host-hooks.ts:224`                                    | **高**                                           |
| `openKeyedStore` / `openBlobStore` 限 trusted（bundled 满足）                                         | `plugins/registry-runtime.ts:242`                                                 | 中                                               |
| 写事务必须同步                                                                                        | `AGENTS.md:58` / `CLAUDE.md:58`                                                   | 中                                               |
| `registerGatewayMethod` 方法名全局唯一                                                                | `registry-registrars-network.ts:62-75`                                            | 低                                               |
| `gatewayEvents` 只在 service ctx 上                                                                   | `plugins/services.ts:499`                                                         | 低                                               |
| `subagent.*` 只在 gateway request 期间可用                                                            | `plugin-sdk/error-runtime.ts:7`                                                   | 中                                               |
| ⚠ 能按 `toolCallId` 取回**原始**工具输出字节（§4.7 证据引用的前提）                                   | Stage 3 开工前待验证                                                              | **高**——拿不到就只剩 `execution`/`blob` 两种引用 |
| ⚠ blob 容量硬上限 512 MB/插件（跨 namespace 汇总）、单条 100 MB、namespace 须是 ≤128 字节的安全路径段 | `plugin-blob-store.sqlite.ts:36`、`:400`、`:451`；`plugin-store-validation.ts:72` | **高**——产品的证据容量承诺直接受它约束           |

**T6（工具旁路）不在这张表里**，因为它不是耦合面而是承重假设：
Agent 手里的 `browser` / `exec` / 渠道发送可以绕开 `nexus_action_commit`，
我们只有 `toolsAllow` 收窄 + 启发式拦截这两层缓解。见 nexus-agent-core-design.md §14。

---

## 8. 目录结构

```
extensions/nexus-agent-core/
├── openclaw.plugin.json      # contracts.tools / activation.onStartup / configSchema / controlUi
├── index.ts                  # definePluginEntry：装配下列模块
├── nexus-agent-core-design.md                 # 为什么这么设计（含威胁模型、被推翻的假设）
├── nexus-agent-core-architecture.md           # 本文：组件、挂载点、时机
├── src/
│   ├── prompt/               # 4.1 注入器 + 4.2 watcher 认证（同一个 hook handler）
│   ├── task/              # 4.3 Task 工具与状态机
│   ├── decision/             # 4.4 决策管理器（含 core approval 尝试与降级）
│   ├── grant/                # 4.5 授权引擎
│   ├── execution/            # 4.6 admission 状态机与对账
│   ├── ledger/               # 4.7 claim / evidence / hash chain
│   ├── watcher/              # 4.8 排程、ensureScheduled、gateway_start 对账
│   ├── preference/           # 4.12 偏好存储（无 hook，只有工具/RPC/store）
│   ├── gateway/              # 4.9 RPC 注册 + change-events service
│   ├── store/                # SQLite worker、schema、migration（照抄 workboard 模式）
│   └── notify/               # 4.11
├── spikes/                   # Stage 0 的可执行观察/回归脚本（无依赖，node 直接跑）
│                             # （运行时观测代码在 src/spikes/，由 spikesEnabled 开关控制，见 DESIGN §13）
│   └── grant-rotation-sqlite.mjs   # 222 项 SQLite 约束回归：grant 轮换、复合外键、
│                                    # 唯一索引 NULL、run_triggers owner 隔离、
│                                    # outbox CAS、core approval 租约；第 11 组直接
│                                    # 执行 nexus-agent-core-design.md §6.3 的 SQL，验建表可行、
│                                    # 父表/父键合法、命名契约（表+列+索引无 journey）；
│                                    # 第 12 组验偏好表的 origin 不变量（含负例），
│                                    # 第 13 组验 decision effect_kind 与证据来源去重
├── skills/                   # 供 Task / Booking / Moneywise 子 Agent 渐进加载
└── browser/                  # 可选：Control UI 页面与挂件
```

---

## 9. 分期与本文的关系

| Stage            | 上线的组件                                                                                                                                                                           |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stage 0（spike） | 只做观察，不落表：**4.4 的 core approval 耦合面（spike 2，优先）**、SQLite runtime 与同步事务约束（spike 1）、**4.7 的 blob 容量与命名契约（spike 3）**、4.8 的排程可行性（spike 4） |
| Stage 1          | 4.1 + 4.3（task 部分）+ 4.9（task RPC/事件）+ 存储层                                                                                                                                 |
| Stage 2          | 4.4 + 4.5 + 4.6（先接假工具与假供应商，R1 与 R2/R3 两条路径都要走通）                                                                                                                |
| Stage 3          | 4.7 + 4.13（purge coordinator 与回收器，与账本同期落地）                                                                                                                             |
| Stage 4          | 4.2 + 4.8 + 4.10 + 4.11 + 4.12 + Control UI                                                                                                                                          |

详见 nexus-agent-core-design.md §13。
