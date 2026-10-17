# Nexus Agent Core Plugin: Stage 3 切片③（Purge + 单条证据删除 + incarnation_gone 开关）阶段性总结（2026-10-14）

位置：OpenClaw fork `extensions/nexus-agent-core/`，分支 `nexus-plugin`（DESIGN.md Stage 3 一节「切片③落地记录」与 §14「切片③留下的缺口」有逐项说明）。约束不变：不改 OpenClaw `src/`；工具前缀 `nexus_`；插件不写自己的代码目录。

## 范围（用户选定）

「Task 硬清除 + 单条证据删除 + incarnation_gone 开关」；Task 有在途工作时**拒绝**（`task_busy`）。无新开关：purge 随 `evidenceBlobsEnabled` 一起可用；新增配置 `evidenceIncarnationGoneEnabled`（默认 false）。状态：**VM、dev 网关、Mac 静态检查验收通过（2026-10-14）**；pkg 回归待做（Stage 2 已在安装版通过，见 `nexus-agent-core-pkg-regression.md`；Stage 3 等新包）。

## 做了什么

- **迁移** `stage3-0003-purge`：`purge_runs` / `purge_work_items` / `purge_receipts`，SQL 与 DESIGN §6.3 逐字一致；回归脚本 219/219（新增第三批断言）。
- **协议 P1–P5（DESIGN §9.4）**：不是一个大事务。内核（SQLite worker）做每一步的同步事务，purge 服务做字节 I/O，复用证据服务的回收与墓碑复查（和 GC 同一套机器）。一个 Task 一个 run、**一个 `purge_id` 用到底**，重试 / 周期续跑 / 崩溃接管只换 `worker_attempt_id`。
  - P1 封口并建 run（`task_busy` 在这里拒绝）；P2 认领 reservation 并回收字节；P3 抄引用进工作项、置空 `evidence.blob_key`、复核权威计数、封口；P4 逐项归类（别的 Task 还引用 → `retained_verified`；零引用 → 回收；墓碑 → 复查并条件签发缺失证明）；P5 在一个事务里重读一切，任何一条不成立都是 `cleanup_pending` 且**不写回执**，成立才按 FK 顺序销毁账本并写回执。
- **回执**只有 id、Task id、标题的 hash、链尾 digest、事件数、证据数、请求者、时间。成功响应带固定声明：账本已销毁、不可再审计；别的 Task 仍引用的对象被保留。
- **迟到写者**：墓碑记录 `settledWriterAttemptId`，写者在对象被回收**之后**才 settle 也能补上 `awaited` 证明；字节回来会撤回证明并把已 verified 的工作项退回 pending。
- **租约归还**（测试中发现的真问题）：一次 pass 以 `cleanup_pending` 结束时归还 run 租约，立即重试不会被 `worker_active` 挡 30 秒。崩溃的 pass 还不了，租约过期后被新 attempt 接管。
- **续跑**：`gateway_start` 与每第 4 个 tick 的 maintain 之后 `resume` 接管租约空闲/过期的 run（请求者记 `system:resume`）。
- **单条证据删除** `nexus.evidence.delete`：`blob_key` 置空、`redaction_state='purged'`、`ref_count` 递减，hash 保留（同名同字节重传被 RPC 拒绝，`nexus_conflict` / `evidence_purged`）；字节由零引用清扫回收；claim 状态不重写。
- **incarnation_gone 开关**：打开后，① 新 `service.start` 在登记时于同一事务把 **boot id 不同**的未终止旧行置 `superseded_under_gateway_lock`（同 boot id 的同进程前任、`unavailable` 的行从不被标）；② maintain / purge 对"写者 incarnation 已 gone 且 boot id 不是 `unavailable`"的对象签 `incarnation_gone`。关闭时这两条路径都不存在。
- **新 RPC**：`nexus.task.purge`（`operator.admin`，必须重复 `confirmTaskId`）、`nexus.task.purgeStatus` / `nexus.task.purgeReceipts`（read）、`nexus.evidence.delete`（write，必须重复 `confirmEvidenceId`）。事件 `task_purged`（只带 id 与时间）；`evidence_changed` 增可选 `change:"deleted"`。工具白名单不变：**Agent 没有任何删除或 purge 入口**。

## 测试

Linux VM：**purge-flow 15（新）**，其余 kernel 20、decision-kernel 61、task-tools 17、rpc 6、prompt-events 8、claim-flow 16、evidence-flow 31、process-boot 2、decision-flow 37、tokens 5、similarity 10 全绿；回归 219/219；`tsc --noEmit --noUnusedParameters --noUnusedLocals` 只剩缺 openclaw 构建声明的老报错；`src/` 零改动。

Mac：`oxfmt --check` 通过、`pnpm tsgo:extensions` 通过、`pnpm test:extension nexus-agent-core` 15 个文件 / 252 条通过。

purge-flow 覆盖：带完整账本（决策 / 授权 / 执行 / claim / 证据 / 对象）的 Task 首次整条级联删除（逐表确认无残留）；共享对象在别的 Task 还引用时保留、最后引用清除后回收；确认串缺失/错误；`task_busy`；`purging` 后拒绝上传与单条删除；字节删除失败 → `cleanup_pending` 无回执 → 同一 run 完成；崩溃 pass 被新 attempt、同一 `purge_id` 接管；并发调用只有一个 run；A2 写者在途时等真实写入落地；未静默写者的墓碑不出回执、字节回来后被再次删除；单条删除（hash 保留、claim 不变、digest 链通、零引用清扫）；`incarnation_gone` 的 supersede 规则与开/关对比。

## dev 网关验收（2026-10-14，通过）

- `spikes/purge-flow.mts`（`main`）全部通过：三个 Task（A 带完整账本并与 B 共享一份字节，C 做单条删除），缺确认被拒、单条删除、purge A（共享对象保留）、purge B（共享对象回收）、purge C（零引用对象回收）、回执只有 hash 与计数、`foreign_key_check` / `integrity_check`、无孤儿行、reconcile 一致、`task_purged` 事件。
- 回归 `claim-flow.mts`、`blob-flow.mts` 全部通过。
- 首跑在"同名同字节重传"处 FAIL：网关以 RPC 错误拒绝是对的，探针错把它当普通返回值读，已修探针，插件无问题。
- `spikes/purge-flow.mts --phase incarnation` **未观测**：需要打开 `evidenceIncarnationGoneEnabled`、`kill -9` 重启后再跑；开关保持 off。
- `listen-task-events.mts` 现在也订阅 `evidence_changed`、`task_purged`。

## 已知缺口（DESIGN §14 同步）

- `task_busy` 只覆盖 P1 的瞬间；之后靠 `purging` 状态挡新工作。
- 周期续跑接管的 run，回执里请求者是 `system:resume`。
- 被清除 Task 的暂存副本最长残留 10 分钟（暂存区 TTL）。
- 单条删除不抹文件名（`upload:<name>` 仍在 locator 里）；不回退已达成的 claim 状态。
- `incarnation_gone` 启用清单 ②③⑤ 是环境事实，由操作员确认，默认保持 off。
- purge 一次调用约 20 秒预算，卡住的对象需要人工介入，原因见 `purgeStatus`。
- pkg 安装产物上的 Stage 3 未回归。（后续已回归通过，见 pkg-regression 文档。）

## 下一步

1. commit 切片③。
2. （可选）打开 `evidenceIncarnationGoneEnabled` 做 kill -9 观测，决定清单是否成立。
3. 重新打包，在安装版上开 `claimsEnabled` / `evidenceBlobsEnabled`，回归 Stage 3 三个切片。
