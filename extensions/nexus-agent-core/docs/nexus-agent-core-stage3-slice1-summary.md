# Nexus Agent Core Plugin: Stage 3 切片①（Claim / Evidence 账本 + boot id）阶段性总结（2026-10-13）

位置：OpenClaw fork `extensions/nexus-agent-core/`，分支 `nexus-plugin`（nexus-agent-core-design.md Stage 3 一节「切片①落地记录」与 §14「切片①留下的缺口」有逐项说明）。约束不变：不改 OpenClaw `src/`；工具前缀 `nexus_`；插件不写自己的代码目录。

## 范围（用户 10-13 选定：只做①）

只做账本与 boot id。Blob 字节存储（②）与 Purge（③）是后续切片。开关：`claimsEnabled`（默认 false，**需要 `decisionsEnabled`**，因为账本通知走决策模块的 outbox）。状态：**代码完成，VM 与 dev 网关验收通过（2026-10-13）**；pkg 回归与 Stage 2 一并等新包能构建后再做（已装的包仍是 Stage 1 旧包，不要在上面开 `claimsEnabled`）。

## 做了什么

- **迁移** `stage3-0001-claim-evidence-ledger`：只追加八张表——`claims`、`claim_events`、`claim_event_evidence`、`claim_evidence_links`、`evidence`、`nexus_task_completion_claims`，以及 `evidence` 外键要指向的 `blob_objects`、`process_incarnations`（本期建表不用，已发布的表不能 ALTER）。SQL 与 DESIGN §6.3 两段逐字一致，回归第 11 组校验并叠加。
- **三个工具**（direct-only，需 `tools.alsoAllow`）：`nexus_claim_add`（Agent 只能写 ASSERTED / UNKNOWN，可登记完成条件，只能升不能降）、`nexus_evidence_add`（只收 `ref.kind="execution"`；`tool_output` / `blob` 返回 `ref_kind_not_supported`）、`nexus_claim_verify`（只读）。
- **状态由 store 推导**：有效 `supports` 的 distinct `source_group` ≥ 2 → VERIFIED，≥ 1 → SUPPORTED；只有 contradicts → REFUTED；两边都有 → UNKNOWN；`nexus.claim.retract` → 粘性 REFUTED；`unclassified` 不计入任何一边。关系判定规则 v1 只认谓词 `executed`。
- **完成判定**：`claimsEnabled` 下 `nexus_task_update(status="succeeded")` 可用，store 在同一事务检查完成条件；没有完成条件或有未达项 → `completion_unmet`。
- **settle 钩子**：commit 结算（含对账、人工终结）在同一事务里自动写 `execution:<id>` 的 `executed` claim 与证据；钩子包在 SAVEPOINT，失败只丢账本、不让结算失败。
- **digest 链**：每个 Task 一条 `claim_events` 链，`nexus.claim.verifyChain` 重算。
- **RPC**：`nexus.claim.list / get / verifyChain`（read）、`retract / unlinkEvidence`（write，运维专用，Agent 没有对应工具）。事件 `claim_changed` / `claim_verified`（outbox 至少一次）。
- **boot id**：唯一入口 `src/process-boot.ts`（`<pid>:<OS 启动时间>`，读不到则 `unavailable`，不编造）；决策运行时 worker id = `nexus@<bootId>#<随机>`；`reconcileOnStart` 只把**其他进程**留下的孤儿 `attempted` 立即退回 `not_attempted`（同进程热重载、`unavailable`、旧格式 worker id 一律不动）；`service.start` 登记 `process_incarnations`，`stop` 写 `clean_shutdown`；`incarnation_gone` 仍关闭。
- **提示词**：`claimsEnabled` 时追加「Nexus 断言协议」。

## 测试（Linux VM，`node:sqlite`）

kernel 20、decision-kernel 61（含 4 条孤儿 attempt）、task-tools 17、prompt-events 8、decision-flow 37、**claim-flow 16（新）**、**process-boot 2（新，含"全仓只有一处引用 SDK 启动时间助手"的静态扫描）**、tokens 5、similarity 10；回归脚本 215/215；`tsc --noEmit` 只剩 VM 缺 openclaw 构建声明的老报错。测试夹具已抽成 `src/test-support/decision-world.ts`，decision-flow 与 claim-flow 共用。新增 dev 探针 `spikes/claim-flow.mts`（不经模型，约 35 项 PASS/FAIL），`listen-task-events.mts` 增订 `claim_changed` / `claim_verified`。

## dev 网关验收（2026-10-13，通过）

- 启动日志 `claimsEnabled=true`、`orphanAttemptsReset=0 bootId=…`；迁移三行；incarnation 登记。
- `claim-flow.mts` 全部 PASS：claim 状态 SUPPORTED×2 / REFUTED×1，`verifyChain` ok（10 条，seq 连续），证据行 `blob_key` 为空，事件只带 id 与状态。首次运行因探针用裸 `sqlite3` 读库撞上网关写入报 `database is locked`（探针问题，已加 busy timeout 与重试），插件无问题。
- 监听收到 10 条 `claim_changed`、无 `claim_verified`（符合预期）。`r1-flow` 20/20，Stage 2 未被破坏。
- 真实模型：commit → claim_verify → evidence_add（SUPPORTED）→ task_update(succeeded) 被接受；无完成条件时 `tools.invoke` 直接标完成被 `completion_unmet` 拒绝。第一次对话模型把日期写成「12 月 1 日」被 `fake_booking` 的 ISO 日期校验拒绝并如实询问年份，是 Stage 2 参数校验在工作。
- kill -9：同进程热重载 `orphanAttemptsReset=0`，强杀重启 `=1`，孤儿卡片立即回 `not_attempted`，重启后再发决策请求立刻弹新卡；被杀进程的 incarnation 行 `gone_at` 仍为空，`incarnation_gone` 保持关闭。
- 关 `claimsEnabled`（热更新）：`nexus_task_update(succeeded)` 回到 `status_not_allowed`，账本数据不动；改回 true 生效。

## 已知缺口（DESIGN §14 同步）

- verifier 只认 `executed`，其他谓词永远 ASSERTED（不会被误判成 SUPPORTED）。
- 真实工具走不到 VERIFIED：execution 证据按供应商分组（`agent_call:<provider>`），同一供应商多次仍是一组；需要②的 blob/tool_output 证据，或人工终结（`operator_attestation`）加一次正常执行挂在同一条未限定 actionId 的 claim 上。VERIFIED 的计数只有单测（注入第二组），没有端到端覆盖。
- `claimsEnabled` 依赖 `decisionsEnabled`，单开会 warn 并保持关闭。
- settle 钩子失败只记不报，没有补账任务。
- `unavailable` boot id 下孤儿 attempt 不会立即重置，回到 Stage 2 的租约行为。
- 模型仍可能给 `fake_booking` 填不完整的参数（如缺年份）；服务端校验兜底，提示词不强行让模型补全。

## 下一步

1. pkg 新包构建与 Stage 2 + Stage 3 回归（网络恢复后）。
2. 切片②：Blob 字节存储、`blob_reservations`、`tool_output` / `blob` 证据、配额与 GC（做完才有第二个来源组，VERIFIED 才能端到端验证）；切片③：Purge 与 `incarnation_gone` 启用清单。
3. 悬而未决：默认值与安装器的开发版/正式版配置分流（等真实 provider 方案）。
