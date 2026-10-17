# Nexus Agent Core — Stage 4 摘要（2026-10-14）

范围（用户确认）：Preference Store（DESIGN §11）、Control UI / 通知、Watcher（§10，先做 spike 再写）。Handoff 与多步 Workflow 没有设计，不在本期。全部代码在 `extensions/nexus-agent-core/`，未改 `src/`、`ui/`。

## 已完成并验收

验收结果（用户 Mac / dev 网关，2026-10-14）：Preference Store 与 Control UI 部分 `oxfmt --check` 通过；294 测试全过；dev 网关 `spikes/preference-flow.mts` ALL PASS（含 UI 页面的 HTTP 检查）；spike 4 的 `watch-trigger.mts` 全部通过。

**Preference Store**

- 迁移 `stage4-0001-preferences`：`preferences`、`preference_revisions`（append-only）、复用 `purge_receipts`（`subject_kind='preference'`，只存哈希与数量）。schema CHECK 守 origin 不变量。
- 三种 origin：`stated`（只能来自操作员 RPC 或被批准的 `set_preference` 决策）、`observed`（Agent，需 confidence 与 sourceNote，不进自动路径）、`task_exception`（Agent，需 taskId，Task 终态后失效）。解析顺序 task_exception > stated > observed。
- 工具 `nexus_preference_get|set|confirm`；RPC `nexus.preference.get|list|history|set|delete|purge|purgeReceipts`；事件 `preference_changed`。偏好不是授权：风险分档、admission、grant 都不读偏好账本。开关 `preferencesEnabled`。

**Control UI**

- `/plugins/nexus-agent-core/ui`（网关鉴权）+ 侧边栏 tab `nexus`。服务端渲染只读页：事项列表、事项详情（决策/执行/声明/证据/回检）、偏好、清除回执。严格 CSP（无脚本、`form-action 'none'`），GET/HEAD only。局限：没有按钮，批准仍走 RPC。通知沿用现有事件与 outbox。

## Watcher（§10）— 代码完成，待 dev 探针

**Spike 4 实测**：定时 turn 触发一次、`ctx.trigger="cron"`、sessionKey 正确、`toolsAllow:[]` 生效；但 `ctx.jobId` 是 undefined（upstream 提案候选：`PluginHookAgentContext` 转发 `jobId`）。`cron_changed.started` 先于 prompt 到达（领先 180–836 ms），带 jobId / sessionTarget / job.name，无 sessionKey / runId。同会话忙时第二个 job `started` 后约 72 ms 即 `finished(error)`，无 turn，约 30 s 后重试。

**认证（DESIGN §10.3）**：prompt 标记 `[nexus:watch:W…]` + 该会话恰好一个未认领的 `started` job + 该 job 在 `watches.scheduler_job_id` 中且 watch id == 标记 + CAS（scheduled、revision 一致、session 一致）→ `firing`，attempts+1。任何一条不满足 → `toolsAllow: []`（fail closed）；无标记的 cron turn 不干预；伪造/残留的 Nexus 命名 job 被按 tag 删除。标记本身不是凭据。认证后 `run_triggers` 记 `watch_id`，`nexus_watch_report` 由 `before_tool_call` 门按它放行。

**生命周期**：pending_schedule → scheduled → firing → satisfied | rescheduled（退避 1h/6h/24h/72h）| exhausted | cancelled。`satisfied` 必须 claim 已 SUPPORTED/VERIFIED（账本说了算）；耗尽（含 `blocked`）→ 一张 R0 `acknowledge` 决策（固定幂等键），Task 进 awaiting_decision，解决后回 planning。Task 有活跃 watch 时为 `watching`。限额：每 Task 3、每 owner 50。watcher turn 只给读 + 证据 + 报告工具（`watcherExtraTools` 默认 web_fetch/web_search），不能对外动作。

**接口**：工具 `nexus_watch_create|cancel|report`（optional，需进 `tools.alsoAllow`）；RPC `nexus.watch.list|get`（read）、`nexus.watch.cancel`（write）；事件 `watch_changed`；迁移 `stage4-0002-watches`（§6.3 回检段逐字，回归脚本核对）；开关 `watchersEnabled`（默认 false，需 claimsEnabled）。

**已知局限**：Agent 只能把 `executed` 谓词的 claim 经执行证据抬到 SUPPORTED，其余谓词的 watch 多以 blocked/耗尽收场并交还用户；关联依赖 `started` 先于 prompt（实测成立但无保证，不成立时 fail closed 记一次未命中）；Handoff / Workflow 无设计。

**dev 实测（2026-10-14）：Watcher 探针 ALL PASS。** 第一次跑失败，原因是宿主把插件注册了不止一次（`full` 与 `discovery`），并把 `cron_changed` 与 `before_prompt_build` 分派给了不同的注册实例；闭包里的 pending 表互相看不见，认证全部 fail closed（`no started job for this session`）。修复：pending 表与 sync 在途标记放进进程级共享状态（`globalThis[Symbol.for("nexus-agent-core.watch-runtime.state")]`）。教训：凡是靠内存在钩子之间传递的状态都必须进程唯一，靠数据库传递的不受影响。

**验证状态**：VM 测试 16 文件全过（`watch-flow.test.ts` 26 条）；tsc 干净；回归脚本 222/222；Mac oxfmt / tsgo / `pnpm test:extension`（19 文件 320 条）通过；dev 探针 `spikes/watch-flow.mts` ALL PASS。待办：提交；打包后安装版验证（旧 pkg 不含 Stage 4，需重新打包才会有 Nexus 标签）；Nexus 标签页内容目测。
