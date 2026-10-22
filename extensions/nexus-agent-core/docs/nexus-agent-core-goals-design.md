# Nexus Goals（长期目标）设计方案

> 状态：设计草案 v0.1，2026-10-22，待评审。**没有任何代码**；文中的表、工具、RPC、配置名都是提案，不是契约。
> 任务表里**没有对应行**。本文参考 Muse 的 Goals（`https://muse.ai/goals`），按 Nexus 的架构重新设计，并建议在任务表补行（见第 11 节）。
> 相邻文档：`extensions/nexus-agent-core/nexus-agent-core-design.md`（Task、Watcher、偏好库）、`extensions/nexus-agent-core/docs/nexus-agent-core-personal-file-vault-design.md`（文件库）、`extensions/nexus-agent-core/docs/nexus-agent-core-plugin-status-and-remaining-work.md`。

---

## 1. 为什么要有 Goals，以及它不是什么

### 1.1 现状的缺口

Nexus 现在有两种"记着用户的事"的机制：

- **Task**：一次有边界的委托（订一张桌子、规划一次行程），天到周的生命周期，有完成门禁——必须所有完成条件被证据支持才能标成功。
- **偏好**：稳定的"用户喜欢什么"，不是授权，不参与完成判定。

缺的是第三种：**用户想长期达成的结果**。例如"今年带父母出国一次""一年省下 5000 美元""把每月订阅花费降到 200 以内"。它的特点是：周期长（月到年）、没有完成门禁、进展是渐进的、一个目标会产生许多个 Task、需要定期回看和提醒。现在这类意图要么被塞进某个 Task 的目标说明里（Task 结束就丢），要么只存在于聊天历史里。

### 1.2 与相邻概念的边界

| 概念                      | 生命周期          | 完成条件                                          | 能不能授权动作                           | 和 Goal 的关系                                 |
| ------------------------- | ----------------- | ------------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| **Goal**（本文）          | 月～年，跨 Task   | 用户声明完成；不走证据门禁                        | **不能**                                 | 一个 Goal 拥有 / 关联多个 Task                 |
| **Task**                  | 天～周            | 完成条件必须被证据支持（`completion_unmet` 门禁） | 经动作与决策                             | Task 可以属于一个 Goal                         |
| **偏好**                  | 稳定              | 无                                                | **不能**（"偏好不是授权"）               | Goal 可以引用偏好；偏好不引用 Goal             |
| **Watch（回检）**         | 分钟～天          | 对应声明被证据支持，或次数耗尽                    | 不能（回检回合只有读 + 登记证据 + 汇报） | Goal 的定期回看建立在同一套机制上（见第 7 节） |
| 核心的 `/goal`、core flow | 会话 / 分钟～小时 | —                                                 | —                                        | **无关**，不要混用（见 3.3）                   |

### 1.3 设计硬规则

1. **目标不是授权**。与偏好同理：风险分档、授权、决策、执行都不读目标。目标只影响"建议什么、提醒什么"，不影响"允许什么"。
2. **目标不是证据**。目标的进展记录不进 claim 链，不参与任何完成判定。需要可核验的进展时，进展指向已有的 claim，由账本说了算（第 6 节）。
3. **Agent 不能自称"用户说过"**。Agent 提出的目标需要用户确认才会开启提醒和主动行为（沿用偏好 `stated` 的原则，见 5.2）。
4. **主动行为必须有上限并可关**。静音、频次上限、免打扰、被忽略后询问一次是否停止。
5. **不替用户做个性化专业判断**。财务、健康等类别的边界单独规定（第 8 节）。

---

## 2. Muse 的 Goals：做法与取舍

资料来源（MuseAI-Skills 快照）：`home/hatch/docs/goals.md`、`opt/hatch/skills/goals/SKILL.md`、`opt/hatch/skills/goals/creation/*.md`（7 个类别的创建指南）、`opt/hatch/skills/goals/guides/*/scaffold.md`（7 个类别的持续支持指南）、`opt/hatch/skills/muse_db/references/schema.md` 里的 `goals` 表组。

按技能评估文档的口径：快照来源和许可未经核实，**只借鉴概念，独立重写，不拷贝文字**；以下均为转述，没有运行过 Muse 产品。

### 2.1 Muse 的产品模型

| 方面             | Muse 的做法                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 目标是什么       | 用户逐步靠近的持久里程碑，由智能体维护                                                                                                                                                                                                                                                                                                                                 |
| 操作             | 创建、读取详情、按名称或内容检索、改标题和描述、**记录进展条目**（带日期的笔记，累积成目标历史）、删除                                                                                                                                                                                                                                                                 |
| 状态             | **只有两种：进行中、已完成**；没有暂停。想歇一歇：静音该目标的主动推送，或记一条进展说明，或标成完成以后再重开                                                                                                                                                                                                                                                         |
| 层级             | 只嵌套**一层**：目标可以有子目标，子目标下不能再有                                                                                                                                                                                                                                                                                                                     |
| 删除             | 用户明确要求或建错了才删；删除连子目标和历史一起消失；已完成或放弃的目标应标成完成，而不是删除                                                                                                                                                                                                                                                                         |
| 应用里的按钮     | 完成 / 取消完成、重命名、删除（删除要确认）；"添加子目标"不是表单，而是发起一条聊天消息，由智能体来建                                                                                                                                                                                                                                                                  |
| 简报（briefing） | 后台进程定期写的"信"（带一小段说明），挂在目标上；**时间表由系统控制，智能体和用户都不能按需触发或承诺几点出**；可以删某一份                                                                                                                                                                                                                                           |
| 后台工作         | 目标本身不会运行任何东西；真正的后台工作只通过定时任务发生                                                                                                                                                                                                                                                                                                             |
| 类别             | 职业、健康、兴趣、金钱、效率、人际关系、其他；每类有"创建指南"和"持续支持指南"                                                                                                                                                                                                                                                                                         |
| 创建流程         | 三步：先弄清用户想要什么，再创建**唯一一条**记录，再提供支持。每轮最多问一个问题；意图阶段不读数据、不存东西；开头消息已经说清"要什么、怎样算达到"就直接建；已有同目标的进行中目标就更新而不是再建；标题用用户自己的语言和话；建完要读回校验，标题或描述不是用户的话就改；建完告诉用户"已存入目标页"；把约束、事实、计划现状写入该目标的工作区笔记，供之后的轮次接着做 |
| 首个里程碑       | 目标保存后，提出一个小的第一步，并说清智能体能做什么；"保存了但没有计划"也是可以接受的结果；提醒和定期回看只在确有需要时提，并要用户确认                                                                                                                                                                                                                               |
| 类别的安全边界   | 金钱：只做教育、整理和决策卫生，不给个性化投资 / 税务 / 法律 / 保险建议，转账、取消服务、开争议、联系机构之前先问；人际：动用消息 / 通话记录前先问，用户可排除人或平台，每个排除都要遵守，区分用户提供的事实与推断，发消息、订礼物前先批准，反复被忽略的提醒要问一次是否改或停；健康：不羞辱、不拿"连续记录被打断"施压，只在影响安全时才问病史，保存敏感信息前先确认   |

### 2.2 Muse 的数据模型（`goals` 表组）

| 表                                      | 作用                              | 值得注意的字段                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `goals`                                 | 目标主表                          | `status`、`parent_goal_id`（一层嵌套）、`sort_order`、`pushable`（是否允许主动推送）、`category`、`goal_kind`、**`user_words` 与 `assistant_distillation` 分开存**、`woop`、`implementation_intentions`（若 / 则计划）、`monitoring_signal`、`review_cadence`、`next_review_question`、**势头**（`momentum`、维度、调整建议）、`attention_kind`、`next_due_at`、`escalation`、`provenance`、`source` |
| `updates`                               | 进展条目                          | 标题、摘要、描述、生效时间、**`author_source`（用户 / 智能体 / 系统）**                                                                                                                                                                                                                                                                                                                              |
| `actions`                               | 目标下的待办动作                  | 状态、文本                                                                                                                                                                                                                                                                                                                                                                                           |
| `associations`                          | 目标与外部对象的多态关联          | 类型选择：定时任务、产出物、磁盘上的文档路径；`(goal, type, target)` 唯一                                                                                                                                                                                                                                                                                                                            |
| `briefings`                             | 简报                              | 路径、最近打开时间、配图                                                                                                                                                                                                                                                                                                                                                                             |
| `suggestions`                           | 目标与"点子"的关联                | 状态                                                                                                                                                                                                                                                                                                                                                                                                 |
| `engagement_events`                     | 展示 / 点击 / 互动 / 好评差评事件 | 用于排序与学习                                                                                                                                                                                                                                                                                                                                                                                       |
| `momentum_history`                      | 势头历史                          | 每次评估的时间、来源、维度、建议                                                                                                                                                                                                                                                                                                                                                                     |
| `learning_state`                        | 学习类目标的掌握度                | 目标技能、先修、掌握估计、误解、下次复习时间                                                                                                                                                                                                                                                                                                                                                         |
| `sessions`、`threads`、`thread_actions` | 目标专属的对话会话与线程          | 把聊天归到目标下                                                                                                                                                                                                                                                                                                                                                                                     |

### 2.3 取舍

| 借鉴                                                 | 不借鉴                                             | 原因                                                                                                                                            |
| ---------------------------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 只有"进行中 / 已完成"两个状态，歇一歇靠静音          | 删除即永久消失                                     | 我们加**软删除**并走已有的清除协议；不引入"暂停"状态                                                                                            |
| 一层嵌套                                             | 子目标由聊天消息触发创建的 UI 形态                 | 只借"一层"的限制；UI 另定                                                                                                                       |
| 进展条目 + `author_source`                           | 简报由系统独占时间表这一点可借，但内容生成交给模型 | 条目分来源；简报后期                                                                                                                            |
| `user_words` 与 `assistant_distillation` 分开存      | —                                                  | 标题和描述保留用户原话；模型提炼另放，避免把模型措辞当用户意图                                                                                  |
| 创建流程：先弄清、再建唯一一条、读回校验、已有则更新 | 每轮"一个问题"的措辞规则                           | 写进技能；"创建恰好一次"落实成服务端的幂等键（见 5.3）                                                                                          |
| 类别专属的安全边界                                   | 健康类别（v1 不做）                                | 见第 8 节                                                                                                                                       |
| 关联：目标 ↔ 定时任务 / 文档 / 产出物                | 多态外键                                           | 我们保留受限的服务端校验多态引用（`kind` 有 `CHECK`，写入时同事务校验目标存在且同 owner），不把跨域对象强行建成数据库外键；见 5.1「引用的口径」 |
| 势头（momentum）作为**估计**                         | 把模型对势头的判断当事实展示                       | 我们要求势头带依据，并标注是估计（第 6 节）                                                                                                     |
| 进展可用外部数据核对                                 | —                                                  | 我们独有：进展可以指向 claim，显示"自述 / 已被证据支持 / 已核验"                                                                                |
| 学习类目标的掌握度与复习计划                         | 全部不做                                           | 与我们的委托型产品定位无关                                                                                                                      |
| `engagement_events` 做排序学习                       | 不做                                               | 试点阶段没有必要，且涉及行为数据                                                                                                                |
| 目标专属对话线程                                     | 不做 v1                                            | Nexus 的会话与 Task 绑定已有机制，目标先不另起                                                                                                  |

**定位差异**：Muse 的 Goals 是生活教练式的（职业、健康、兴趣……），产品是陪伴型智能体。Nexus 是**委托与执行**型：目标的价值在于把长期意图变成一串可执行、可核验的 Task。所以 Nexus 的类别应先聚焦**旅行**与**金钱**两类，与 Journey、Moneywise 对齐，其余类别后做。

### 2.4 部署形态差异：Muse 在远程虚拟机，Nexus 在用户本机

Muse 的后台进程、简报和提醒运行在**常开的远程虚拟机**上，时间表由平台控制；Nexus 随 OpenClaw 跑在**用户自己的电脑**上，会合盖休眠、退出应用、换网络、换时区。2.1 里"后台定期写简报""被忽略就询问"这类机制，到本机上会变形：

| 方面           | Muse（远程虚拟机）           | Nexus（用户本机）                                                                                                                                                                       | 对本设计的影响                                                                         |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 定时触发       | 平台常开，到点就跑           | 机器休眠或应用退出时不会跑；宿主的定时服务有重启后的错过补跑逻辑（`src/cron/service/timer-runnable.ts` 的 `hasMissedCronSlotSinceLastRun`），但**休眠唤醒后的实际行为与补跑上限未核实** | 回看按"到期判断"而不是"准点触发"设计；唤醒后同一目标最多补一次（7.4）；新增 spike G-S1 |
| "被忽略"的含义 | 提醒总能送达，没响应就是忽略 | 提醒可能根本没送达（机器睡着、应用没开、渠道离线）                                                                                                                                      | 忽略计数只统计**已确认送达且超过窗口未响应**的提醒；未送达不算忽略（7.1、7.3）         |
| 通知渠道       | 平台自带推送                 | 依赖状态文档 5.2 的通知工作包；渠道（OpenClaw 的消息渠道、控制台徽标）只有网关在跑时才可用                                                                                              | 通知记录送达状态；v1 前只有控制台徽标和对话内提示，且只在应用打开时可见                |
| 时区           | 用户设置固定                 | 机器随用户出差，系统时区会变；旅行类目标恰好最容易跨时区                                                                                                                                | 回看时间用**固定的 IANA 时区**（取自偏好或首次设置），不随机器时区漂移；展示时再换算   |
| 模型费用与算力 | 平台承担                     | 回看回合用的是用户自己的模型额度或本地模型，还会占用用户机器                                                                                                                            | 加每周回看次数上限和回合 token 上限；超限不补跑，只记"已跳过"                          |
| 数据位置       | 云端数据库                   | 本机 `nexus.sqlite`                                                                                                                                                                     | 隐私更好；目标文本不出本机，除非送进模型回合（8.3 的包装与最小化规则更重要）           |
| 多端访问       | 手机随时可看                 | 手机要经 Relay 才到本机，本机可能离线                                                                                                                                                   | 沿用约束：接账号系统前不对 Relay 与移动端开放（R8）；手机上的进展记录后置              |

结论：借鉴 Muse 的**数据模型与"目标不自己运行"的原则**，不借鉴"平台常开、准点简报"的假设；回看在 Nexus 里是**尽力而为**的，错过是正常状态而不是故障。

---

## 3. 命名与边界

### 3.1 命名

沿用设计文档 §4.1 的命名纪律：

| 标识符       | 名字                                                                                                            | 说明                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| Agent 工具   | `nexus_goal_*`                                                                                                  | 一律带前缀                   |
| RPC          | `nexus.goal.*`                                                                                                  | 一律带前缀                   |
| 事件         | `plugin.nexus-agent-core.goal_changed`                                                                          | 一律带前缀                   |
| 表           | `goals`、`goal_entries`、`goal_links`、`goal_reviews`、`goal_metrics`、`goal_purge_runs`、`goal_purge_receipts` | 私有表不加前缀，发布后不改名 |
| 文档里的叫法 | **长期目标 / Goal**                                                                                             | 与 Task 的目标说明区分       |

### 3.2 已有的"目标"一词

- `nexus_tasks.goal_json` 是**Task 自己的目标说明**（该事项要达成什么），与本文的 Goal 无关。文档里叫"事项目标"，列名不改。
- 设计文档 §4 的三层表里 L3 一栏写着"目标 = Task"，这是早期口径。Goals 加入后，**把该表头改为"事项"，Goal 作为 L4 记入概念模型**（见 3.4）。

### 3.3 与 OpenClaw 的"goal"

架构文档 ADR-03 提到宿主有 `/goal`（会话级目标）和 TaskFlow，它们都绑定 `sessionKey`，不跨会话。Nexus Goal 存在 `nexus.sqlite` 里，**不建在它们上面**，理由与 Task 相同。代码和日志里不允许出现把二者混写的名字。

### 3.4 概念模型

| 层  | 名称          | 生命周期                | 归属              |
| --- | ------------- | ----------------------- | ----------------- |
| L4  | **Goal**      | 月～年，跨 Task、跨会话 | Nexus 自有 SQLite |
| L3  | Task          | 天～周，跨会话          | Nexus 自有 SQLite |
| L2  | core flow     | 分钟～小时              | 宿主              |
| L1  | agent session | 一次对话                | 宿主              |

Goal 与 Task 是**一对多**，Task 至多属于一个 Goal；Task 的完成不改变 Goal 的状态，Goal 的完成不终止尚未结束的 Task（页面提示用户处理）。

---

## 4. 例子：Goals 在 Nexus 里怎么用

1. **旅行类**。用户说"今年想带父母去一次日本，预算 3 万"。Agent 在确认后建一个 Goal（类别 `travel`），记下用户原话、约束（预算、时间窗口、同行人）。之后每次用户让 Journey 规划，产生的 Task 关联到这个 Goal。订下机票后，Goal 的进展条目里出现一条"机票已订（引用该 Task 的执行证据）"，状态显示"已被证据支持"。
2. **金钱类**。"把订阅费降到每月 200 以内。"Goal 带一个度量（目标值 200、当前值、来源）。当前值由用户手填，或在财务记录模型（G5a）就绪后来自对账结果的声明。Moneywise 的"发现可省的订阅"建议产生 Task（取消、降级）；Task 成功后，节省额写进 Goal 的进展，并区分"已核实账单减少"与"预估节省"（对应节省核算 M7 的口径）。
3. **定期回看**。Goal 设置每月一次回看：到点时，一个受限的回看回合读取 Goal、关联 Task 的状态和最近条目，生成一条进展草稿，并通知用户。用户确认后记入条目。

---

## 5. 数据模型与写入权限

### 5.1 表（草案）

暂定迁移 id `stage6-0001-goals`（评审与合入时按 `MIGRATIONS` 末尾的实际顺序最终确定），只追加。迁移前置：只依赖已注册的 `stage1-0001-task-core`（目标对 Task、声明、文件等没有外键），与文件库迁移（暂定 `stage5-0001-vault`）互不依赖（文件清除对 `detachFile` 的调用经清除钩子进行，钩子在迁移未安装时是空操作、已安装时不受 `goalsEnabled` 影响，所以任一方先合入都成立；反方向同理，写入口对 `vault_file` 的校验也按存储能力判断，见 §5.1「目标 ↔ 文件关系的唯一所有者」）；两个编号都是暂定，先合入者占用下一个编号；回看的定时任务由宿主定时服务持有，不属于迁移。目标表按 owner 隔离，主键 `(owner_id, id)`；目标模块内部的外键用 `(owner_id, …)` 复合键。**与现有实现的对照**：目标像偏好库那样可以比 Task 活得久，所以对 Task / 声明 / 文件 / 偏好 / 回检的引用**不加外键**，由服务端在事务内校验（理由见下文「引用的口径」）。

**验证状态**：本节 DDL 已在 SQLite 3.45 上建表通过，并用负例试过：用户来源的 `proposed`、未确认的 Agent 目标变 `active`、`deleted` 无时间、同一 Task 挂两个目标、`claim` 度量缺 Task、`cancelled` 仍带定时任务 id、`scheduled` 无任务 id、带回看的目标被直接删除（外键拦住），均被拒绝。另外把生命周期转移（软删除、恢复、进入清除的完整赋值）和 G3 的“先显式删回看、写回执、删 run、再删目标，子目标在先”写成 SQL 跑过：一个目标只能有一个 `goal_purge_runs`，run 存在时直接删目标被外键拦住，回执的 `purge_id` 与 `requested_by` 取自 run；`goal_reviews` 的删除触发器也能拦住未取消的回看；`goal_purge_runs` 的认领与过期接管用与文件库相同的条件语句验证过（活跃持有者拒绝、过期接管保持 `purge_id`）；同一 owner 的父子目标先后完成 G3，两份回执（各自的 `purge_id`）都写出，同一 owner 内重复的 `purge_id`（目标清除域）被约束拒绝。这是单连接顺序模拟，G1–G3 之间的崩溃注入属于实现阶段。

**级联的总规则**：不拥有外部副作用的从属行（条目、关联、度量）可以随目标级联删除；**拥有外部副作用的行不级联**——`goal_reviews` 里的 `scheduler_job_id` 指向宿主定时服务里真实存在的任务，级联删掉这一行会留下一个没人认领、仍会触发的定时任务。所以 `goal_reviews` 的外键不带 `ON DELETE CASCADE`，必须由清除协议先取消定时任务（见下文「目标的删除与清除」）。

```sql
CREATE TABLE goals (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  parent_id TEXT,                                               -- 只允许一层：父必须是顶层
  category TEXT NOT NULL,
  title TEXT NOT NULL,                                          -- 用户的话
  user_words TEXT,                                              -- 用户原话摘录（可与 title 相同）
  summary TEXT,                                                 -- 模型提炼；与 user_words 分开存
  status TEXT NOT NULL,                                         -- 业务状态：只有这三个，没有"暂停"
  lifecycle TEXT NOT NULL DEFAULT 'live',                       -- 生命周期：与业务状态正交；显式状态，不靠时间戳推断
  origin TEXT NOT NULL,                                         -- user|agent（agent 提出的需确认）
  confirmed_at INTEGER, confirmed_by TEXT,                      -- 确认的时间与操作员标识（v1 经控制台 RPC，见 5.2）
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  notify_policy TEXT NOT NULL DEFAULT 'off',
  sort_order REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT,                                         -- 服务端签发，保证"创建恰好一次"
  revision INTEGER NOT NULL,
  completed_at INTEGER, deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (category IN ('travel','money','other')),
  CHECK (status IN ('proposed','active','completed')),
  CHECK (lifecycle IN ('live','deleted','purging')),
  CHECK (origin IN ('user','agent')),
  CHECK (sensitivity IN ('normal','sensitive')),
  CHECK (notify_policy IN ('off','digest','on')),
  CHECK (parent_id IS NULL OR parent_id <> id),
  CHECK (status <> 'proposed' OR origin = 'agent'),             -- 只有 Agent 提出的目标才处于待确认
  CHECK (status <> 'proposed' OR (confirmed_at IS NULL AND notify_policy = 'off')),
  CHECK (origin = 'user' OR status = 'proposed' OR (confirmed_at IS NOT NULL AND confirmed_by IS NOT NULL)),
  CHECK ((status = 'completed') = (completed_at IS NOT NULL)),
  CHECK ((lifecycle = 'live') = (deleted_at IS NULL)),
  FOREIGN KEY (owner_id, parent_id) REFERENCES goals(owner_id, id)          -- 不级联：子目标由清除协议先处理
) STRICT;
CREATE UNIQUE INDEX goals_idem ON goals(owner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX goals_list ON goals(owner_id, lifecycle, status, sort_order);

CREATE TABLE goal_entries (                                     -- 只追加的进展条目
  owner_id TEXT NOT NULL, id TEXT NOT NULL, goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  text TEXT NOT NULL,
  author TEXT NOT NULL,
  effective_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  task_id TEXT, claim_id TEXT,                                  -- 可选指针；无外键，写入时服务端校验（见「引用的口径」）
  retracted_at INTEGER,                                         -- 撤回而不是改写
  PRIMARY KEY (owner_id, id),
  CHECK (kind IN ('note','milestone','review','break','system')),
  CHECK (author IN ('user','agent','system')),
  CHECK (claim_id IS NULL OR task_id IS NOT NULL),              -- 声明必须带上它所属的 Task
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE goal_links (                                       -- 服务端校验的受限多态关联，见「引用的口径」
  owner_id TEXT NOT NULL, id TEXT NOT NULL, goal_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  ref_id TEXT NOT NULL, created_at INTEGER NOT NULL,
  target_gone_at INTEGER,                                       -- 对账发现被引用对象（Task、文件、偏好或 watch，不是所属 Goal）已被清除时标记；读取时显示"已清除"
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, goal_id, kind, ref_id),
  CHECK (kind IN ('task','vault_file','preference','watch')),
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id) ON DELETE CASCADE
) STRICT;
-- "Task 至多属于一个 Goal"（第 3 节）由数据库保证
CREATE UNIQUE INDEX goal_links_task_once ON goal_links(owner_id, ref_id) WHERE kind = 'task';

CREATE TABLE goal_metrics (                                     -- 可选度量，见第 6 节
  owner_id TEXT NOT NULL, id TEXT NOT NULL, goal_id TEXT NOT NULL,
  name TEXT NOT NULL, unit TEXT NOT NULL,
  target REAL, current REAL, as_of INTEGER,
  source TEXT NOT NULL,
  task_id TEXT, claim_id TEXT,                                  -- source='claim' 时都必填；无外键，写入时校验"声明属于该 Task"
  PRIMARY KEY (owner_id, id),
  CHECK (source IN ('manual','claim')),
  CHECK ((source = 'claim') = (task_id IS NOT NULL AND claim_id IS NOT NULL)),
  CHECK (claim_id IS NULL OR task_id IS NOT NULL),
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id) ON DELETE CASCADE
) STRICT;

CREATE TABLE goal_reviews (                                     -- 第二阶段：定期回看；见第 7 节。拥有定时任务，不级联
  owner_id TEXT NOT NULL, id TEXT NOT NULL, goal_id TEXT NOT NULL,
  cadence TEXT NOT NULL,
  next_review_at INTEGER NOT NULL, question TEXT,
  scheduler_job_id TEXT, scheduler_revision INTEGER, session_key TEXT NOT NULL, cron_tag TEXT NOT NULL,
  status TEXT NOT NULL,
  ignored_count INTEGER NOT NULL DEFAULT 0,                    -- 只统计已送达且超窗未回应的提醒（7.1）
  tz TEXT NOT NULL,                                             -- IANA 时区，周期推进用，不随机器时区变（7.4）
  last_run_at INTEGER, last_outcome TEXT,
  notified_at INTEGER, delivered_at INTEGER, responded_at INTEGER,  -- 最近一次通知的三个时间（7.3）
  PRIMARY KEY (owner_id, id),
  CHECK (cadence IN ('weekly','monthly','quarterly','once')),
  CHECK (status IN ('pending_schedule','scheduled','firing','done','cancelling','cancelled')),
  CHECK (last_outcome IS NULL OR last_outcome IN ('done','missed_skipped','skipped_limit','auth_failed')),
  CHECK (ignored_count >= 0),
  CHECK (status NOT IN ('scheduled','firing') OR scheduler_job_id IS NOT NULL),
  CHECK (status <> 'cancelled' OR scheduler_job_id IS NULL),    -- 只有定时任务确认移除后才能置 cancelled：这是清除的闸门
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id)             -- 不级联
) STRICT;
CREATE INDEX goal_reviews_open ON goal_reviews(owner_id, status) WHERE status IN ('cancelling','scheduled','firing');
-- 第二道闸门：只有已取消且不再持有定时任务的回看才允许被删除（建议实现）。Nexus 的迁移器直接对每个迁移调用 `db.exec(migration.sql)`（`extensions/nexus-agent-core/src/store/kernel.ts`），不按分号切割，完整的 CREATE TRIGGER … BEGIN … END 机制上可用；只需在 Nexus worker 的真实迁移测试里执行一次
CREATE TRIGGER goal_reviews_guard BEFORE DELETE ON goal_reviews
WHEN OLD.status <> 'cancelled' OR OLD.scheduler_job_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'goal review must be cancelled before delete'); END;

-- 清除 run：进入 purging 的同一事务里写入，保存稳定的 purge_id 与原始请求者；一个目标一生只有一个
CREATE TABLE goal_purge_runs (
  owner_id TEXT NOT NULL, goal_id TEXT NOT NULL,
  purge_id TEXT NOT NULL,                                       -- 服务端随机生成，前缀 GPG_，在 {owner, 目标清除域} 内唯一；契约同文件库设计第 6 节（不要求 owner 全局唯一，也不与文件库共用占位表）
  requested_by TEXT NOT NULL, requested_at INTEGER NOT NULL,    -- 原始请求者；续跑的 coordinator 不改写它
  -- 没有 phase 列：G1→G3 的进度由持久状态推出（lifecycle='purging'、goal_reviews 的 status），不另存阶段
  worker_attempt_id TEXT, worker_lease_until INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, goal_id),
  UNIQUE (owner_id, purge_id),                                  -- {owner, 目标清除域} 内唯一；与 goal_purge_receipts 的同名约束合起来覆盖"进行中 + 已完成"
  CHECK ((worker_attempt_id IS NULL) = (worker_lease_until IS NULL)),
  FOREIGN KEY (owner_id, goal_id) REFERENCES goals(owner_id, id)             -- 不级联：G3 显式先删 run、再删目标
) STRICT;

-- 独立的清除回执，形状同偏好的回执（不留原始文字：只保留标识、审计字段、目标/标题哈希和计数）；不并入 purge_receipts，原因同文件库设计第 6 节。
-- Goals 的回执没有保留期、不压缩、不删除（永久字段：owner_id、id、purge_id、requested_by、executed_at、目标 id 与标题的哈希、各类行数，体积很小，不含原始文字），所以 purge_id 在 {owner, 目标清除域} 内永不复用
CREATE TABLE goal_purge_receipts (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,                     -- owner_id 永久保存在行里（数据库保留范围）；owner-scoped 的 RPC 返回不带 ownerId，那是 API 形状
  purge_id TEXT NOT NULL,                                       -- 取自 run
  goal_id_hash TEXT NOT NULL, title_hash TEXT NOT NULL,
  entry_count INTEGER NOT NULL, link_count INTEGER NOT NULL, metric_count INTEGER NOT NULL, review_count INTEGER NOT NULL,
  requested_by TEXT NOT NULL, executed_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, purge_id),
  CHECK (entry_count >= 0 AND link_count >= 0 AND metric_count >= 0 AND review_count >= 0)
) STRICT;
```

**引用的口径**：`goal_links` 的 `kind + ref_id`、`goal_entries` 与 `goal_metrics` 的 `task_id` / `claim_id`，数据库**无法**验证它们指向同 owner 的真实对象，所以它们**不是**"数据库类型化关联"，而是**服务端校验的受限多态引用**：

- 唯一写入口在**同一事务**里校验：目标存在、属于同一 owner；声明必须属于所给的 Task（`SELECT … FROM claims WHERE owner_id=? AND task_id=? AND id=?`）；文件、偏好、回检同理。
- 不加外键的原因与现有偏好库相同：目标会比 Task 活得久，而现有 Task 清除协议不认识目标；强行加外键会让 Task 的硬清除被一条目标条目卡住，要避免就得改动已发布的清除协议。取舍是**悬空容忍**：指针指向的 Task 或声明被清除后，读取时显示"已清除"，对账任务给 `goal_links` 写 `target_gone_at`，条目文字不改。
- 必须有负例测试：他人的 id、不存在的 id、声明与 Task 不匹配、类型不符，全部拒绝。
- 如果以后要数据库级保证，代价是让 Task 清除协议在 P 步骤里释放目标的指针，那是对已发布协议的改动，需要单独评审。

**目标 ↔ 文件关系的唯一所有者**：这条关系只由 Goals 拥有，存在 `goal_links`（`kind='vault_file'`）；文件库的 `vault_links` 没有 `goal` 类型，不存第二份。需要的两个跨模块操作由 Goals 提供：

- `goalsForFile(owner, fileId)`：文件页面读取“这份文件关联了哪些目标”的投影，只读。
- `detachFile(owner, fileId)`：文件被硬清除时由文件库的清除钩子调用，Goals 在同一个写事务里删除自己的 `goal_links` 行；文件库不直接写 `goal_links`。**钩子按存储能力注册，不按 `goalsEnabled`**：本模块的迁移已安装时钩子总是注册，用户关闭 `goalsEnabled` 后也必须能清掉历史关系；迁移尚未安装（表不存在）时是安全的空操作。`goalsEnabled` 只管入口，不管清理。另提供只读的 `fileHasGoalLinks(owner, fileId)` 供文件库 P5 在删除条目行前确认已无关系。
- 写入口 `nexus_goal_link` / `nexus.goal.link.add` 校验文件时，只读地查询 `vault_files`（存在、同 owner、`state` 不是 `purging`）。**文件库迁移未安装时不能执行这条查询**（那不是"引用不存在"，而是 SQL 的 `no such table`）：写入口先按存储能力判断（迁移记录或表是否存在，不读 `vaultEnabled`），未安装时对 `kind='vault_file'` 返回稳定的 `capability_unavailable`，其他 link kind（Task、声明、偏好、watch）照常工作。目标页上已存在的 `vault_file` 关系（例如从较新的备份恢复而来）在文件库缺失时显示为"文件库不可用"，不报错、不删除。
- 目标被清除时，Goals 级联删除自己的 `goal_links`，没有副本需要清理。
- 测试：双向页面看到同一结果；目标清除或文件清除后，关系只消失一次，另一端不残留。
- **两个模块安装状态的测试矩阵**（四种组合都要有用例）：① 两者都未安装 / 都已安装但 `goalsEnabled`、`vaultEnabled` 任意开关——互不影响；② Vault 已安装、Goals 未安装：文件清除成功（钩子空操作）；③ 两者已安装、`goalsEnabled` 关：文件清除仍清掉历史关系；④ **Goals 已安装、Vault 未安装**：`kind='vault_file'` 的写入返回 `capability_unavailable` 且不执行对 `vault_files` 的查询，其他 link kind 正常，目标页对已有 `vault_file` 关系显示"文件库不可用"。

**目标的删除与清除**（对齐现有「持久、可重入、分阶段」的清除口径）。生命周期的每个转移都是一条**完整赋值**的条件更新（CAS），必须同时满足 `CHECK ((lifecycle = 'live') = (deleted_at IS NULL))`：

| 转移     | 前态                              | 完整赋值                                                                   |
| -------- | --------------------------------- | -------------------------------------------------------------------------- |
| 软删除   | `lifecycle = 'live'`              | `lifecycle='deleted', deleted_at=:now`，`revision+1`                       |
| 恢复     | `lifecycle = 'deleted'`           | `lifecycle='live', deleted_at=NULL`，`revision+1`                          |
| 进入清除 | `lifecycle IN ('live','deleted')` | `lifecycle='purging', deleted_at=COALESCE(deleted_at, :now)`，`revision+1` |
| 离开清除 | 不允许                            | `purging` 只能被 G3 删除行                                                 |

这里 `deleted_at` 同时表示“被删除或被清除的起点”，进入清除时若已有值则保留。三个转移对目标及其子目标一并执行。

- **软删除**：执行上表转移，并把名下所有回看置 `cancelling`。`cancelling` 由维护任务续跑：移除宿主定时任务（任务已不存在视为成功），再置 `cancelled` 并清空 `scheduler_job_id`。软删除的目标不出现在任何工具和默认列表里；**恢复**执行上表转移，回看保持 `cancelled`，由用户重新开启，不会自动恢复提醒。
- **硬清除**：
  - G1 事务：执行“进入清除”转移，**同一事务写入 `goal_purge_runs`**（稳定 `purge_id`、原始请求者 `requested_by`；目标及其子目标各一条，`purge_id` 不同、请求者相同），回看置 `cancelling`（回看触发路径必须检查 `lifecycle='live'`，所以此后不会再触发）。`purge_id` 的生成与重复请求遵循文件库设计第 6 节：生成时在同一事务里确认它不在 `goal_purge_runs` 也不在 `goal_purge_receipts` 里；重复 `purge` 不新建 run，而是走认领流程（持有者活跃 → `worker_active`，空闲或过期 → `resumed` 并继续工作），都带原始 `purge_id` 与 `requested_by`；`purgeStatus`、`purgeReceipts` 只读。
  - G2：逐个回看移除定时任务并置 `cancelled`、清空 `scheduler_job_id`。
  - G3 单个事务，按顺序：① 重新确认该目标名下回看**全部** `cancelled` 且无 `scheduler_job_id`，否则整个事务不执行；② 在删除前统计 `entry_count`、`link_count`、`metric_count`、`review_count`；③ **显式删除** 该目标的 `goal_reviews` 行（回看外键不级联，`cancelled` 的行不会自己消失，不删会被外键拦住）；④ 写 `goal_purge_receipts`（`purge_id` 与 `requested_by` 取自 run）；⑤ 删除该目标的 `goal_purge_runs` 行，再删除目标行（条目、关联、度量随之级联）。有子目标时，子目标各自先完成 G3，再处理父目标。
  - G3 的前置检查不满足时事务不执行，目标停留在 `purging`，由维护任务按 `lifecycle='purging'` 续跑；进程在任何两步之间崩溃都可恢复；续跑的是 coordinator，回执里的 `requested_by` 始终是最初的请求者。**run 的认领、续租、迟到 worker 停止和条件释放，遵循文件库设计第 6 节「清除 run 的租约协议」**（照搬 Task purge 的契约），其中**阶段检查不适用于 Goals**：`goal_purge_runs` 没有阶段列，不返回 `wrong_phase`，G2 / G3 的闸门是 `goal_reviews` 的持久状态（全部 `cancelled` 且无 `scheduler_job_id`），不满足时事务不执行、目标停留在 `purging`；G2 删除宿主定时任务必须幂等（任务已不存在视为成功），G3 事务开头重做持有者校验，不是持有者就整个事务不执行。
  - 第二道闸门（建议实现）：`goal_reviews` 上的 `BEFORE DELETE` 触发器，只允许删除 `status='cancelled'` 且无 `scheduler_job_id` 的行，其余一律中止。
- 回执在数据库里永久保留的字段只有：`owner_id`、`id`、`purge_id`、`requested_by`、`executed_at`、目标 id 与标题的哈希、各类行数；不留原始文字。`purgeReceipts` 是 owner-scoped 的 RPC，返回里不带 `ownerId`，那是 API 形状，不是保留范围。
- 沿用的是现有清除协议“持久、可重入、分阶段”的**原则**，并有自己的 run 表；不复用 `purge_runs`，它的主键是 Task。

**不变量**（每一条的责任归属见约束责任表）：

1. 嵌套一层：`parent_id` 非空时，父行的 `parent_id` 必须为空（事务内检查并有测试）。
2. `status='proposed'` 的目标不能有未取消的回看，且 `notify_policy='off'`（后者是 `CHECK`，前者是事务检查）。
3. 声明指针只能指向"属于该 Task 的声明"，度量 `source='claim'` 时 `task_id` 与 `claim_id` 都必填（`CHECK` + 写入口校验 + 负例测试）。
4. 条目只追加；撤回只置 `retracted_at`，不改文字。
5. 任何目标行和条目都不出现在 claim 链、授权、完成判定的读取路径里（对应硬规则 1、2，用测试守住）。
6. `lifecycle <> 'live'` 的目标不得新增条目、关联、回看，也不得被回看回合读取；所有工具与默认列表只返回 `live`。
7. 一个 Task 至多关联一个目标（部分唯一索引 `goal_links_task_once`）。

**约束责任表**：

| 约束                                                                                                                                                                 | 责任层                                                                | 对应回归测试                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `category` / `status` / `lifecycle` / `origin` / `sensitivity` / `notify_policy` / 条目 `kind` 与 `author` / 回看 `cadence` 与 `status` 与 `last_outcome` 的取值范围 | 数据库 `CHECK`                                                        | 迁移测试：对每个枚举列插入非法值必须失败                                                                                                                     |
| `proposed` 必为 Agent 提出、未确认、静音；已确认的 Agent 目标必须有确认时间与操作员                                                                                  | 数据库 `CHECK`                                                        | 构造非法组合必须失败                                                                                                                                         |
| `completed` 与 `completed_at`、`lifecycle='live'` 与 `deleted_at` 成对出现                                                                                           | 数据库 `CHECK`                                                        | 同上                                                                                                                                                         |
| 回看 `scheduled` / `firing` 必有定时任务 id；`cancelled` 必无                                                                                                        | 数据库 `CHECK`                                                        | 同上                                                                                                                                                         |
| 声明/度量的 `task_id`、`claim_id` 成对                                                                                                                               | 数据库 `CHECK`                                                        | 同上                                                                                                                                                         |
| 一个 Task 至多一个目标                                                                                                                                               | 部分唯一索引                                                          | 把同一 Task 挂到两个目标必须失败                                                                                                                             |
| 创建恰好一次                                                                                                                                                         | 部分唯一索引（幂等键）+ 工具层相似目标拦截                            | 同键重复调用返回同一条                                                                                                                                       |
| 嵌套一层；子目标不能再有子目标                                                                                                                                       | 事务检查                                                              | 三层嵌套被拒；并发创建竞争                                                                                                                                   |
| 指针指向同 owner 的真实 Task / 声明 / 文件 / 偏好 / 回检；声明属于该 Task                                                                                            | 服务端写入口（同一事务校验）                                          | 负例：他人的 id、不存在的 id、声明与 Task 不匹配                                                                                                             |
| 业务状态与生命周期转移的合法顺序（`proposed → active → completed → active`；`live → deleted → live`；`live/deleted → purging`）                                      | 事务协议（单语句 CAS）                                                | 每个非法转移被拒                                                                                                                                             |
| 清除闸门：名下回看全部 `cancelled` 才能进入 G3 的删除；G3 先显式删回看再删目标                                                                                       | 事务检查 + `goal_reviews` 的 `BEFORE DELETE` 触发器                   | 崩溃注入：G1–G3 每个间隙；定时任务移除失败时目标停在 `purging`；带 `cancelled` 回看的目标能被完整清除                                                        |
| 目标 ↔ 文件关系只存一份；文件清除经 `detachFile` 解除                                                                                                                | 模块边界 + 事务协议                                                   | 双向页面一致；任一端清除后关系只消失一次                                                                                                                     |
| 清除 run：稳定 `purge_id`、原始请求者，重复发起走认领流程                                                                                                            | 事务协议 + 主键 `(owner_id, goal_id)` + `UNIQUE (owner_id, purge_id)` | 崩溃续跑后回执的请求者不变；重复 `purge` 得到 `worker_active` 或 `resumed` 并带同一 `purge_id`；同一 owner 的父子目标各有不同的 `purge_id`，两份回执都能写出 |
| 生命周期转移的完整赋值（`deleted_at` 与 `lifecycle` 同步变化）                                                                                                       | 事务协议 + `CHECK`                                                    | 软删除、恢复、从 `live` / `deleted` 进入清除各一例；漏赋值必须被 `CHECK` 拒绝                                                                                |
| `lifecycle <> 'live'` 不新增写入、不被回看读取                                                                                                                       | 事务检查 + 入口层                                                     | 软删除后工具与回看回合均读不到、写不进                                                                                                                       |
| 谁能写（Agent 不能确认、完成、改原话、设频次）                                                                                                                       | 入口层（工具注册表与 RPC scope）                                      | 工具清单快照测试                                                                                                                                             |

### 5.2 写入权限分层（照抄偏好的模式）

| 动作                                         | 谁能做            | 路径                                                                                                                                                                                                                                                                                      |
| -------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户在控制台创建 / 修改 / 完成 / 重开 / 删除 | 用户              | `nexus.goal.*`（`operator.write`），直接 `active`                                                                                                                                                                                                                                         |
| Agent 提出目标                               | Agent             | `nexus_goal_propose`：写 `status='proposed'`、`origin='agent'`；**只是一条建议，不触发任何提醒或主动行为**                                                                                                                                                                                |
| 确认 Agent 提出的目标                        | 用户              | **v1：在控制台“待确认”分组点批准，调用 `nexus.goal.confirm`（`operator.write`）**：同一事务把 `proposed` 置 `active`、写 `confirmed_at` 与 `confirmed_by`（操作员标识）。Agent 在 `nexus_goal_propose` 返回后只会告诉用户“请到目标页确认”，**没有确认工具**。不走通用决策内核，理由见下文 |
| 记进展条目                                   | 用户、Agent、系统 | `nexus_goal_entry_add`（Agent，`author='agent'`，只对 `active` 目标）；用户经 RPC；系统（回看回合）写 `author='system'`                                                                                                                                                                   |
| 关联 Task / 文件                             | Agent、用户       | `nexus_goal_link`（只能链接**同 owner** 的对象）                                                                                                                                                                                                                                          |
| 修改标题、描述、类别、静音                   | 用户              | RPC；Agent 不能改 `user_words`                                                                                                                                                                                                                                                            |
| 完成                                         | 用户              | RPC；Agent 可建议，不能代为完成（待决策，见第 12 节）                                                                                                                                                                                                                                     |
| 软删除 / 硬清除                              | 用户 / 管理员     | `nexus.goal.delete`（write）/ `nexus.goal.purge`（admin，二次确认，写回执）                                                                                                                                                                                                               |

**为什么 v1 不用 `confirm_goal` 决策**（现有实现里没有这个决策效果，不能假设它存在）：

- 现有 `EffectKind` 只有 `issue_action_grant`、`issue_standing_grant`、`set_preference`、`acknowledge` 四个（`extensions/nexus-agent-core/src/store/decision-types.ts`），`decisions` 表用 `CHECK` 固定了这四个值。加第五个不是小改动，需要同时改：`EffectKind`、决策目录、request / resolver 分派、`effect_payload`（现在只有 `set_preference` 能带载荷）、决策表 `CHECK`、批准事务里把目标置 `active` 的所有者，以及回归与恢复语义。
- 决策是**绑定 Task** 的：`decisions` 的唯一键含 `task_id`，现有的 `nexus_preference_confirm` 也明确“需要当前对话所属的 Task”。而目标常常在还没有任何 Task 时被提出。
- 退而用 `acknowledge` 也不行：它没有载荷（`CHECK` 只允许 `set_preference` 带载荷），无法指明是哪个目标，也没有 resolver 去写目标。

所以 v1 选**控制台确认**（与偏好的“偏好页 RPC”路径同构，用户在页面上看到的就是服务端生成的目标原文）。若以后希望在聊天里直接确认，再按 `set_preference` 的先例扩展一个 `confirm_goal` 效果，并满足上面列出的全部改动项，且要求提出目标时带一个宿主 Task；这是一个独立工作包，不在 G1。

### 5.3 "创建恰好一次"

Muse 的创建指南反复强调"只创建一条、读回校验"。Nexus 不靠提示词，靠服务端：

- `nexus_goal_propose` 先走**占位**（仿 `nexus_task_reserve`）：服务端按（owner、类别、标题归一化指纹）查相似的进行中目标；有则返回已有目标并提示"更新而不是再建"。
- 创建用服务端签发的幂等键，同键重复调用返回同一条。
- 工具返回体即读回结果（含 `user_words` 与 `summary` 的当前值），不需要模型再读一遍。

---

## 6. 进展、势头与可核验度量

这一节是 Nexus 与 Muse 的主要差异：**进展不只是"说了算"，可以被账本核对**。

### 6.1 三种进展

| 来源             | 例子                                                     | 展示                                                        |
| ---------------- | -------------------------------------------------------- | ----------------------------------------------------------- |
| 自述             | 用户或 Agent 记的笔记："这周看了三家酒店"                | 灰色标签"自述"                                              |
| 关联 Task 的结果 | "机票已订"，条目指向 Task，Task 已成功（完成门禁已通过） | 标签"来自任务"，附 Task 链接                                |
| 关联声明的状态   | 条目 / 度量指向某条 claim                                | 标签随声明状态变化：已声明 / 已被证据支持 / 已核验 / 被反驳 |

条目显示的是**声明当前的状态**，不是写入时的快照；声明被撤回或被反驳时，条目旁的标签随之变化，条目文字不改。

### 6.2 度量（可选）

用户可以给目标加度量：名称、单位、目标值、当前值。

- `source='manual'`：**用户 / 操作员**经 `nexus.goal.metric.set` 填写，标签"自述"。v1 的 Agent 工具清单里没有度量写入工具；若以后要让 Agent 写度量，必须显式新增工具，并写明风险档、目标状态限制（仅 `active` 且 `lifecycle='live'`）、幂等键与来源身份，不能隐式开放。
- `source='claim'`：当前值来自某条 claim 的值，随声明状态显示；财务数字在财务记录模型（G5a）就绪前一律只能是 manual。
- 度量不触发任何动作；达到目标值只会生成一条系统条目和一条通知，不会自动完成目标。

### 6.3 势头

Muse 有"势头"的概念：后台进程评估目标是否在推进，并给出调整建议。Nexus v1 **不做模型评估**，原因：势头是主观判断，没有口径就不应当作事实展示。替代做法：

- 页面显示**可数的事实**：最近一条条目的时间、关联 Task 数及其状态分布、距下次回看的时间。
- 若后期做势头，则要求：每次评估记录输入（用了哪些条目、Task、度量）、规则或模型版本，标注"估计"，不得用来决定是否提醒（避免用一个不可校验的判断驱动主动行为）。

---

## 7. 定期回看与主动行为

### 7.1 约束

- 目标本身不运行任何东西；主动行为只来自**已登记的定期回看**。
- 回看的时间表由用户或确认过的设置决定，Agent 不能自行加密频次；系统有每目标、每 owner 的上限。
- 提醒必须可静音（`notify_policy`）；连续被忽略 N 次（待定，建议 3）后，下一次回看改为询问一次"要改频率还是停掉"，用户不回应则自动暂停该回看（借鉴 Muse 人际类别的规则）。**"被忽略"只统计已确认送达、且超过响应窗口仍未回应的提醒**；机器休眠、应用没开、渠道离线导致没送达的，不计入（7.3、7.4）。
- 免打扰时间读偏好库（偏好不是授权，但可以决定"何时打扰"）。
- 带金额的目标，通知文案不含金额，只说"需要你看一下"和页面链接。

### 7.2 实现路径（三选一）

| 选项                                            | 做法                                                                       | 优点                     | 问题                                                                            |
| ----------------------------------------------- | -------------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- |
| A 泛化 Watcher                                  | 给 `watches` 增加主体类型，目标回看用同一套调度、认证、退避                | 复用最多，认证协议已验证 | `watches.task_id NOT NULL` 且回合只放行 Task 相关工具；要迁移表并改认证与工具门 |
| **B 独立的 `goal_reviews`，复用调度与认证模块** | 新表；把 Watcher 的"cron 回合认证"抽成共用函数，目标回看用自己的工具白名单 | 不动现有表，风险隔离     | 需要抽取共用代码并重新回归 Watcher                                              |
| C 每次回看建一个 Task                           | 到点由系统建一个"回看"Task，完成条件是"用户已确认"                         | 完全复用 Task            | Task 堆积；Task 语义被拉伸                                                      |

**建议 B。** 回看回合的权限：只读目标、关联 Task 状态、最近条目、度量；可写系统条目、发通知；**没有任何 `nexus_action_*`、`nexus_decision_*`、`nexus_preference_*`、`nexus_watch_create`**（与现有回检回合一致，认证失败即不给任何工具，fail closed）。回合产出是"进展草稿 + 通知"，**不会自动改变目标状态或创建 Task**；要建 Task 必须用户在对话里发起。

### 7.3 通知

依赖状态文档 5.2 的通知工作包。v1 之前用控制台徽标 + 对话内提示；通知出口落地后接上。

本机运行下，每条回看通知记录三个时间：**生成**、**送达**（渠道确认或用户界面实际展示）、**已读 / 已回应**；只有"送达"之后才开始计忽略窗口。送达不可确认的渠道，按"未送达"处理，下次打开应用时在控制台补显示一次，而不是重复发。

### 7.4 本机运行下的错过、补跑与限额

- **到期判断**：回看以 `next_review_at` 为准，调度器（宿主定时服务）负责唤起；唤起时先检查"是否仍到期、是否已有未结束回合、是否超限"，不满足就不执行。
- **错过**：机器休眠或网关停止期间到期的回看，唤醒后**同一目标最多补一次**，多个周期合并为一次（不按错过次数逐个补）；若错过超过一个完整周期（例如每周回看却停了两周），改为跳过本次、记一条系统条目"已跳过"，下一个周期照常。这与 Watcher 的 `missed` 语义同类，但目标回看没有"耗尽"概念，不会升级成告警。
- **集中到期**：唤醒后多个目标同时到期，按优先级和上次回看时间排队，每次唤醒最多执行 N 个（建议 2），其余顺延，避免用户一开盖就被一串模型回合占用机器和额度。
- **限额**：每 owner 每周回看回合数、每回合 token 上限可配置；超限不补跑，只记录"已跳过（限额）"。
- **时区**：`next_review_at` 存绝对时间，周期推进按目标记录的 IANA 时区计算，不随机器当前时区漂移。
- **免打扰**：读偏好库的免打扰时间；落在免打扰内的回看顺延到窗口结束后，而不是丢弃。
- **宿主定时服务的行为**：重启后的错过补跑有现成逻辑，但休眠唤醒的实际表现、补跑是否有上限、是否会同时触发大量任务**未核实**（G-S1），在验证前按"可能一次性到期多个"做防护。

---

## 8. 类别、安全边界与隐私

### 8.1 v1 类别

| 类别     | 内容                       | 主要关联                                     |
| -------- | -------------------------- | -------------------------------------------- |
| `travel` | 旅行相关的长期意图         | Journey 的 Task、行程文件、旅行偏好          |
| `money`  | 省钱、预算、订阅、退款追回 | Moneywise 的 Task、账单文件、财务记录（G5a） |
| `other`  | 兜底                       | —                                            |

Muse 的职业、兴趣、效率、人际可以日后按需增加。**健康类别 v1 不做**：涉及病史、药物，隐私与合规要求高，PII 脱敏又推迟到 M3。人际类别涉及第三人信息与外发消息，也先不做。

### 8.2 类别规则（写进技能，服务端兜底）

| 类别     | 规则                                                                                                                                                                                            | 服务端兜底                                |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 通用     | 不羞辱、不拿"断档"施压；问题一次只问一个；用户原话保留                                                                                                                                          | 一轮最多一条 `nexus_goal_propose`（幂等） |
| `money`  | 只做教育、整理和决策卫生，**不给个性化投资 / 税务 / 法律 / 保险建议**；不推荐具体证券或加密交易；移动资金、取消服务、开争议、联系机构必须先问——在 Nexus 里这些本来就是 R2 / R3 动作，只能走决策 | 目标不产生授权；金额型动作仍是 R3         |
| `travel` | 预算、同行人、证件类信息属于敏感；护照号、会员号不进目标和条目                                                                                                                                  | `sensitivity` 与文本扫描（见 8.3）        |

### 8.3 敏感与隐私

- 带金额、收入、债务、账户的目标默认 `sensitivity='sensitive'`：不进通知文案、不进事件载荷、不进预览片段、不进未来的 Wiki 或记忆桥接；Agent 工具返回时仍可读，但标注敏感。
- 条目和目标文本写入前做**敏感值扫描**（证件号、卡号形态）；命中则拒绝写入并提示"请不要在目标里保存这类号码"（对应技能评估里的 `secure-flight-checkout` 场景）。
- 财务数字类度量在 G5a 之前只允许手填，且标注自述。
- 清除：硬清除目标时一并清除条目、度量、关联和回看，写回执（只保留标识、审计字段、目标/标题哈希和计数，不留原始文字）；**已关联的 Task 与文件不被删除**，仅解除关联；已挂证据的声明不受影响。
- 事件 `goal_changed` 只带 id、动作和状态，不带标题和文本。

---

## 9. 接口

### 9.1 Agent 工具

| 工具                   | 作用                                                 | 风险档       | 说明                                                    |
| ---------------------- | ---------------------------------------------------- | ------------ | ------------------------------------------------------- |
| `nexus_goal_search`    | 按标题、类别、状态检索目标                           | R0           | 返回前 N 条与是否完整；`sensitive` 目标只返回标题级摘要 |
| `nexus_goal_get`       | 读单个目标：基本信息、最近条目、度量、关联、回看设置 | R0           | 声明状态实时读取                                        |
| `nexus_goal_propose`   | 提出一个目标                                         | R0（本地写） | 返回已有相似目标则不新建；写 `proposed`                 |
| `nexus_goal_entry_add` | 记一条进展                                           | R0（本地写） | 只对 `active` 目标；可带 `taskId` / `claimId`           |
| `nexus_goal_link`      | 把 Task 或文件关联到目标                             | R0（本地写） | 同 owner 校验                                           |

不提供：Agent 写度量（用户经 `nexus.goal.metric.set` 填）、Agent 确认目标、修改用户原话、完成目标、删除、清除、设置回看频次。确认只有用户在控制台做（`nexus.goal.confirm`，5.2）。

### 9.2 运维 RPC

`nexus.goal.list / get / create / update / confirm / complete / reopen / delete / restore / purge / purgeStatus / purgeReceipts`、`nexus.goal.entry.add / retract`、`nexus.goal.link.add / remove`、`nexus.goal.metric.set`、`nexus.goal.review.set / cancel / list`（第二阶段）。scope 沿用 read / write / admin。

### 9.3 事件

`goal_changed`（创建、确认、更新、完成、重开、条目新增、关联变化、删除、清除），经 outbox 至少一次。

### 9.4 配置开关

`goalsEnabled`（默认关）、`goalReviewsEnabled`（需要 `goalsEnabled` 和 `watchersEnabled`）、`goalMaxActivePerOwner`、`goalReviewMinIntervalHours`、`goalReviewsMaxPerWeek`、`goalReviewMaxTokens`、`goalReviewCatchupPerWake`。清除 run 的租约时长不是配置项，用文件库设计第 6 节的 `DEFAULT_PURGE_RUN_LEASE_MS`（默认 30 000 毫秒；Task purge、文件库、Goals 三者引用同一个常量，cutover 见该节租约协议第 5 条）。

### 9.5 控制台页面

新增"目标"标签（参考 Muse 的 Goals 页）：

- 列表：进行中 / 已完成两个分组；顶层目标下缩进显示子目标（一层）；`proposed` 目标单列"待确认"并有批准按钮；每行显示类别、关联 Task 数及状态分布、最近条目时间。
- 详情：标题与用户原话、模型提炼（标注）、度量（带"自述 / 已被证据支持 / 已核验"标签）、进展时间线（条目 + 关联 Task 的结果）、关联的 Task 与文件、回看设置与下次时间。
- 按钮：完成 / 重开、重命名、静音、添加条目、关联、删除（说明是软删除，另有"永久清除"并二次确认）。
- 不做拖拽排序（v1），用排序按钮或手填序号。

---

## 10. 与其他模块的集成

| 模块      | 集成点                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task      | `nexus_task_create` 可带 `goalId`（可选）；Task 页显示所属目标；Task 状态变化触发目标页刷新（事件）                                                        |
| 偏好库    | 目标可引用偏好键；目标中提炼出的偏好只能作为 `observed` 候选；偏好不引用目标                                                                               |
| Watcher   | 回看复用调度与认证（7.2 选项 B）；回检耗尽的 Task 若关联目标，在目标页提示                                                                                 |
| 文件库    | 目标可关联文件（行程文档、账单）；目标的"设置笔记"（Muse 放在工作区笔记里）在 Nexus 里是结构化字段 + 关联文件，不是 Agent 可随意读写的目录                 |
| 证据账本  | 条目与度量可指向 claim；不反向写 claim                                                                                                                     |
| 通知      | 回看到点、度量达标、待确认目标的提醒                                                                                                                       |
| 审计      | 创建、确认、完成、删除、清除、回看设置变更写审计                                                                                                           |
| 技能      | 见 10.1                                                                                                                                                    |
| Moneywise | M7 节省核算的口径（已核实账单减少 / 预估节省 / 现金 / 积分）直接用于金钱类目标的条目分类；M8 主动机会发现的结果可以作为"建议"挂到目标，用户同意后才建 Task |
| Journey   | J1（需求澄清）发现长期意图时建议建目标；J13（行程后收尾）关闭相关目标条目                                                                                  |

### 10.1 技能

参考技能评估的目标包结构（3 个主入口 + 2 个独立技能）。建议**不新增第四个主入口**，而是：

- 在 `journey` 与 `moneywise` 主入口里各加一份 `references/goals.md`（旅行类 / 金钱类的创建与持续支持指南）；
- 加一个很薄的 `goals` 入口技能，只处理"没有类别归属"的目标和通用规则，并路由到前两者。

技能只写领域判断：怎么弄清用户想要什么、什么时候提议、怎么问、哪些不能做；硬规则（目标不是授权、不能自称用户确认、幂等创建）在服务端和 Nexus 协议里，不重复写进技能。技能文本不得顺带定义目标的持久契约。

---

## 11. 分期、验收与任务表建议

### 11.1 分期

| 期                                  | 范围                                                                                                                          | 确定性验收                                                                                                                                                                                                              |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0** 设计评审                     | 本文定稿；确认类别范围、确认路径、回看路径（7.2）                                                                             | 评审通过；3.2 的概念模型文字修订                                                                                                                                                                                        |
| **G1** 目标核心                     | 表与迁移；`nexus_goal_search / get / propose / entry_add / link`；RPC；"目标"标签页；事件；软删除与硬清除（回执）；敏感值扫描 | 创建幂等与相似目标拦截；一层嵌套；`proposed` 不触发任何主动行为；确认只走控制台、Agent 没有确认入口；Agent 不能改用户原话；目标与条目不出现在授权、完成判定、claim 链的读取路径里；清除后无残留且不删关联对象；归属隔离 |
| **G2** 进展与度量                   | 条目指向 Task / claim 并显示实时状态；度量（manual / claim）；页面标签                                                        | 声明被反驳后标签变化；撤回条目不改文字；claim 度量必须有同 Task 的声明                                                                                                                                                  |
| **G3** 定期回看（前置：G-S1 spike） | `goal_reviews`；抽出共用的 cron 回合认证；回看回合的白名单；忽略计数与自动暂停；通知接入                                      | 认证失败不给任何工具；回合内没有任何动作 / 决策 / 偏好工具；限额；被忽略后询问并暂停；未送达不计忽略；休眠后错过的回看合并补一次或跳过；唤醒时限量执行；跨时区周期不漂移；Watcher 回归不退化                            |
| **G4** 技能与场景                   | `journey` / `moneywise` 的目标参考文件；评测场景                                                                              | 创建只一条、已有则更新、不给个性化财务建议、不把号码写进目标                                                                                                                                                            |
| 后期                                | 简报、势头（估计）、健康 / 人际类别、目标专属会话                                                                             | 另行评审                                                                                                                                                                                                                |

### 11.2 任务表建议

任务表目前没有目标相关的行，建议补充：

| 分类                    | 子任务                                | 建议优先级 / 里程碑 | 说明                               |
| ----------------------- | ------------------------------------- | ------------------- | ---------------------------------- |
| Nexus Agent Core Plugin | Nexus Goals（长期目标）               | P1 / M3             | G1–G2                              |
| Nexus Agent Core Plugin | Goals 定期回看                        | P1 / M3             | G3；依赖通知（第 79 行）和 Watcher |
| Journey / Moneywise     | Skills 设计：goal-setting-and-support | P1 / M3             | G4，随上面两行                     |
| Host 主程序             | 目标页 UX 设计                        | P1 / M2             | UX 先于工程                        |

试点路线图（`docs/nexus/nexus-development-roadmap-2026-10-02.md`）把首发切口放在订餐与旅行委托，Moneywise 已推迟，所以目标功能**不进试点范围**；上面的 M3 是在试点之后的建议。

---

## 12. 风险与待决策

### 12.1 风险与未核实项

| 编号   | 风险 / 未核实项                                                                                   | 处理                                                            |
| ------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| R1     | 抽取 Watcher 的认证代码会影响已验证的回检路径                                                     | G3 前先为认证函数补测试；回归 `watch-flow`                      |
| R2     | 目标文本含敏感信息（金额、行程、同行人）                                                          | 8.3 的敏感级别、扫描、通知文案规则                              |
| R3     | 主动提醒让用户反感，或被滥用为营销                                                                | 频次上限、静音、被忽略后暂停；Agent 不能自行设置频次            |
| R13    | 误以为存在 `confirm_goal` 决策效果，实现者去调用不存在的接口（影响：返工）                        | 5.2 已写明 v1 走控制台 RPC；扩展决策内核是独立工作包            |
| R14    | 目标指针无外键，目标比 Task 活得久而出现悬空（影响：显示与对账）                                  | 读取时显示“已清除”，对账写 `target_gone_at`；写入口负例测试     |
| R15    | 回看有外部定时任务，清除时被级联删行而遗留（影响：幽灵提醒）                                      | 回看外键不级联；清除闸门（`cancelled` 才能删）；崩溃注入        |
| R4     | `proposed` 目标积压                                                                               | 页面"待确认"分组、过期自动归档（时限待定）                      |
| R5     | 模型提炼的 `summary` 与用户本意偏离                                                               | 与 `user_words` 分开存并标注；页面优先显示原话                  |
| R6     | 命名与概念混淆（3.2、3.3）                                                                        | 命名纪律、设计文档表头修订                                      |
| R7     | 回看回合是否能稳定读取多张表并受工具白名单约束                                                    | 复用 Watcher 的白名单机制；G3 验证                              |
| R8     | 单机 `ownerId` 占位                                                                               | 接账号前不对 Relay、移动端开放                                  |
| R9     | 目标与 Task 的"完成"语义被用户混淆                                                                | 页面分别标注；Goal 完成时列出未结束的关联 Task                  |
| R10    | 本机休眠 / 退出导致回看错过，被误判为"用户忽略"（影响：打扰与误暂停）                             | 忽略只统计已送达的提醒（7.1、7.3）；错过合并补一次或跳过（7.4） |
| R11    | 唤醒后多个回看同时到期，占用机器与模型额度（影响：体验与费用）                                    | 每次唤醒限量、每周限额、回合 token 上限（7.4）                  |
| R12    | 机器随用户换时区，回看时间漂移（影响：旅行类目标尤甚）                                            | 回看按固定 IANA 时区推进（7.4）                                 |
| G-S1   | 宿主定时服务在休眠唤醒后的补跑行为、上限、是否同时触发大量任务（影响：回看是否按 7.4 的假设工作） | G3 前做 spike；结论前按最坏情况防护                             |
| 未核实 | 通知出口能否在插件内外发，及能否确认送达（状态文档 5.2）（影响：忽略计数的口径）                  | 通知方案定后再接 G3；确认不了送达就按"未送达"处理               |

### 12.2 待决策

1. 是否接受"目标不是授权、不是证据"的硬规则，以及 Agent 提出的目标必须经用户确认才生效？
2. v1 类别只做 `travel` 与 `money`（健康、人际暂不做）是否接受？
3. 回看实现选项 B（独立 `goal_reviews`，抽取共用认证）还是 A / C？
4. 目标"完成"是否只能用户操作（Agent 只可建议）？
   4a. 确认 Agent 提出的目标：v1 走控制台 RPC（本文默认）；是否接受“聊天内确认”留给后续、需扩展决策内核的独立工作包？
5. 嵌套一层的限制是否沿用？
6. 默认的忽略阈值（建议 3 次）、每 owner 活跃目标上限、回看最小间隔？
7. 度量里的财务数字在 G5a 之前只能手填，是否接受？
8. 是否在任务表补上 11.2 的行，里程碑定在 M3？
9. 设计文档 §4 概念模型表头是否同意改为"事项"并加入 L4 Goal？
10. 技能放置：`journey` / `moneywise` 的参考文件 + 薄入口 `goals`，是否接受（10.1）？
11. 本机运行下回看是"尽力而为"（错过合并补一次、超过一个周期则跳过）是否接受？每次唤醒最多补几个（建议 2）、每周回看次数上限多少？
12. "被忽略"只统计已确认送达的提醒是否接受？在通知渠道确认不了送达之前，是否干脆不做自动暂停，只做静音和手动停？

---

## 附：资料索引

- Muse（概念参考，转述，非拷贝）：`MuseAI-Skills/home/hatch/docs/goals.md`、`MuseAI-Skills/opt/hatch/skills/goals/SKILL.md`、`MuseAI-Skills/opt/hatch/skills/goals/creation/{career,health,interests,money,productivity,relationships,something_else}.md`、`MuseAI-Skills/opt/hatch/skills/goals/guides/<category>/scaffold.md`、`MuseAI-Skills/opt/hatch/skills/muse_db/references/schema.md`（`goals` 表组）、`MuseAI-Skills/home/hatch/docs/client-surfaces.md`（Goals 标签页的描述）
- Nexus：`extensions/nexus-agent-core/nexus-agent-core-design.md`（§4 概念模型与命名纪律、§6.1 关系完整性、§10 Watcher、§11 偏好、§14 已知缺口）、`extensions/nexus-agent-core/docs/nexus-agent-core-museai-skills-assessment.md`（技能包结构与 G 系列缺口）、`extensions/nexus-agent-core/docs/nexus-agent-core-plugin-status-and-remaining-work.md`（通知、审计、收口项）、`extensions/nexus-agent-core/docs/nexus-agent-core-personal-file-vault-design.md`
- 项目：`docs/nexus/nexus-architecture-design-2026-10-02.md`（ADR-03）、`docs/nexus/nexus-development-roadmap-2026-10-02.md`
