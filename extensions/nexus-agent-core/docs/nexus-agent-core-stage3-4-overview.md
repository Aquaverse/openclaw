# Nexus Agent Core — Stage 3 / Stage 4 汇总与白话说明（2026-10-15）

位置：`extensions/nexus-agent-core/`，分支 `nexus-plugin`。约束不变：不改 OpenClaw `src/` 与 `ui/`；工具前缀 `nexus_`；插件不写自己的代码目录，数据只进状态目录。
本文依据各阶段摘要文档整理；细节以 nexus-agent-core-design.md 与各摘要为准。

## 一、总览

| 阶段          | 内容                                                       | 验收                                     |
| ------------- | ---------------------------------------------------------- | ---------------------------------------- |
| Stage 3 切片① | Claim / Evidence 账本 + boot id                            | VM、dev 通过；pkg 通过                   |
| Stage 3 切片② | 证据字节存储（Blob）+ 操作员上传                           | VM、dev（含 kill -9 崩溃）通过；pkg 通过 |
| Stage 3 切片③ | Task 清除（purge）+ 单条证据删除 + `incarnation_gone` 开关 | VM、dev 通过；pkg 通过                   |
| Stage 3 收尾  | 证据读取句柄、人工终结日志、`task.get` 补字段              | dev、pkg 通过                            |
| Stage 4       | 偏好库、回检（Watcher）、控制台页面                        | dev、pkg 通过                            |
| 控制台后续    | 操作按钮、事项列表分页 / 筛选 / 本地时间、中英文本地化     | dev 通过；安装版正在重新打包验证         |

## 二、已完成项

**Stage 3**

- 八张账本表 + 三张 purge 表 + 一张 blob 预留表，全部只追加迁移，SQL 与设计文档逐字一致（回归脚本 222/222）。
- 三个 Agent 工具（`nexus_claim_add / evidence_add / claim_verify`），其余账本能力只给运维 RPC。
- 完成判定：`nexus_task_update(status="succeeded")` 必须满足完成条件，否则 `completion_unmet`。
- 证据字节存储：四阶段写入、崩溃接管、墓碑与"不存在"证明、软配额（Task 200 MB / owner 400 MB / 单条 16 MB）。
- 清除：P1–P5 协议、回执、迟到写者处理、租约归还、周期续跑。
- `incarnation_gone` 开关：dev 实测通过，**默认保持关闭**。

**Stage 4**

- 偏好库（三种来源、解析顺序、修订历史、清除回执）。
- 回检 Watcher：spike 实测 → 认证协议 → 生命周期 → 工具 / RPC / 事件。
- 控制台：先是只读 HTTP 页；因 WKWebView 不保留 iframe cookie，改为插件自带的浏览器模块；之后加了操作按钮、事项列表筛选与分页、本地时间、中英文本地化。

## 三、需要后续改进

- 账本判定规则只认 `executed` 谓词与操作员声明的 relation；其他谓词的 claim 永远停在"已声明"。`tool_output` 类证据没做（需先做 spike）。
- 清除相关：`task_busy` 只在开始瞬间检查；暂存副本最长残留 10 分钟；单条删除不抹文件名、不回退已达成的 claim 状态；一次调用约 20 秒预算。
- `incarnation_gone` 启用清单中"一个状态目录只有一个网关"等条件由操作员承诺，探针验证不了，所以默认关。
- 操作者身份：RPC 上下文里没有可信操作者，回执 / 人工终结里是固定字符串（`operator:nexus-console`）。
- Watcher：`ctx.jobId` 是 undefined（建议向上游提 `PluginHookAgentContext` 转发 `jobId`）；关联依赖 `started` 事件先于 prompt（实测成立但无保证，不成立就 fail closed）；多数非 `executed` 谓词的回检会以 blocked / 耗尽收场并交还用户。
- 控制台：R2 / R3 真实批准（产出 ready 的 execution）、过时 / RPC 报错对话框分支、编辑偏好保存回读，尚未在页面上走完。服务端生成并存库的文案（决策问题 / 事实、步骤日志、备注）保持中文，这是用户确认的决定。
- 安装版尚未做：卡片流（注入、迟到 Deny）、kill -9 恢复 K1–K3、blob `crash-a / crash-b`。
- 默认值：所有功能开关默认关，等真实 provider 方案定下后再定，或由安装器分开发 / 正式配置。
- 没有设计：Handoff（跨会话 / 跨设备接手）、多步 Workflow 编排。
- 真实 provider（幂等键、对账接口、风险分级目录）需单独立项；现在只有假供应商。

## 四、关键组件（白话版）

### 1. Claim / Evidence 账本

**一句话**：Agent 说"我办成了"不算数，账本只认有证据的话。

- **Claim（声明）**：一条"待证明的说法"，例如"订单 X 已经成功提交"。每条 claim 属于某个 Task，有状态：ASSERTED（只是说了）/ UNKNOWN / SUPPORTED（有证据支持）/ VERIFIED（有两个独立来源支持）/ REFUTED（被证据推翻）。Agent 只能把 claim 写成 ASSERTED 或 UNKNOWN，**状态由 store 根据证据算出来**，Agent 改不了。
- **Evidence（证据）**：支持或反驳某条 claim 的材料，带"来源组"（`source_group`，例如 `agent_call:<供应商>` 或 `user_upload`）。同一来源组出现多次只算一份。规则：至少 1 个来源组支持 → SUPPORTED；至少 2 个不同来源组支持 → VERIFIED；只有反驳 → REFUTED；两边都有 → UNKNOWN。`unclassified`（Agent 挂上去、还没人判定方向）的证据不计入任何一边。
- **claim_events（事件链）**：每次 claim 变化都追加一条记录，每条记录里存着上一条的摘要（digest），像一条锁链。`nexus.claim.verifyChain` 重算整条链，中间有人改过就对不上。所以账本只能追加，不能偷偷改。
- **完成判定**：Task 可以登记"完成条件"（哪些 claim 必须达到什么状态）。Agent 想把 Task 标成 succeeded，store 在同一个事务里检查条件，没达标就拒绝（`completion_unmet`）。
- **自动记账**：每次执行落定（成功 / 失败 / 对账 / 人工终结），同一事务里自动写一条 `execution:<id>` 的 claim 和执行证据。记账失败只丢账本，不会让执行结算失败。

### 2. boot id（进程启动标识）

**一句话**：区分"网关这次启动"和"上次启动"。

格式是 `<进程号>:<系统启动时间>`，读不到就是 `unavailable`（不编造）。用途：

- 重启后，只有**其他进程**留下的"批准卡片还在等"孤儿状态才会被立刻退回；同一进程的热重载不动它们。
- 每次启动登记一行 `process_incarnations`；正常关闭写 `clean_shutdown`。
- 开启 `incarnation_gone` 后，用来判断"写入字节的那个进程已经不在了"，才能签发"这份字节确实不存在"的证明。boot id 不同才算旧进程。

### 3. 证据 Blob（字节）各阶段的来源与作用

Blob 就是证据的原文字节（文件、截图、回执等）。账本里只存引用和哈希，字节放在文件存储里。

- **切片①**：证据只有 `execution` 一种来源，**没有字节**（`blob_key` 为空）。真实工具因此走不到 VERIFIED（同一供应商只算一个来源组）。
- **切片②**：操作员可以上传文件当证据（来源组 `user_upload`）。Agent 只能把已有的 blob 挂到 claim 上，而且**挂上去永远是 unclassified**，是支持还是反驳只有操作员能定（上传时带 `claimId`，或用 `nexus.evidence.link`）。这样"供应商执行记录 + 用户上传文件"两个来源组就能端到端达到 VERIFIED。写入分四阶段（预检、计划、字节落盘、入账），崩溃后能接管，字节和记录不一致会被 reconcile 检出。
- **切片③**：支持删除单条证据（字节置空、hash 保留）和整个 Task 清除。
- **收尾**：`nexus.evidence.handle` + `nexus.evidence.read` 让控制台看原文：句柄 60 秒有效，每次读都重算 sha256，对不上就报 `evidence_integrity_error`。模型仍读不到字节。
- **没做**：`tool_output`（把工具输出直接当证据）。

### 4. Task purge（清除）

**为什么要有**：账本设计成只追加、不能改，但用户有权让一件事的记录彻底消失（隐私、清理）。purge 是账本唯一的"销毁出口"。

**做什么**：把一个 Task 的决策、授权、执行、claim、证据、字节全部按顺序销毁，只留一张回执（Task id、标题的哈希、链尾摘要、事件数、证据数、请求者、时间），**不留内容**。别的 Task 还引用的共享字节会保留，最后一个引用被清除时才回收。

**时机**：只能由操作员手动触发（`nexus.task.purge`，需要 admin 权限，且要重复输入确认的 Task id）。Task 有在途工作时拒绝（`task_busy`）。**Agent 没有任何删除或 purge 入口**。没做完的 run（比如字节删不掉）由 gateway 启动和周期 maintain 自动续跑。

**为什么不是一个大事务**：字节在文件存储里，SQLite 事务管不到；所以分五步，每步各有事务，最后一步重新核对一切都成立才写回执。任何一步没把握就保持"清理未完成"，**不出回执**。

### 5. 插件命令

**Agent 工具（共 19 个，optional，需放进 `tools.alsoAllow`）**

- 事项：`nexus_task_reserve / create / get / update / note / search`——先占位去重、登记、查看、更新状态、记备注、搜索。
- 动作与决策：`nexus_action_prepare / authorize`（准备动作、申请授权）、`nexus_decision_request`（请用户批准）、`nexus_action_commit`（凭 executionId 提交执行）。
- 账本：`nexus_claim_add`（登记声明）、`nexus_evidence_add`（挂执行证据）、`nexus_claim_verify`（只读，查状态）。
- 偏好：`nexus_preference_get / set / confirm`。
- 回检：`nexus_watch_create / cancel / report`。

**运维 RPC（控制台与探针用，按权限分 read / write / admin）**

- 事项：`nexus.task.list / get`（列表现支持分页与筛选）、`abort / delete`、`purge / purgeStatus / purgeReceipts`。
- 决策与执行：`nexus.decision.list / get / resolve`、`nexus.execution.list / reconcile / resolve`（人工终结 unknown）、`nexus.grant.list / revoke`。
- 账本：`nexus.claim.list / get / verifyChain / retract / unlinkEvidence`。
- 证据：`nexus.evidence.upload / link / maintain / list / stats / reconcile / delete / handle / read`。
- 偏好：`nexus.preference.get / list / history / set / delete / purge / purgeReceipts`。
- 回检：`nexus.watch.list / get / cancel`。

**事件**：`task_changed`、`decision_changed`、`execution_changed`、`claim_changed`、`claim_verified`、`evidence_changed`、`task_purged`、`preference_changed`、`watch_changed`，前缀都是 `plugin.nexus-agent-core.`，经 outbox 至少一次投递。

### 6. 回检（Watch）

**一句话**：让 Agent 在将来某个时间自动再看一眼——"一小时后再查一下订单有没有出票"。

- **怎么跑**：Agent 用 `nexus_watch_create` 建一个定时任务，到点宿主启动一个专门的回检回合。回合里的 Agent 只拿到读 + 登记证据 + 汇报的工具，**不能对外办事**。
- **怎么确认这一轮真是我们的回检**：提示词里的标记 + 该会话恰好一个未认领的定时任务 + 数据库里的 watch 记录对得上 + 状态原子更新（CAS）。任何一条不满足就不给任何工具（fail closed）。标记本身不算凭据。
- **结果**：回检报告"已满足"时，账本说了算——对应 claim 必须已经是 SUPPORTED / VERIFIED，否则不算。没满足就按 1h / 6h / 24h / 72h 退避重排；次数用尽（或被卡住）后生成一张 R0 的"请确认"决策交还用户，Task 进入 awaiting_decision。
- **限额**：每个 Task 最多 3 个、每个 owner 最多 50 个；开关 `watchersEnabled`（默认关，需要 `claimsEnabled`）。
- **一个坑**：宿主把插件注册了不止一次，钩子之间靠内存传状态会互相看不见；所以这类状态放在进程级共享里。

### 7. 偏好库（Stage 4）

记录用户的稳定偏好。三种来源：`stated`（用户亲口说的，只能经操作员 RPC 或被批准的决策写入）、`observed`（Agent 观察到的，不进自动路径）、`task_exception`（只对某个 Task 有效，Task 结束即失效）。解析顺序：task_exception > stated > observed。**偏好不是授权**：风险分档、授权都不读偏好。

## 五、Nexus Agent Core Plugin 五个子任务完成情况

| 子任务                                 | 状态                         | 已完成                                                                                                                   | 未完成                                                                      |
| -------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| 1. WebSocket command / event           | **基本完成**                 | Task、决策 / 执行 / 授权、账本、证据、清除、偏好、回检全部有 RPC 与事件；控制台浏览器模块（含操作按钮）。dev 与 pkg 验证 | 安装版重新打包后的界面验收进行中；上游 `jobId` 提案；Handoff 没有命令       |
| 2. Task / Workflow Manager             | **Task 完成，Workflow 未做** | 存储、去重、会话绑定、软删除、abort、搜索、状态派生（含 watching）、步骤日志、完成判定、purge、列表分页筛选              | 多步 Workflow 编排、Handoff（均无设计）                                     |
| 3. Human Decision / Approval           | **核心完成**                 | 决策、卡片审批、决策页批准、注入下一轮、迟到点击、grant、执行 / 对账 / 人工终结、kill -9 恢复；页面批准 / 拒绝按钮       | 真实 provider；安装版卡片流与 kill -9 恢复；R2 / R3 页面真实批准全流程      |
| 4. Evidence / Claim Ledger             | **完成（v1）**               | 账本、摘要链、完成判定、blob、清除、读取句柄，dev 与 pkg 通过                                                            | 只认 `executed` 与操作员声明；`tool_output` 未做；`incarnation_gone` 默认关 |
| 5. Personal Context / Preference Store | **完成（v1）**               | 三种来源、修订历史、清除回执、工具与 RPC、页面增删改，dev 与 pkg 通过                                                    | 编辑保存回读未在页面走完；`observed` 偏好暂不进自动路径                     |

## 六、当前进度与下一步

- 安装版（pkg）已确认 Stage 2 / 3 / 4 的探针回归和控制台标签页可用；**最新的按钮、筛选、本地化代码正在重新打包验证**。
- 验证通过后：补记 `claude/nexus-agent-core-pkg-regression.md`；可选再做安装版卡片流与 kill -9 恢复；`incarnation_gone` 是否在生产启用取决于操作员对"单网关"的承诺。
- 新功能（Handoff、Workflow、`tool_output`）都需要先确认设计与范围，不会自行开工。

## 七、代码审查后的收口（2026-10-15）

一次整体审查提出 8 条问题，核对后全部属实，处理如下（细节见 DESIGN §14「审查后收口」）：

| 问题                             | 处理                                                                                                                                                                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T6 会话级 lockdown 未实现        | 不实现。Stage 2–4 按 fake-provider 切片交付，不得对外宣称 R2/R3 强授权。只加了一道开发约束：`createDecisionRuntime`（provider 进入执行路径的唯一入口）拒绝非 fake 的 provider，并有测试；这挡不住有意绕过，所以不叫硬门槛，另需评审要求 |
| `watcherExtraTools` 可注入写能力 | 已修：Nexus 持有允许列表（web_fetch / web_search），manifest enum + 运行时过滤 + 告警 + 测试                                                                                                                                            |
| `tool_output` 证据未实现         | Stage 3 口径降级为 execution + 操作员上传 blob，tool_output 列为后续工作                                                                                                                                                                |
| HTTP UI 的 Claims 开关接错       | 已修：改传 `claimsEnabled`                                                                                                                                                                                                              |
| 全面绕过 Kysely                  | 本期不迁；在 DESIGN 记录现状与理由，列为合入前待决项（申请例外，或按 ledger 分批迁移）                                                                                                                                                  |
| 11 个验收脚本越过插件边界        | 已修：改用 `openclaw/plugin-sdk/gateway-runtime` 与 `@openclaw/gateway-protocol/client-info`；并在插件 `package.json` 声明 `@openclaw/gateway-protocol` workspace 依赖（复审指出）                                                      |
| 崩溃测试 seam 成了公开配置       | 已移出正常生产路径：manifest 删除；证据服务只 await 注入的钩子，仅 `spikesEnabled=true` 时由 `src/spikes/crash-window.ts` 按环境变量 `NEXUS_EVIDENCE_DEBUG_DELAY_AFTER_A2_MS` 构造（上限 120000）。仍是 dev 测试缝隙                    |
| recorder 测试临时目录            | 已修：改用 `useAutoCleanupTempDirTracker`                                                                                                                                                                                               |
