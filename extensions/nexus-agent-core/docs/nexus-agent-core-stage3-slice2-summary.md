# Nexus Agent Core Plugin: Stage 3 切片②（Blob 字节存储 + 操作员上传）阶段性总结（2026-10-13）

位置：OpenClaw fork `extensions/nexus-agent-core/`，分支 `nexus-plugin`（DESIGN.md Stage 3 一节「切片②落地记录」与 §14「切片②留下的缺口」有逐项说明）。约束不变：不改 OpenClaw `src/`；工具前缀 `nexus_`；插件不写自己的代码目录。

## 范围（用户选定）

「blob 引用 + 操作员上传 RPC」+「按设计完整实现」。`tool_output` 引用、读取句柄、Purge 留给后续。开关：`evidenceBlobsEnabled`（默认 false，需要 `claimsEnabled`）。状态：**VM 与 dev 网关验收通过（含 kill -9 崩溃恢复），Mac 静态检查通过（2026-10-13）**；pkg 回归仍待做（已装的包是 Stage 1 旧包，不要在上面开新开关）。

## 做了什么

- **迁移** `stage3-0002-blob-reservations`：只追加 `blob_reservations` 与两个索引，SQL 与 DESIGN §6 逐字一致；回归脚本 217/217（新增第二批断言）。
- **四阶段拆分**：内核在 SQLite worker 线程同步运行，字节 I/O 在主线程异步，所以 A0 `blobPrecheck` / A1 `blobPlan` / B `blobAdmit` 是同步内核方法，哈希、暂存、A2 `registerIfAbsent`（键 `<hash>.<generation>`，最后一次 await）在异步服务里。限额与租约由调用方传入。
- **状态机**：`blob_objects` writing→live（按 `writer_attempt_id` CAS）；`blob_reservations` reserved→consumed。回收先认领 reservation（需 reservation 过期且写者租约过期），再认领对象，事务外删字节，最后结算为 `deleted` 墓碑；过期的 reclaim 租约用新 attempt id 接管。
- **墓碑复删**：字节重新出现则撤回"不存在"证明；证明只在 `committed` 或 `awaited`（本进程写者 Promise 已 settle）时给；`incarnation_gone` 仍关闭。
- **零引用扫描**：以 `evidence.blob_key` 的真实计数为准，不信 `ref_count` / `content_hash`，并有宽限期。
- **来源与 relation**：上传来源组 `user_upload`（kind `uploaded_file`，locator `upload:<name>`，版本缺省 `content:<hash>`）；Agent 挂 blob 继承第一次登记的来源事实。**relation 永远不是 Agent 入参**：Agent 挂的 blob 是 `unclassified`，只有操作员声明（upload 带 `claimId` 或 `nexus.evidence.link`）才是 supports / contradicts（规则版本 2），操作员可升级先前的 `unclassified`。这样 `agent_call:<provider>` + `user_upload` 两个来源组即可端到端到 VERIFIED。
- **软配额**：Task 200 MB / owner 400 MB / 单条 16 MB（可配）。超限 fail closed，并生成 R0 `acknowledge` 决策（`evidence_quota`，去重），单条超限不发卡片。
- **命名空间**：`nexus-ev-<sha256(owner)前32hex>`（reject-new，512 MB）与 `nexus-stg-<…>`（evict-oldest，128 MB，10 分钟 TTL）。
- **RPC**：`nexus.evidence.upload / link / maintain`（write）、`list / stats / reconcile`（read）；事件 `evidence_changed`。工具白名单不变（13 个）。
- **生命周期**：gateway 启动时 reconcile + maintain，之后每第 4 个 15 秒 tick 跑 maintain；`stop()` 排空在途写者（3.5 秒），仅排空成功才写 `clean_shutdown`；boot id 读不到时 incarnation 以 `unavailable` 登记。
- **新配置**：`evidenceBlobsEnabled`、`evidenceTaskQuotaBytes`、`evidenceOwnerQuotaBytes`、`evidenceMaxUploadBytes`、`evidenceWriterLeaseMs`、`evidenceReservationTtlMs`、`evidenceDebugDelayAfterA2Ms`（仅 dev，用于崩溃测试，测完必须恢复默认）。（注：`evidenceDebugDelayAfterA2Ms` 已在 2026-10-15 审查后从 manifest 删除，改为环境变量 + `spikesEnabled`，见 stage3-4-overview 第七节。）

## 测试

Linux VM（`node:sqlite` + 假字节存储）：kernel 20、decision-kernel 61、task-tools 17、rpc 6、prompt-events 8、claim-flow 16、**evidence-flow 31（新）**、process-boot 2、decision-flow 37、tokens 5、similarity 10；回归 217/217；`src/` 零改动。evidence-flow 覆盖迟到的 A2 写入与删除、崩溃接管、配额与卡片去重、跨 Task 挂载、篡改/缺失检测、reconcile、RPC 校验、relation 升级，以及"reservation 过期但写者租约未过期不可回收"（变异检查后补）。

Mac：`pnpm test:extension nexus-agent-core` 14 个文件 / 237 条通过；`pnpm tsgo:extensions` 与 `oxfmt --check` 通过（`tsgo` 开着 noUnusedParameters，发现 `createBlobLedger` 多余的 `db` 参数，已删）。

## dev 网关验收（2026-10-13，通过）

- `spikes/blob-flow.mts main`：全部通过（上传 / 复用 / Agent 挂载 `unclassified` → 操作员 link / `agent_call` + `user_upload` 端到端 `VERIFIED` / 完成判定 / 结束后拒绝上传 / digest 链）。首跑两处 FAIL 是探针自己多登记了一条从未挂证据的完成条件，已修探针。
- 回归：`claim-flow.mts` 通过；`r1-flow.mts` 通过（需传一个仍打开的事项；claim-flow 的探针事项会被做到 succeeded，不能复用）。
- 崩溃（`crash-a` → kill -9 → 重启 → `crash-b`）：重启后启动时的 maintain 已把对象回收成 `deleted`、reservation 成 `abandoned`；无 evidence 行指向这份字节；`tombstonesWithoutProof=1`（崩溃进程写者没有 `committed` / `awaited` 原因，不出"不存在"证明）；`reconcile` 的 missing / sizeMismatch / untracked 全空，存储键数等于 live 对象数。探针首跑两处 FAIL 是假设重启后仍是 `writing`，已改成两种起点都接受。
- 调试配置（A2 后延迟 20 s、租约 5–6 s）没恢复时跑 `main` 会得到 `reservation_lost`：maintain 在写者停顿期间回收了 reservation，迟到的阶段 B 被拒，是保护在按设计工作；恢复默认后通过。

## 已知缺口（DESIGN §14 同步）

- verifier 只认 `executed` 与操作员声明的 relation；`tool_output` 引用未支持（需先做 spike）。
- 没有 `nexus.evidence.handle` 短时效读取句柄。（后续已补，见 stage3-followups。）
- 崩溃进程留下的墓碑没有"不存在"证明，直到 `incarnation_gone` 或 Purge（切片③）。
- 暂存区让上传 I/O 翻倍；没有自动 supersede；阶段 B 失败后的重试要等写者租约过期。
- 没有证据删除与 Purge；软配额并发时可短暂越线。
- pkg 安装产物未回归。（后续已回归通过。）

## 下一步

1. commit 切片②。
2. 切片③：Purge 与 `incarnation_gone` 启用清单。
3. pkg 新包构建与 Stage 2 + Stage 3 回归。
