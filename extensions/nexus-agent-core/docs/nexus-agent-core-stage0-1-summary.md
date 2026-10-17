# Nexus Agent Core Plugin: Stage 0 / Stage 1 阶段性总结（2026-10-10）

位置：OpenClaw fork `extensions/nexus-agent-core/`（DESIGN.md、ARCHITECTURE.md、spikes/、src/）。约束：不改 OpenClaw `src/`；工具前缀 `nexus_`；插件不写自己的代码目录，数据只进状态目录。

## 一、Stage 1 完成项

- 存储：首发 migration 只建 3 张 Task 表（`nexus_tasks`、`nexus_task_steps`、`nexus_task_sessions`）和非业务的 `schema_migrations`。采用「分批建表」：boot id / Blob / Evidence / Claim / Purge 表随 Stage 3，Decision 相关表随 Stage 2；已发布的表不 ALTER，回归脚本（210 项）证明后续阶段 DDL 可叠加。
- 内核：同步 SQL kernel（所有查询带 `owner_id`），跑在 SQLite worker 里；lazy worker host；库路径 `<stateDir>/plugins/nexus-agent-core/nexus.sqlite`。
- 工具（6 个，optional）：`nexus_task_reserve / create / get / update / note / search`。
- RPC（4 个）：`nexus.task.list / get`（operator.read），`abort / delete`（operator.write，软删除）。
- 事件：`plugin.nexus-agent-core.task_changed`（created / updated / note / aborted / deleted），经 service 的 `gatewayEvents.emit` 发出。
- 提示词：`before_prompt_build` 只处理用户轮，注入 Nexus 事项协议 + 进行中事项清单。
- 令牌：operation / override token 放内存。
- 开关：`tasksEnabled`（默认 false）、`ownerId`（默认 `local`）。
- 测试：相似度 10、令牌 5、任务工具 17、prompt/events 8、rpc 6、kernel 20；`pnpm tsgo:extensions && pnpm test extensions/nexus-agent-core` 在本机通过（A/B/C 修改之后需重跑一次）。
- 验收：dev 网关步骤 0–10 通过（含事件推送，用 `spikes/listen-task-events.mts` 验证）；pkg 安装产物步骤 1–4 通过。
- 验收中发现并修掉的问题：`deleted` 事件 revision 恒为 0（改为真实值）；`tools.allow` 是排他白名单，应改用 `tools.alsoAllow`；本地模型路线自动开 Tool Search 导致中文搜不到工具（6 个工具标 `catalogMode: "direct-only"`）；令牌绑 entities 太脆（改为只绑 kind）；去重对模型自由命名的键漏拦（改为按值比较、阈值 0.5 且至少共有 2 个值、ISO 日期不重合直接判不同）；失败结果带 `notice`（模型曾谎报成功）；协议补两条（不要编造、登记不等于办理）。
- Stage 0 遗留一并定案：`process_boot_id` 选方案 D（pid + OS 进程启动时间），A/B 删除；`incarnation_gone` 保持关闭，待 Stage 3 有真实写入方后按 5 项清单打开。

## 二、Stage 1 待改进

1. 模型相关局限（提示词管不住）：模型会凭空补出发地（香港、新加坡轮流出现）、`kind` 自由命名漂移（flight_booking / flight_search）、有时不写 entities、失败后仍可能谎报成功、编造内容留在 goal 里没人纠正。处理方向：Stage 2 的确认页在授权前展示并确认 entities / 关键字段。
2. 未在真实网关观察到：真实去重往返（`created:false` + override token）、`task_closed` 经工具调用被拒、带任务重启网关后的数据完整性、`updated` 事件单独观察。
3. 本机需重跑一次 tsgo + vitest（A/B/C 之后）。
4. 文档：DESIGN 版本号与变更日志未升；`ARCHITECTURE.md` 随 Stage 2 一并核对。
5. Stage 0 残余：disabled/unsupported 审批源、三个未验证的 approval 参数、`agent exec` 成因、spike 4 触发与 `deleteAfterRun`、dmg 拖拽安装路径；D 方案的首次读取开销、pid 复用、非 darwin 平台、时钟调整。

## 三、五个子任务完成情况

| 子任务                                 | 状态                                | 说明                                                                                                                                                      |
| -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. WebSocket command/event             | Tasks 域完成，其余未开始            | 4 个 RPC + `task_changed` 事件已在 dev 与 pkg 验证；`decision_pending`、`claim_verified` 以及 Decision / Evidence / Watch / Preference 的命令和事件尚未做 |
| 2. Task / Workflow Manager             | Task 部分完成，Workflow 未开始      | 存储、去重、会话绑定、软删除、abort、搜索已落地；步骤编排、状态机后续推进、completion claim、purge 未做                                                   |
| 3. Human Decision / Approval           | 设计与 Stage 0 探针完成，无产品代码 | 契约已冻结（DESIGN §8）；待 Stage 2 实现                                                                                                                  |
| 4. Evidence / Claim Ledger             | 设计与 Stage 0 探针完成，无产品代码 | Blob 契约与 boot id 规格已定；表和写入方待 Stage 3                                                                                                        |
| 5. Personal Context / Preference Store | 仅设计                              | 待 Stage 4                                                                                                                                                |

（以上是 2026-10-10 当时的状态，后续阶段的完成情况见各阶段文档。）

## 四、下一阶段（Stage 2：Decision + Grant + Execution）

准入条件已满足。计划：

1. 先核对 Stage 2 设计与 Stage 0 spike 2 的残余（三个未验证 approval 参数、disabled/unsupported 来源），必要时补小探针。
2. migration：actions、decisions、decision_actions、action_grants、standing_grants、action_executions、grant_uses；`run_triggers` / `outbox` 的归属重新确认。
3. 一组假工具：`nexus_action_prepare / authorize / nexus_decision_request / nexus_action_commit`，外加可切换「支持/不支持幂等」的假供应商。
4. 确认页：授权前展示当前 entities，由用户逐项确认或纠正（来自 Stage 1 的发现）。
5. 全部以真实入口测试验收，不用单元 mock；`before_prompt_build` 增加 `requiresToolAuthority`。
6. Stage 1 尾巴并行补：真实去重、`task_closed`、重启持久化。
