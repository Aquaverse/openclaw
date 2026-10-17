# Nexus Agent Core Plugin: Stage 2 阶段性总结（2026-10-12，10-13 / 10-14 更新）

位置：OpenClaw fork `extensions/nexus-agent-core/`（DESIGN.md §8.7 与 §13 有逐项观察记录）。约束不变：不改 OpenClaw `src/`；工具前缀 `nexus_`；插件不写自己的代码目录，数据只进状态目录。Stage 2 = Decision + Grant + Execution，验收在 **dev 网关**完成；**10-14 起 pkg 安装产物也已回归通过**（见 `nexus-agent-core-pkg-regression.md`）。

## 一、Stage 2 完成项

**存储**：迁移 `stage2-0001-decision-grant-execution`，9 张新表（actions、decisions、decision_actions、action_grants、standing_grants、action_executions、grant_uses、run_triggers、outbox），不 ALTER 已发布表。

**工具（4 个，direct-only，需 `tools.alsoAllow`）**：`nexus_action_prepare / authorize`、`nexus_decision_request`、`nexus_action_commit`。commit 只收 executionId。

**RPC（7 个）**：`nexus.decision.{list,get,resolve}`、`nexus.execution.{list,reconcile,resolve}`、`nexus.grant.{list,revoke}`。`execution.resolve`：人工终结 provider 查无记录的 `unknown`（或超时的 `executing`），note 必填，`failed` 前先只读 lookup，绝不调用 provider 写接口。10-14 起步骤日志带操作者与 note（「人工终结为成功/失败」）；`nexus.task.get` RPC 也带 `pendingDecisions` / `readyExecutions`。

**事件**：`plugin.nexus-agent-core.decision_changed / execution_changed`，经 outbox 至少一次投递；`execution_ready` 另会向对应会话注入下一轮通知（已在 dev 验证，日志 `nexus: execution_ready injection … enqueued=`）。

**核心语义**：

- commit = admit（同步事务）→ provider.execute → settle（同步事务），外部调用不在事务里。
- `unknown` 绝不重放；对账是只读 lookup，只有查到才落定，查不到保持 `unknown`；并发 commit 只写一次。
- 重试边界由状态机保证：stale `executing` 在供应商支持幂等时至多自动重试**一次**（同 key），结果不确定则转 `unknown` 并只对账；不支持幂等时永不重发，只对账或由人工终结。
- core approval 只是一次尝试：取消/超时不改决策（决策仍 pending，可在决策页批准）；Deny ⇒ denied。批准 ≠ 执行。
- 先到先得：决策一旦在决策页（RPC）或卡片上定下，之后另一边的点击只记 `already_resolved`，不改写决策。在此之上有两条安全规则（10-13 定案、实现并在 dev 验证）：① 已批准、执行尚未开始（execution 仍 `prepared`、grant 未消费；standing 决策则尚无 `grant_uses`）时，卡片上迟到的 **Deny 撤销**该 execution（置 `failed`，`late_deny_revoked`）与未消费的 grant；已开始执行/已使用的只记录。② 迟到的 **Allow 永不升级**已拒绝的决策。每次迟到点击都写一条步骤日志。
- R1 用 standing grant（授权幂等、`grant_uses` 只在 commit admit 时写、maxUses/maxUsesPerDay/24h TTL、可 revoke）；R2/R3 用一次性 action_grant，批准时签发 prepared execution。
- 事项状态由执行/决策派生：executing > awaiting_decision > planning。
- 假供应商（幂等可切，四种模式 ok / reject / drop_before_send / drop_after_success）+ 账本 `fake-provider.jsonl`；风险档仅假工具：vendor_message=R1，booking=R2，payment=R3。
- 确认页在授权前展示当前 entities，要求用户逐项确认。

**配置与默认值**：`decisionsEnabled`、`fakeProviderIdempotent`、`fakeProviderMode`、`coreApprovalEnabled`、`approvalTimeoutMs`（dev 建议 120000；做迟到点击测试时用 300000）。

- **改配置不需要重启网关**（10-13 在 dev 实测，见下）；但改 `fakeProviderMode` 后在安装版上跑故障探针前，保险起见重启网关。
- **默认全关**：manifest `enabledByDefault:false`，`tasksEnabled` / `decisionsEnabled` / `spikesEnabled` 默认 false，因为 Stage 2 只接假供应商，不应随包默认开启。`fakeProviderIdempotent`(true)、`fakeProviderMode`(ok)、`coreApprovalEnabled`(true) 的 schema 默认就是 dev 用的值，不必手设；`approvalTimeoutMs` 默认 600000。`openclaw plugins enable` 只负责让宿主加载插件，不会打开功能开关。
- 工具是 optional tools，必须经 `tools.alsoAllow` 放行（宿主机制）。
- **决定（10-13）**：默认值等真实 provider 方案定下后再定，或由安装器按"开发版/正式版"两种配置分别写入；现在不改 manifest。
- 旧 manifest 的 schema 是 `additionalProperties:false`：向仍是 Stage 1 的旧安装包写 `decisionsEnabled` 会被配置校验拒绝，须先装上含 Stage 2 的新包。

**测试**：decision-kernel 57→61、decision-flow 37→38、kernel 20、task-tools 17、rpc 6、prompt-events 8、相似度 10、令牌 5（Stage 3 之后的总数见各切片文档）；spike 回归 213 项（Stage 3 之后 219）。探针脚本 `spikes/`：listen-task-events、concurrent-commit（可用 `--task` 自己准备执行）、r1-flow（20 项）、fault-modes（含 `--stop-after-commit`，用于 kill -9 测试）。三个脚本默认连 `ws://127.0.0.1:19001` 与 `~/.openclaw-dev`，连其他网关（安装版 18789、`~/.openclaw`）用 `--url` / `OPENCLAW_GATEWAY_URL`、`OPENCLAW_GATEWAY_TOKEN`、`OPENCLAW_STATE_DIR`。绕过模型的调试：`gateway call tools.invoke --params '{"name":…,"args":{…}}'`。`decision.list` 的参数是 `statuses` 数组。VM 里没有 vitest，用 `nxsync.sh <测试文件>`（把 src 镜像并改成 node:test 运行）。

**验收中发现并修掉的问题**：模型给 optional `kind` 填自由文本（"booking" 或 ""）导致整条 decision_request 被拒，改为忽略未知 kind，并把 R2/R3 的 next 提示写成完整示例调用；事件 emitter 类型包装；重复 commit 输出误读与 concurrent-commit 分类错误（脚本修正）；迟到的卡片 Deny 不撤销已批准但未执行的凭证（10-13 发现，已改并在 dev 复测）。

## 二、已验证

**真实 dev 网关**：卡片（只有 Allow once/Deny，timeoutMs 600000 被接受，回调值 allow-once）；批准≠执行；Deny；unknown 与自动对账；正常成功；服务端重放；伪造/非法 executionId 被拒；并发 commit（6 路只写 1 次）；RPC 批准后卡片被宿主取消；run 中止后经 readyExecutions 恢复；事件订阅（含 execution_settled）；R1 standing grant 端到端；三种故障模式 reject / drop_before_send / drop_after_success；失败后重新批准得到新 grant 与 execution 并 commit 成功；`execution.resolve`（缺 note 被拒、终结后账本不变、终结最后一个 unknown 后事项回到 planning）；任务带多次网关重启后数据与步骤完整。

**10-13：`execution_ready` 注入下一轮**。卡片 2 分钟无人点击 → 工具报 `Approval timed out`，决策仍 pending；用错 decisionId 得到 `already_resolved`（无副作用、无注入）；用对的 id 批准后日志 `enqueued=true`；用户只发「好了，继续」，模型直接 commit 成功。此前对话中没有出现过该 executionId，所以只能来自注入（间接证据）。

**10-13：迟到点击**。

- A1 改动前（RPC 先批准，卡片再点 Deny）：宿主让工具调用失败（"Denied by user… final"），Nexus 记 `already_resolved`；决策仍 approved，prepared execution 仍可 commit。模型对用户说"审批被拒绝、没有预订"，与库内状态相反。
- A1 改动后（迟到 Deny 撤销，决策 `DRQRHH1A6AA`）：网关日志 `late core approval click … revokedExecutions=XMB5TCKDVBH`；execution 变 `failed`（`late_deny_revoked`，`attempts:0`）；grant `revokedAt` 有值、`consumedAt` 为空；账本不变；commit 该 id 返回 `execution_failed` 且不调用供应商；步骤日志有「迟到的卡片拒绝：决策此前已批准，已撤销尚未执行的凭证」；模型对用户说"已拒绝"，与库内一致。
- A2（RPC 先拒绝，卡片再点 Allow once）：记 `already_resolved`；决策仍 denied，没有任何 execution，账本不变；宿主放行后模型如实告知"审批已被拒绝"。

**10-13：kill -9 恢复**。

- K1：待决策 + 卡片开着时杀网关，重启后决策仍 pending（`startup reconciliation pendingDecisions=1`），可 RPC 批准；`coreApprovalState` 孤儿停在 `attempted`。宿主在重启后给被打断的那轮显示 "restart recovery… asked the agent to resume"，模型自动用 `nexus_task_get` 核实审批仍待决定。
- K2：已批准待提交时再杀，重启后同一 executionId commit 成功，账本恰好 +1。
- K3：`drop_after_success` 得到 unknown 后立即杀，重启 `unfinishedExecutions=1`，后台自动对账落定 succeeded，账本该键仅一行，无重放。

**10-13：`fakeProviderMode` 热更新（dev，不重启网关）**。`config set …fakeProviderMode '"reject"'` → 日志 `[reload] config hot reload applied (…fakeProviderMode)`；随后 `fault-modes --mode reject` 全部通过（拒绝 ⇒ `execution_failed`，账本不变 14 行）。改回 `ok` 同样不重启 → `r1-flow` 20 项全部通过（standing grant、第 4 次被拒、撤销后不再签发）。**机制**：热重载 = 对该插件重新 register 并重跑启动对账（日志依次为 `register: mode=full` → `startup reconciliation pendingDecisions=… unfinishedExecutions=0 …` → `register: mode=discovery`），不是原地读新配置；因此启动对账与 outbox 恢复必须幂等（本次未见异常）。

**10-13：VM 测试补齐（未上 dev 网关）**。

- `executing` 重试边界：非幂等 + 崩在供应商处理之后（commit 只 pending_confirmation，tick 查到后落定，写 1 次）；非幂等 + 崩在调用之前（保持 executing、永不重发，未过期不可人工终结，过期后可 `resolve failed`）；幂等 + `drop_after_success`（自动重试仅 1 次，随后 unknown 且 attempts 不再增加）。
- 注入边角：宿主抛错 → 退避重试、同 idempotencyKey、`ttlMs=3600000`；宿主返回 `enqueued:false` → 记日志、不无限重试、`readyExecutions` 仍可见；无 sessionKey 的决策不注入。宿主侧的真实去重与 TTL 过期无法在插件内观测。
- 第三方 `before_tool_call` 合并：对照 `src/plugins/hooks.ts` 的 `mergeResults`（已有 requireApproval 则后续 params 被丢弃、block 粘滞、先到先得），模拟宿主按同一规则覆盖三种篡改；未写真实第二插件。

**10-14：pkg 安装产物回归**。新包 `2026.9.4 (18f7662)` 上：`r1-flow` 20 项、`concurrent-commit --task`（6 路只执行 1 次）、`fault-modes` 三种模式全部通过；随后在 `2026.9.4 (9b0ac3f)`（= HEAD）上 Stage 3 三个探针全部通过。详见 `nexus-agent-core-pkg-regression.md`。

## 三、Stage 2 待改进 / 待验证

**待验证**：

1. 热重载瞬间若有 commit 处于 `executing`：未实测，靠状态机兜底（stale executing ⇒ 至多一次同 key 重试或 unknown）。
2. **安装版上的卡片流（注入、迟到 Deny）与 kill -9 恢复（K1–K3）未重做**：pkg 回归只覆盖了探针（RPC / 工具路径）；卡片和宿主交互部分仍只在 dev 验过。可选。
3. `execution.resolve` 的 `provider_has_record` 分支与 `succeeded` 断言、standing 决策的迟到 Deny 撤销、上面"VM 测试补齐"各项，只有 VM 测试，未上 dev 网关。
4. kill -9 后 `readyExecutions`（工具 `nexus_task_get`）是否仍列出 prepared execution（RPC `nexus.task.get` 10-14 起也返回该字段，VM 测试已覆盖，真实 kill -9 后未观察）。
5. 第三方 hook 真实合并（真实第二插件）：价值低于成本，暂不做；`hooks.ts` 合并规则变动时重新对照。

**构建经验（mac:installer）**：SwiftPM 依赖是 `--mirror` 完整克隆，弱网下会久拖或连接停住；被中断的构建会留下 PPID=1 的孤儿 `git clone` 和半截缓存目录，重跑前先 `ps -ef | grep 'git clone'` 清理并删除对应的缓存目录；同一时间只能跑一个构建；可用 `GIT_HTTP_LOW_SPEED_LIMIT=10000 GIT_HTTP_LOW_SPEED_TIME=30` 与 `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1` 让停住的连接快速失败（只对单次命令生效，未确认对所有子进程传递）。打包命令：`ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer`；**先提交、后打包**，版本号才等于 HEAD。

**设计层面的局限 / 改进项**：

- 孤儿 `coreApprovalState=attempted`（kill -9 后卡片已不存在）：**决定不在启动时批量改写**，设计内出口是租约过期后再次 `nexus_decision_request` 接管；Stage 3 切片①已用 `process_boot_id` 实现"只对其他 boot id 的 attempt 立即置回 `not_attempted`"。
- 宿主 reply-run 的"无活动"保护（约 5–6 分钟）会取消插件审批，core approval 的存活时间受 run 约束，不受 `approvalTimeoutMs` 约束；决策页批准不受影响。
- 卡片超时后宿主给模型的错误只有 "Approval timed out"，不带 decisionId；用户要靠 `nexus_task_get` 的 `pendingDecisions` 或 `decision.list` 找到该批哪一条。
- 有 prepared execution（已批准待提交）时事项状态仍显示 planning，因为 busy 只计 executing/unknown；待办靠 `readyExecutions` 暴露，UI 需单独展示（RPC 已补）。
- 注入一旦被宿主拒绝（`enqueued:false`）就不再重试，Agent 只能靠 `nexus_task_get` 发现 `readyExecutions`。
- 模型会凭空补字段、自由命名 kind、失败后可能谎报；靠确认页 + 服务端校验兜底，提示词管不住。
- 人工终结的操作者字符串固定为 `operator:nexus-console`（RPC 上下文里没有可信操作者身份）。
- Stage 2 只接假供应商；真实 provider 的幂等与对账语义需另设计。
- 风险档目录只覆盖假工具；真实工具分级未定。

## 四、五个子任务完成情况

| 子任务                                 | 状态                                                           | 说明                                                                                                                                                                                                         |
| -------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1. WebSocket command/event             | Tasks + Decision/Execution/Grant + Claim/Evidence/Purge 域完成 | Stage 2 的 RPC 与事件已在 dev 与 pkg 验证；Stage 3 增加 claim / evidence / purge 的 RPC 与 `claim_changed` / `claim_verified` / `evidence_changed` / `task_purged` 事件；Watch / Preference 的命令和事件未做 |
| 2. Task / Workflow Manager             | Task 部分完成，Workflow 部分有雏形                             | 存储、去重、会话绑定、软删除、abort、搜索 + 事项状态派生 + 步骤日志已落地；completion claim 把关与 purge 在 Stage 3 完成；多步编排、后续推进未做                                                             |
| 3. Human Decision / Approval           | 核心完成                                                       | 决策、core approval 卡片、决策页批准、注入下一轮、迟到点击、kill -9 恢复、热更新、grant、执行与对账、人工终结、重放保护均已在 dev 验证，pkg 探针回归通过；尚缺：真实 provider、安装版卡片流                  |
| 4. Evidence / Claim Ledger             | Stage 3 完成                                                   | 见各 Stage 3 切片文档；dev 与 pkg 均通过                                                                                                                                                                     |
| 5. Personal Context / Preference Store | 仅设计                                                         | 待 Stage 4；`set_preference` 目前被明确拒绝为不支持                                                                                                                                                          |

## 五、下一阶段工作项

**Stage 2 收尾**：（可选）安装版卡片流与 kill -9 恢复；默认值与安装器的开发版/正式版配置分流，等真实 provider 方案定下后再决定。

**Stage 3：Evidence / Blob / Purge** — 已完成（切片①②③ + 小缺口收尾，dev 与 pkg 回归通过）。遗留：`tool_output` 引用需先做 spike；verifier 目前只认 `executed` 与操作员声明的 relation；`incarnation_gone` 启用清单待操作员确认（开关保持 off）。

**Stage 4：Watcher / UI / Preference / Handoff（子任务 1、2、5 收尾）**

1. Watcher：cron / heartbeat 触发的轮次（当前 fail-closed，不弹卡片）。
2. 决策页 / Nexus UI：待决策列表、执行与对账状态、unknown 人工终结入口、grant 管理、证据查看（`nexus.evidence.handle/read` 已就绪）。
3. Preference store 与 Personal Context；`set_preference` 决策类型。
4. Handoff：跨会话/跨设备接手事项。
5. 多步 Workflow 编排。
   （注：Stage 4 的 Watcher、UI、Preference 已完成，见 stage4-summary；Handoff 与 Workflow 仍未设计。）

**并行尾巴**：Stage 1 遗留的真实去重往返、`task_closed` 被拒、`updated` 事件单独观察；DESIGN 版本号与变更日志升级；`ARCHITECTURE.md` 核对；真实 provider 接入方案（幂等键、对账接口、风险分级目录）单独立项。
