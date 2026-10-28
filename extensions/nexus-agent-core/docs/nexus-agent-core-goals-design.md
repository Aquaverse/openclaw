# Nexus Goals（长期目标）设计方案

> 状态：设计草案 v0.3，2026-10-27（v0.1 为 2026-10-22；v0.2、v0.3 同日，按用户的 Muse 截图修订）。2026-10-27 用户已就第 0 节的七项决定拍板，并与 Muse 快照做了核对（2.5）。**G1 已实现并通过真实界面验收（2026-10-27，见第 13 节），G2 已实现并通过 Mac 验收（“被反驳”标签界面无入口，未实机验证，见第 14 节）**；G2.1 补丁与 G-S1 结论见第 15 节；G3 起的表、工具、RPC、配置名仍是提案，不是契约。
> 任务表里**没有对应行**。本文参考 Muse 的 Goals（`https://muse.ai/goals`），按 Nexus 的架构重新设计，并建议在任务表补行（见第 11 节）。
> 相邻文档：`extensions/nexus-agent-core/nexus-agent-core-design.md`（Task、Watcher、偏好库）、`extensions/nexus-agent-core/docs/nexus-agent-core-personal-file-vault-design.md`（文件库）、`extensions/nexus-agent-core/docs/nexus-agent-core-plugin-status-and-remaining-work.md`。

---

## 0. 已定的决策（2026-10-27）

| #   | 决定                                                                                                                                                                                                          | 对本文的影响                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 接受硬规则（目标不是授权、不是证据；Agent 提出的目标须用户确认才生效）；同时用户可以在目标页**自己发起创建**，参考 Muse 的 Goals 页（用户给了截图：一个类别选择页，点类别后在聊天里一问一答）                 | 9.6 重写为「从目标页发起的创建对话」；见 2.5                                                                                                             |
| 2   | v1 类别：**`finance`、`interests`、`something_else`** 三类。旅行是短期事项，不算长期目标；`something_else` 就是兜底，不再另设 `other`；健康、人际暂不做，职业、效率日后再说                                   | 8.1、8.2、5.1 的 `category`、4、10、10.1 已改；DDL 的 `CHECK` 先写全 Muse 的 7 个值，v1 由写入口只放行三类（**用户已确认**，避免以后开放新类别要重建表） |
| 3   | 目标"完成"只能用户操作，Agent 只可建议                                                                                                                                                                        | 5.2 不变                                                                                                                                                 |
| 4   | 确认 Agent 提出的目标：v1 走控制台"待确认"分组 + `nexus.goal.confirm`；同时目标页有用户自己发起创建的入口，创建过程中由 Agent 在聊天里问相关问题（**不是服务端模板**，2026-10-27 按 Muse 截图与创建指南核对） | 5.2 加一行；9.6 重写                                                                                                                                     |
| 5   | 嵌套一层：目标可以有子目标，子目标下不能再有                                                                                                                                                                  | 不变                                                                                                                                                     |
| 6   | 每个用户活跃目标上限 **20**                                                                                                                                                                                   | 9.4 已写明计数口径                                                                                                                                       |
| 7   | L3 的对外叫法改为"**事项**"（代码标识符不变）；Goal 是 **L4 中长期目标**                                                                                                                                      | 3.2、3.4 已改；主设计文档 §4 的表同步改了                                                                                                                |
| 8   | （截图后补）**从目标页发起的创建对话，聊完直接创建，不再多一步确认**：Muse 里聊到目标明确就存进"进行中"，后续的"目前存了多少"之类问题不影响创建；完成靠用户手动勾选；详情、已完成列表、页面菜单的样子见 9.5   | 新增 `created_via` 列、`nexus_goal_create` 工具与"创建授权"（5.2、9.1、9.2、9.6）；硬规则 3 改写（1.3）；Agent 自发提出的目标仍走"待确认"                |

---

## 1. 为什么要有 Goals，以及它不是什么

### 1.1 现状的缺口

Nexus 现在有两种"记着用户的事"的机制：

- **Task**：一次有边界的委托（订一张桌子、规划一次行程），天到周的生命周期，有完成门禁——必须所有完成条件被证据支持才能标成功。
- **偏好**：稳定的"用户喜欢什么"，不是授权，不参与完成判定。

缺的是第三种：**用户想长期达成的结果**。例如"今年学会拍人像""一年省下 5000 美元""把每月订阅花费降到 200 以内"。它的特点是：周期长（月到年）、没有完成门禁、进展是渐进的、一个目标会产生许多个事项（Task）、需要定期回看和提醒。现在这类意图要么被塞进某个 Task 的目标说明里（Task 结束就丢），要么只存在于聊天历史里。

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
3. **Agent 不能自称"用户说过"**。目标要由**用户的一个动作**授权才生效：用户在控制台批准 Agent 自发提出的目标，或用户自己在目标页点类别发起创建对话（这个点击就是授权，Agent 只能在该授权对应的一次创建里写入一条目标，见 5.2 / 9.6）。没有这种授权的目标只能是待确认。无论哪种来源，开启提醒和主动行为都另需用户明确同意（沿用偏好 `stated` 的原则）。
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

**定位差异**：Muse 的 Goals 是生活教练式的（职业、健康、兴趣……），产品是陪伴型智能体。Nexus 是**委托与执行**型：目标的价值在于把中长期意图变成一串可执行、可核验的事项（Task）。v1 的类别是 **finance、interests、something_else** 三类（决定见第 0 节）；旅行是短期事项，不算长期目标。

### 2.5 对照 Muse 快照的核对结果（2026-10-27）

核对对象：`home/hatch/docs/goals.md`、`opt/hatch/skills/goals/SKILL.md`、`creation/{money,interests,something_else}.md`（另四个类别只看了同一结构）、`guides/{money,interests,something_else}/scaffold.md`、`opt/hatch/skills/muse_db/references/schema.md` 的 `goals` 表组、`home/hatch/docs/client-surfaces.md` 里关于 Goals 页的段落。**`https://muse.ai/goals` 网页没读到**：该站点的 robots 规则禁止抓取，我没有用别的办法绕过。随后用户给了三张页面截图（见下面第一条），与快照里的文字相符。

**与第 2.1–2.3 节一致，无需改动的**：只有"进行中 / 已完成"两个状态、没有暂停；只嵌套一层；删除要确认且连子目标一起删；创建分三步（弄清、建唯一一条、提供支持）；每轮最多问一个问题；标题用用户自己的话；建完要读回校验；已有同目标就更新；保存后给出第一个小里程碑；提醒和定期回看只在确有需要时提并要用户确认；目标本身不运行任何东西，后台工作只来自定时任务；简报的时间表由系统控制。

**核对中新发现、已写入本文的**：

- **Muse 里"新建目标"是类别选择页 + 一轮聊天，没有表单。**（截图核对）页面标题 Goals，说明"选一个类别，告诉我你想要什么，我来做一份会随你变化的个性化计划"，下面"Create a goal"列出七个类别（Health、Relationships、Finance、Career、Interests、Productivity、Something else）。点 Finance 后，左侧聊天里自动出现用户消息"I want to start a finance goal"（状态条显示 Starting goal），Agent 回"我先问一个小问题，弄清你想要哪种理财目标"，接着出现**选项卡片**："这个理财目标想先关注什么？"——三个选项（Build up savings / Pay down debt / Take control of spending），选中后作为用户消息发出，Agent 再追问"你存钱是为了什么？"。这与 `creation/money.md` 一致：问题由 **Agent 按创建指南一次问一个**，可选项用一个选项小部件（最多三个具体选项，不放"其他 / 不确定"这类兜底项，选项不能减少用户负担时改为开放提问），**不是服务端写死的问题模板**；意图阶段不建记录，问清后才建唯一一条。`SKILL.md` 区分"Goals 页发起的创建轮"（运行时注入该类别的完整创建指南和安全节）和"在 Goals 页之外发起的创建"（Agent 自己读对应类别的创建文件）；`goals.md` 说"添加子目标"同样是发起一条聊天消息。Nexus 在 9.6 里沿用这个做法；OpenClaw 核心已有 `ask_user` 工具（2–4 个选项，自带"自己输入"出口），可直接承担选项卡片，不必自造。
- **创建之后与页面本身（第二批截图）**：聊完目标明确（本例：理财 → 存钱 → 为将来备用 → 100 万 → 一年内）就**直接出现在 Goals 页"进行中"列表**，没有"待确认"一步；列表行是复选框 + 标题 + 副标题（副标题就是一行现状，如"朝着一年内存到 100 万起步"）。Agent 回复"目标已存入 Goals 页"，接着提第一个小里程碑并追问"目前已经存了多少"——这个追问不影响创建，答案以后用来细化。完成只靠用户**手动勾选**；点标题进入详情卡片（标题、描述、"活动"时间线按天分组，首条是"已添加：<标题>"加现状文字）；详情右上角 ⋯ 菜单有：标为未完成、添加子目标（发起聊天）、重命名、删除；页面右上角 ⋯ 菜单有：显示副标题、自动排序、已完成的目标；"已完成的目标"是一个弹层，按月份分组，每行是已勾选复选框 + 标题 + ⋯（删除），点标题进入同一个详情卡片。
- **Muse 的 7 个类别值**与你列出的一致：health、relationships、finance（库里的值叫 `money`）、career、interests、productivity、something_else。`something_else` 是兜底，所以本文不再另设 `other`。
- **三个 v1 类别的创建与持续支持指南差异**：`money` 有一整节安全规则（只做教育和整理，不给个性化投资 / 税务 / 法律 / 保险建议，不推荐具体证券或加密交易，移动资金、取消服务、开争议、联系机构要先问，收入债务账户属敏感信息），数据来源列了银行聚合、邮件账单、文档和手填数字，并说明"目标不需要账户全覆盖"、接受估算；`interests` 强调不预设用户想组织或量化爱好，探索保持可逆低风险，兴趣消退时问一次并尊重答案，偏好写成普通句子记入条目；`something_else` 只要求先把目标归到最接近的类别再做强领域断言，明显属于专门领域时同时遵守该领域规则。
- **创建指南要求的产出**：用户原话的标题、一行 `current_state`、两三句自然的描述（不带"Focus:"之类的标签，不用"I'll"之类的智能体口吻）、以及写进工作区笔记 `GOAL.md` 的约束和计划。Nexus 对应为：`title` / `user_words`、新增的 `current_state` 字段（5.1 已加）、描述放 `summary`，约束与事实记成 `goal_entries`（`kind='note'`），不另设可被 Agent 任意读写的笔记文件（10 节文件库一行已说明）。
- **表字段上本文 2.2 漏列的**：`value_alignment`、`activity_key`、图标相关三列（`emoji`、`image_relpath`、`icon_generation_status`）、`fixed_position`（固定位置）、`slug`（唯一）、`source`（默认 `user_goal`）。都不是 v1 必需；`pushable` 对应本文的 `notify_policy`。
- **拖拽排序与嵌套只有 Android 有**（iPhone 没有，智能体也不能替用户排序或嵌套）。v1 沿用本文 9.5 的"不做拖拽，用排序按钮或手填序号"。

### 2.4 部署形态差异：Muse 在远程虚拟机，Nexus 在用户本机

Muse 的后台进程、简报和提醒运行在**常开的远程虚拟机**上，时间表由平台控制；Nexus 随 OpenClaw 跑在**用户自己的电脑**上，会合盖休眠、退出应用、换网络、换时区。2.1 里"后台定期写简报""被忽略就询问"这类机制，到本机上会变形：

| 方面           | Muse（远程虚拟机）           | Nexus（用户本机）                                                                                                                                                                       | 对本设计的影响                                                                         |
| -------------- | ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 定时触发       | 平台常开，到点就跑           | 机器休眠或应用退出时不会跑；宿主的定时服务有重启后的错过补跑逻辑（`src/cron/service/timer-runnable.ts` 的 `hasMissedCronSlotSinceLastRun`），但**休眠唤醒后的实际行为与补跑上限未核实** | 回看按"到期判断"而不是"准点触发"设计；唤醒后同一目标最多补一次（7.4）；新增 spike G-S1 |
| "被忽略"的含义 | 提醒总能送达，没响应就是忽略 | 提醒可能根本没送达（机器睡着、应用没开、渠道离线）                                                                                                                                      | 忽略计数只统计**已确认送达且超过窗口未响应**的提醒；未送达不算忽略（7.1、7.3）         |
| 通知渠道       | 平台自带推送                 | 依赖状态文档 5.2 的通知工作包；渠道（OpenClaw 的消息渠道、控制台徽标）只有网关在跑时才可用                                                                                              | 通知记录送达状态；v1 前只有控制台徽标和对话内提示，且只在应用打开时可见                |
| 时区           | 用户设置固定                 | 机器随用户出差，系统时区会变；经常出差或旅居的用户恰好最容易跨时区                                                                                                                      | 回看时间用**固定的 IANA 时区**（取自偏好或首次设置），不随机器时区漂移；展示时再换算   |
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
- 设计文档 §4 的三层表里 L3 一栏写着"目标 = Task"，这是早期口径。Goals 加入后（2026-10-27 已改），**L3 对外叫"事项"（代码标识符仍是 `task`、`nexus_task*`，不改），Goal 作为 L4 中长期目标记入概念模型**（见 3.4）。本文里的 Task 即"事项"，保留英文是因为它们同时是代码里的名字。

### 3.3 与 OpenClaw 的"goal"

架构文档 ADR-03 提到宿主有 `/goal`（会话级目标）和 TaskFlow，它们都绑定 `sessionKey`，不跨会话。Nexus Goal 存在 `nexus.sqlite` 里，**不建在它们上面**，理由与 Task 相同。代码和日志里不允许出现把二者混写的名字。

### 3.4 概念模型

| 层  | 名称                   | 生命周期               | 归属              |
| --- | ---------------------- | ---------------------- | ----------------- |
| L4  | **Goal（中长期目标）** | 月～年，跨事项、跨会话 | Nexus 自有 SQLite |
| L3  | **事项**（Task）       | 天～周，跨会话         | Nexus 自有 SQLite |
| L2  | core flow              | 分钟～小时             | 宿主              |
| L1  | agent session          | 一次对话               | 宿主              |

Goal 与 Task 是**一对多**，Task 至多属于一个 Goal；Task 的完成不改变 Goal 的状态，Goal 的完成不终止尚未结束的 Task（页面提示用户处理）。

---

## 4. 例子：Goals 在 Nexus 里怎么用

1. **兴趣类**。用户在目标页点 `interests`，聊天里 Agent 先问一个小问题（比如想先探索一下，还是想做出成果、养成习惯），用户答"今年学会拍人像"之类的话，Agent 再问现有基础或每周能投入的时间，然后提出目标；目标明确后直接出现在进行中列表，用户的回答记为进展条目。之后用户可以让 Agent 找学习资料、整理练习计划；每个具体动作是一个事项（Task），关联到这个目标。目标本身不运行任何东西。
2. **金融类**。"把订阅费降到每月 200 以内。"Goal 带一个度量（目标值 200、当前值、来源）。当前值由用户手填，或在财务记录模型（G5a）就绪后来自对账结果的声明。Moneywise 的"发现可省的订阅"建议产生事项（取消、降级）；事项成功后，节省额写进 Goal 的进展，并区分"已核实账单减少"与"预估节省"（对应节省核算 M7 的口径）。
3. **定期回看**。Goal 设置每月一次回看：到点时，一个受限的回看回合读取 Goal、关联 Task 的状态和最近条目，生成一条进展草稿，并通知用户。用户确认后记入条目。

---

## 5. 数据模型与写入权限

### 5.1 表（草案）

暂定迁移 id `stage6-0001-goals`（评审与合入时按 `MIGRATIONS` 末尾的实际顺序最终确定），只追加。迁移前置：只依赖已注册的 `stage1-0001-task-core`（目标对 Task、声明、文件等没有外键），与文件库迁移（暂定 `stage5-0001-vault`）互不依赖（文件清除对 `detachFile` 的调用经清除钩子进行，钩子在迁移未安装时是空操作、已安装时不受 `goalsEnabled` 影响，所以任一方先合入都成立；反方向同理，写入口对 `vault_file` 的校验也按存储能力判断，见 §5.1「目标 ↔ 文件关系的唯一所有者」）；两个编号都是暂定，先合入者占用下一个编号；回看的定时任务由宿主定时服务持有，不属于迁移。目标表按 owner 隔离，主键 `(owner_id, id)`；目标模块内部的外键用 `(owner_id, …)` 复合键。**与现有实现的对照**：目标像偏好库那样可以比 Task 活得久，所以对 Task / 声明 / 文件 / 偏好 / 回检的引用**不加外键**，由服务端在事务内校验（理由见下文「引用的口径」）。

**验证状态**：本节 DDL 已在 SQLite 3.45 上建表通过（v0.3 加的 `created_via` 及其两条 `CHECK` 另用最小表验过：创建对话来源直接 `active` 通过、Agent 自发提出且未确认变 `active` 被拒、`origin` 与 `created_via` 不一致被拒、用户来源的 `proposed` 被拒），并用负例试过：用户来源的 `proposed`、未确认的 Agent 目标变 `active`、`deleted` 无时间、同一 Task 挂两个目标、`claim` 度量缺 Task、`cancelled` 仍带定时任务 id、`scheduled` 无任务 id、带回看的目标被直接删除（外键拦住），均被拒绝。另外把生命周期转移（软删除、恢复、进入清除的完整赋值）和 G3 的“先显式删回看、写回执、删 run、再删目标，子目标在先”写成 SQL 跑过：一个目标只能有一个 `goal_purge_runs`，run 存在时直接删目标被外键拦住，回执的 `purge_id` 与 `requested_by` 取自 run；`goal_reviews` 的删除触发器也能拦住未取消的回看；`goal_purge_runs` 的认领与过期接管用与文件库相同的条件语句验证过（活跃持有者拒绝、过期接管保持 `purge_id`）；同一 owner 的父子目标先后完成 G3，两份回执（各自的 `purge_id`）都写出，同一 owner 内重复的 `purge_id`（目标清除域）被约束拒绝。这是单连接顺序模拟，G1–G3 之间的崩溃注入属于实现阶段。

**级联的总规则**：不拥有外部副作用的从属行（条目、关联、度量）可以随目标级联删除；**拥有外部副作用的行不级联**——`goal_reviews` 里的 `scheduler_job_id` 指向宿主定时服务里真实存在的任务，级联删掉这一行会留下一个没人认领、仍会触发的定时任务。所以 `goal_reviews` 的外键不带 `ON DELETE CASCADE`，必须由清除协议先取消定时任务（见下文「目标的删除与清除」）。

```sql
CREATE TABLE goals (
  owner_id TEXT NOT NULL, id TEXT NOT NULL,
  parent_id TEXT,                                               -- 只允许一层：父必须是顶层
  category TEXT NOT NULL,
  title TEXT NOT NULL,                                          -- 用户的话
  user_words TEXT,                                              -- 用户原话摘录（可与 title 相同）
  summary TEXT,                                                 -- 模型提炼；与 user_words 分开存
  current_state TEXT,                                           -- 一行现状（Muse 创建指南要求的 current_state）；用户可改，Agent 只能经条目建议
  status TEXT NOT NULL,                                         -- 业务状态：只有这三个，没有"暂停"
  lifecycle TEXT NOT NULL DEFAULT 'live',                       -- 生命周期：与业务状态正交；显式状态，不靠时间戳推断
  origin TEXT NOT NULL,                                         -- user|agent（agent 自发提出的需确认）
  created_via TEXT NOT NULL DEFAULT 'console',                  -- console（用户在控制台直接建，v1 暂无入口）| creation_chat（用户从目标页点类别发起创建对话，Agent 在授权内写入）| agent_proposal（Agent 自发提出）
  confirmed_at INTEGER, confirmed_by TEXT,                      -- 确认的时间与操作员标识（v1 经控制台 RPC，见 5.2）
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  notify_policy TEXT NOT NULL DEFAULT 'off',
  sort_order REAL NOT NULL DEFAULT 0,
  idempotency_key TEXT,                                         -- 服务端签发，保证"创建恰好一次"
  revision INTEGER NOT NULL,
  completed_at INTEGER, deleted_at INTEGER,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, id),
  CHECK (category IN ('health','relationships','finance','career','interests','productivity','something_else')),   -- 与 Muse 的 7 类同名（money 记作 finance）；v1 只开放 finance / interests / something_else，其余由写入口拒绝（0 节第 2 条），以后开放不需要重建表
  CHECK (status IN ('proposed','active','completed')),
  CHECK (lifecycle IN ('live','deleted','purging')),
  CHECK (origin IN ('user','agent')),
  CHECK (created_via IN ('console','creation_chat','agent_proposal')),
  CHECK ((origin = 'agent') = (created_via = 'agent_proposal')),   -- 创建对话来的目标算用户来源（授权来自用户的点击），Agent 自发提出的才是 agent 来源
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

| 动作                                         | 谁能做               | 路径                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户在控制台创建 / 修改 / 完成 / 重开 / 删除 | 用户                 | `nexus.goal.*`（`operator.write`），直接 `active`                                                                                                                                                                                                                                                                                                                                   |
| **从目标页发起创建对话**（v1 主路径）        | 用户授权、Agent 写入 | 用户点类别 → `nexus.goal.startCreation`（`operator.write`）签发**创建授权**（绑定 owner、会话 key、类别、可选父目标，一次性，默认 2 小时过期，会话结束即作废）→ Agent 在该会话里调 `nexus_goal_create` 写**一条** `active`、`origin='user'`、`created_via='creation_chat'` 的目标。没有有效授权，`nexus_goal_create` 一律拒绝。授权只管"写这一条"，不给别的权限；提醒和回看仍是关的 |
| Agent 提出目标                               | Agent                | `nexus_goal_propose`（Agent 自发提出，或用户在授权之外的普通聊天里说想定目标）：写 `status='proposed'`、`origin='agent'`；**只是一条建议，不触发任何提醒或主动行为**                                                                                                                                                                                                                |
| 确认 Agent 提出的目标                        | 用户                 | **v1：在控制台“待确认”分组点批准，调用 `nexus.goal.confirm`（`operator.write`）**：同一事务把 `proposed` 置 `active`、写 `confirmed_at` 与 `confirmed_by`（操作员标识）。Agent 在 `nexus_goal_propose` 返回后只会告诉用户“请到目标页确认”，**没有确认工具**。不走通用决策内核，理由见下文                                                                                           |
| 记进展条目                                   | 用户、Agent、系统    | `nexus_goal_entry_add`（Agent，`author='agent'`，只对 `active` 目标）；用户经 RPC；系统（回看回合）写 `author='system'`                                                                                                                                                                                                                                                             |
| 关联 Task / 文件                             | Agent、用户          | `nexus_goal_link`（只能链接**同 owner** 的对象）                                                                                                                                                                                                                                                                                                                                    |
| 修改标题、描述、类别、静音                   | 用户                 | RPC；Agent 不能改 `user_words`                                                                                                                                                                                                                                                                                                                                                      |
| 完成                                         | 用户                 | RPC；Agent 可建议，不能代为完成（待决策，见第 12 节）                                                                                                                                                                                                                                                                                                                               |
| 软删除 / 硬清除                              | 用户 / 管理员        | `nexus.goal.delete`（write）/ `nexus.goal.purge`（admin，二次确认，写回执）                                                                                                                                                                                                                                                                                                         |

**为什么创建对话不需要再确认一次**：授权来自用户的点击和随后的回答，用户在对话中看到、答复了每个问题，目标一建好就出现在页面上并可随时重命名或删除；这与 Muse 的体验一致（见 2.5）。风险靠这几条压住：授权一次性且绑定会话与类别；每条目标由服务端检查上限、相似目标和敏感值；`title` / `summary` / `current_state` 在详情里标为"模型整理"（9.5），`user_words` 由服务端从该会话里用户的回复摘取而不是 Agent 填（能否取到见 9.6 待核实点）；目标不是授权也不是证据（硬规则 1、2），不会因为建了目标就多出任何许可。

**为什么 v1 不用 `confirm_goal` 决策**（现有实现里没有这个决策效果，不能假设它存在）：

- 现有 `EffectKind` 只有 `issue_action_grant`、`issue_standing_grant`、`set_preference`、`acknowledge` 四个（`extensions/nexus-agent-core/src/store/decision-types.ts`），`decisions` 表用 `CHECK` 固定了这四个值。加第五个不是小改动，需要同时改：`EffectKind`、决策目录、request / resolver 分派、`effect_payload`（现在只有 `set_preference` 能带载荷）、决策表 `CHECK`、批准事务里把目标置 `active` 的所有者，以及回归与恢复语义。
- 决策是**绑定 Task** 的：`decisions` 的唯一键含 `task_id`，现有的 `nexus_preference_confirm` 也明确“需要当前对话所属的 Task”。而目标常常在还没有任何 Task 时被提出。
- 退而用 `acknowledge` 也不行：它没有载荷（`CHECK` 只允许 `set_preference` 带载荷），无法指明是哪个目标，也没有 resolver 去写目标。

所以 v1 对**Agent 自发提出**的目标选**控制台确认**（与偏好的“偏好页 RPC”路径同构，用户在页面上看到的就是服务端生成的目标原文）。若以后希望在聊天里直接确认这类目标，再按 `set_preference` 的先例扩展一个 `confirm_goal` 效果，并满足上面列出的全部改动项，且要求提出目标时带一个宿主 Task；这是一个独立工作包，不在 G1。

### 5.3 "创建恰好一次"

Muse 的创建指南反复强调"只创建一条、读回校验"。Nexus 不靠提示词，靠服务端：

- `nexus_goal_propose` 先走**占位**（仿 `nexus_task_reserve`）：服务端按（owner、类别、标题归一化指纹）查相似的进行中目标；有则返回已有目标并提示"更新而不是再建"。
- 创建用服务端签发的幂等键，同键重复调用返回同一条；创建授权本身一次性，用掉即失效，所以同一次创建对话里不会建出第二条。
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
- **宿主定时服务的行为**：重启后的错过补跑有现成逻辑，但休眠唤醒的实际表现、补跑是否有上限、是否会同时触发大量任务**未核实**（G-S1），在验证前按"可能一次性到期多个"做防护。 **G-S1 已有源码结论，见第 15.2 节：唤醒后最多 8 个同时跑且无上限，建议改成每个 owner 一个调度员任务。**

---

## 8. 类别、安全边界与隐私

### 8.1 v1 类别

| 类别             | 内容                                                                        | 主要关联                                    |
| ---------------- | --------------------------------------------------------------------------- | ------------------------------------------- |
| `finance`        | 省钱、预算、订阅、退款追回、存钱、还债等（Muse 里叫 `money`）               | Moneywise 的事项、账单文件、财务记录（G5a） |
| `interests`      | 学习、爱好、创作、探索（不预设要量化或组织）                                | 学习资料、笔记、相关文件                    |
| `something_else` | 兜底（不属于前两类的目标；等同 Muse 的 `something_else`，不再另设 `other`） | —                                           |

Muse 共有 7 个类别（health、relationships、finance、career、interests、productivity、something_else）。**v1 只做 finance、interests、something_else 三类**；职业、效率日后按需增加。**健康类别 v1 不做**：涉及病史、药物，隐私与合规要求高，PII 脱敏又推迟到 M3。人际类别涉及第三人信息与外发消息，也先不做。**旅行不是长期目标**：它是短期事项（Task），由 Journey 处理。

### 8.2 类别规则（写进技能，服务端兜底）

| 类别                           | 规则                                                                                                                                                                                                                                                                                  | 服务端兜底                                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 通用                           | 不羞辱、不拿"断档"施压；问题一次只问一个；用户原话保留                                                                                                                                                                                                                                | 一轮最多一条 `nexus_goal_propose`（幂等） |
| `finance`                      | 只做教育、整理和决策卫生，**不给个性化投资 / 税务 / 法律 / 保险建议**；不推荐具体证券、加密交易、税务策略、债务和解方案或保证收益；移动资金、取消服务、开争议、联系机构必须先问——在 Nexus 里这些本来就是 R2 / R3 动作，只能走决策；个性化决定交给持牌专业人士，只帮用户准备问题和材料 | 目标不产生授权；金额型动作仍是 R3         |
| `interests` / `something_else` | 兴趣类：探索保持可逆、低风险，兴趣消退时问一次并尊重答案，不做医疗、法律、金融断言；其他类：先判断最接近的类别再做强领域断言，明显属于专门领域时同时遵守该领域的规则；两者都不在目标里保存证件号、卡号、会员号                                                                        | `sensitivity` 与文本扫描（见 8.3）        |

### 8.3 敏感与隐私

- 带金额、收入、债务、账户的目标默认 `sensitivity='sensitive'`：不进通知文案、不进事件载荷、不进预览片段、不进未来的 Wiki 或记忆桥接；Agent 工具返回时仍可读，但标注敏感。
- 条目和目标文本写入前做**敏感值扫描**（证件号、卡号形态）；命中则拒绝写入并提示"请不要在目标里保存这类号码"（对应技能评估里的 `secure-flight-checkout` 场景）。
- 财务数字类度量在 G5a 之前只允许手填，且标注自述。
- 清除：硬清除目标时一并清除条目、度量、关联和回看，写回执（只保留标识、审计字段、目标/标题哈希和计数，不留原始文字）；**已关联的 Task 与文件不被删除**，仅解除关联；已挂证据的声明不受影响。
- 事件 `goal_changed` 只带 id、动作和状态，不带标题和文本。

---

## 9. 接口

### 9.1 Agent 工具

| 工具                   | 作用                                                 | 风险档       | 说明                                                                                           |
| ---------------------- | ---------------------------------------------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `nexus_goal_search`    | 按标题、类别、状态检索目标                           | R0           | 返回前 N 条与是否完整；`sensitive` 目标只返回标题级摘要                                        |
| `nexus_goal_get`       | 读单个目标：基本信息、最近条目、度量、关联、回看设置 | R0           | 声明状态实时读取                                                                               |
| `nexus_goal_create`    | 在**创建授权**内建一条目标（创建对话专用）           | R0（本地写） | 无有效授权一律拒绝；写 `active`；已有相似目标则不新建、返回它让 Agent 改为更新；授权用掉即失效 |
| `nexus_goal_propose`   | 自发提出一个目标                                     | R0（本地写） | 返回已有相似目标则不新建；写 `proposed`                                                        |
| `nexus_goal_entry_add` | 记一条进展                                           | R0（本地写） | 只对 `active` 目标；可带 `taskId` / `claimId`                                                  |
| `nexus_goal_link`      | 把 Task 或文件关联到目标                             | R0（本地写） | 同 owner 校验                                                                                  |

不提供：Agent 写度量（用户经 `nexus.goal.metric.set` 填）、Agent 确认目标（`nexus_goal_create` 只在用户签发的授权内建，不是确认）、修改用户原话、完成目标、删除、清除、设置回看频次。确认只有用户在控制台做（`nexus.goal.confirm`，5.2）。

### 9.2 运维 RPC

`nexus.goal.list / get / startCreation / update / confirm / complete / reopen / delete / restore / purge / purgeStatus / purgeReceipts`（`startCreation({ category, parentId? })` 开创建对话并签发创建授权，本身不建目标；v1 没有绕过 Agent 的直接 `create`；`parentId` 用于"添加子目标"，父必须是顶层、`active`）、`nexus.goal.entry.add / retract`、`nexus.goal.link.add / remove`、`nexus.goal.metric.set`、`nexus.goal.review.set / cancel / list`（第二阶段）。scope 沿用 read / write / admin。

### 9.3 事件

`goal_changed`（创建、确认、更新、完成、重开、条目新增、关联变化、删除、清除），经 outbox 至少一次。

### 9.4 配置开关

`goalsEnabled`（默认关）、`goalReviewsEnabled`（需要 `goalsEnabled` 和 `watchersEnabled`）、`goalMaxActivePerOwner`（默认 **20**，只统计 `status` 为 `active` 且 `lifecycle` 为 `live` 的目标；`proposed` 不占名额，批准时若已满则拒绝并提示先完成或删除一个；已完成的目标不占名额，重开时同样检查）、`goalReviewMinIntervalHours`、`goalReviewsMaxPerWeek`、`goalReviewMaxTokens`、`goalReviewCatchupPerWake`。清除 run 的租约时长不是配置项，用文件库设计第 6 节的 `DEFAULT_PURGE_RUN_LEASE_MS`（默认 30 000 毫秒；Task purge、文件库、Goals 三者引用同一个常量，cutover 见该节租约协议第 5 条）。

### 9.5 控制台页面

新增"目标"标签（参考 Muse 的 Goals 页）：

- 页面顶部是标题与一句说明，下面是**进行中的目标列表**，再下面是"创建目标"的类别选择区（v1 三个类别，见 9.6）；`proposed` 目标（Agent 自发提出的）单列"待确认"分组并有批准按钮。每行：**复选框 + 标题 + 副标题**（副标题 = `current_state`，可在页面 ⋯ 菜单里关掉）；顶层目标下缩进显示子目标（一层）；类别、关联事项数及状态分布、最近条目时间放在详情里或行尾的小字。
- 复选框 = 用户**手动完成**（`nexus.goal.complete`），Agent 没有这个入口；取消完成只在详情的 ⋯ 菜单里（"标为未完成"），避免误触。
- 页面右上角 ⋯ 菜单：显示副标题、自动排序（关掉后用上移 / 下移或手填序号，v1 不做拖拽）、已完成的目标。
- "已完成的目标"弹层：按完成月份分组；每行已勾选的复选框 + 标题 + ⋯（删除）；点标题进入详情。
- 详情（卡片）：标题与用户原话、描述与现状（标注为"模型整理"）、度量（带"自述 / 已被证据支持 / 已核验"标签）、**活动**时间线（按天分组，首条为"已添加：<标题>"加现状文字，之后是条目与关联 Task 的结果）、关联的 Task 与文件、回看设置与下次时间。
- 详情右上角 ⋯ 菜单：标为未完成（已完成的目标才有）/ 完成、**添加子目标**（发起一次创建对话，`startCreation` 带 `parentId`，同类别）、重命名（用户改 `title`，不动 `user_words`）、删除（说明是软删除，另有"永久清除"并二次确认）；另有静音、添加条目、关联。
- 不做拖拽排序（v1），用排序按钮或手填序号。

### 9.6 从目标页发起的创建对话

**入口**：目标页的"创建目标"区列出类别（v1 只显示 `finance`、`interests`、`something_else` 三个；其余四个等开放后再出现）。没有表单。点一个类别：

1. 页面调用 `nexus.goal.startCreation({ category })`（`operator.write`）。服务端先检查活跃目标是否已满 20 个，满了直接提示，不开对话；通过则签发**创建授权**（5.2：绑定 owner、会话、类别，一次性，默认 2 小时过期）。
2. 新开一个聊天会话，并自动发一条用户消息（如"我想开始一个理财目标"，只是给对话起头，不当作目标原话）。该会话带**创建轮标记**，运行时在这一轮注入该类别的**创建指南与安全节**（`finance` 带完整安全规则）。在 Goals 页之外随口说"我想定个目标"时没有标记也没有授权，Agent 自己读对应类别的指南，只能 `nexus_goal_propose`（进"待确认"）。
3. "添加子目标"同样走 `startCreation`，带 `parentId`，类别沿用父目标。

**Agent 怎么问（对照 Muse 的创建指南与截图）**：

- 一次只问一个问题；用户第一句话已说清"要什么、怎样算达到"就跳过提问直接建。截图里的顺序是：先选方向（卡片）→ 为什么 / 为了什么 → 总额 → 期限，每一步都是一个短问题。
- 有边界的选择用 `ask_user`（2–4 个选项，建议 ≤3 个具体选项，不放"其他 / 不确定"，`ask_user` 自带的"自己输入"出口保留）；开放的问题直接在文字里问。
- 提问阶段**不建任何记录、不写任何持久状态**。

**什么时候建、建什么**：目标明确（有方向，最好有一个怎样算达到的说法）就建，**不必等所有细节问完**；"现在已经存了多少"之类的现状问题放在建完以后，不影响创建。调用 `nexus_goal_create`：`title` 用用户自己的语言和话，一行 `current_state`（列表里的副标题），两三句自然的 `summary`（不带"Focus:"之类标签，不用"我会"这样的 Agent 口吻）；约束和已了解的事实记成 `goal_entries`（`kind='note'`）。已有标题相近的进行中目标则改为更新它。服务端在建时检查：授权有效、活跃上限、相似目标、敏感值扫描（8.3）、`finance` 目标默认标 `sensitive`；服务端写入首条 `kind='system'` 的条目"已添加"，页面的活动时间线从它开始。

**建完之后**：目标直接出现在"进行中"。Agent 用一句话告诉用户"已存入目标页"，再提出一个小的第一步建议并追问现状（如"目前已经存了多少"）；回答以条目形式补充，不改写已存的标题。提醒和定期回看只在确有需要时提，且需用户明确同意，用户点选一个选项算同意（硬规则 3、4）。

**Agent 自发提出的目标**（没有创建授权）：走 `nexus_goal_propose`，进"待确认"分组。卡片显示目标原文、Agent 想问的问题（最多 3 个、每个一句话、纯文字）。用户可逐个回答或跳过，再**批准**（答案记为条目，`author='user'`）、**修改后批准**或**拒绝**；拒绝的目标进入软删除，不占名额。

**不做**：服务端写死的问题模板；根据答案自动生成计划、自动建事项或自动开启提醒——这些都要用户另外明确点选；Muse 没有的"表单式新建"（以后若要，可作为"直接填写"另一个入口，`created_via='console'` 已为它留好）。

**G-S2 小验证结果（2026-10-27，读仓库，没有跑界面）**：

1. **`ask_user` 选项卡片**：控制台聊天已有"停靠的提问面板"（`ui/src/pages/chat/components/chat-question-card.ts`），渲染选项、自由输入与"跳过"，答案回到同一轮；核心 `ask_user` 工具要求 2–4 个选项并自带自由输入出口。**可直接用，不需要我们自造。**（真实渲染还没有在界面里看过，留给 G1 的界面验收。）
2. **聊天侧栏**：Nexus 页是控制台的一个整页（`registerPage`），没有 Muse 那种"左聊天右目标页"。但宿主给页面提供 `host.sessions.create / open`，且 `host.request` 可调任意网关方法（含 `chat.send`），另有 `registerPanel` 可在聊天旁挂面板。**v1 做法：点类别后页面新建会话、签发授权、发开场白，再切到聊天视图；回到目标页看列表。** 聊天旁的"目标面板"留作以后。
3. **授权怎么带进那一轮**：工具工厂的上下文里有 `sessionKey`，`before_prompt_build` 钩子的上下文也有。所以授权**绑定 `sessionKey`**，流程是：页面 `sessions.create`（不带消息）拿到会话键 → `nexus.goal.startCreation({category, parentId?, sessionKey})` 签发授权 → `chat.send` 发开场白 → 钩子按 `sessionKey` 查到授权，注入该类别的创建指南 → `nexus_goal_create` 凭当前 `sessionKey` 匹配授权。授权本身就是"创建轮标记"，不需要另设。
4. **`user_words`**：钩子事件带 `messages`（该轮已准备好的会话消息）和 `currentUserMessageId`，文件库的引用代码解析已经在读 `prompt`。所以服务端能在授权有效期间，从该会话的用户消息里自己摘取，不依赖 Agent 填写。摘取按消息 id 去重（重试、压缩会重复触发钩子）。`ask_user` 的选择答案是工具结果、不在用户消息里，所以 `user_words` 只含用户打字的部分；够用，不够时留空。

结论：四点都能走通，G1 按此实现；没有需要改设计的地方。

---

## 10. 与其他模块的集成

| 模块      | 集成点                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task      | `nexus_task_create` 可带 `goalId`（可选）；Task 页显示所属目标；Task 状态变化触发目标页刷新（事件）                                                               |
| 偏好库    | 目标可引用偏好键；目标中提炼出的偏好只能作为 `observed` 候选；偏好不引用目标                                                                                      |
| Watcher   | 回看复用调度与认证（7.2 选项 B）；回检耗尽的 Task 若关联目标，在目标页提示                                                                                        |
| 文件库    | 目标可关联文件（行程文档、账单）；目标的"设置笔记"（Muse 放在工作区笔记里）在 Nexus 里是结构化字段 + 关联文件，不是 Agent 可随意读写的目录                        |
| 证据账本  | 条目与度量可指向 claim；不反向写 claim                                                                                                                            |
| 通知      | 回看到点、度量达标、待确认目标的提醒                                                                                                                              |
| 审计      | 创建、确认、完成、删除、清除、回看设置变更写审计                                                                                                                  |
| 技能      | 见 10.1                                                                                                                                                           |
| Moneywise | M7 节省核算的口径（已核实账单减少 / 预估节省 / 现金 / 积分）直接用于金融类目标的条目分类；M8 主动机会发现的结果可以作为"建议"挂到目标，用户同意后才建事项（Task） |
| Journey   | 旅行是短期事项，不建目标；若用户说出真正长期的意图（例如"每年带父母出去一次"），Agent 可以提议一个 `something_else` 目标，由用户在"待确认"里批准                  |

### 10.1 技能

参考技能评估的目标包结构（3 个主入口 + 2 个独立技能）。建议**不新增第四个主入口**，而是：

- 在 `moneywise` 主入口加一份 `references/goals.md`（金融类的创建与持续支持指南）；
- 加一个很薄的 `goals` 入口技能，承载通用规则以及兴趣类、其他类的创建与持续支持指南（各一份参考文件），并在目标属于金融类时路由到 `moneywise`。`journey` 不放目标参考：旅行是短期事项，不算长期目标。

技能只写领域判断：怎么弄清用户想要什么、什么时候提议、怎么问、哪些不能做；硬规则（目标不是授权、不能自称用户确认、幂等创建）在服务端和 Nexus 协议里，不重复写进技能。技能文本不得顺带定义目标的持久契约。

---

## 11. 分期、验收与任务表建议

### 11.1 分期

| 期                                                    | 范围                                                                                                                                                                                                                                 | 确定性验收                                                                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **G0** 设计评审                                       | 本文定稿；确认类别范围、确认路径、回看路径（7.2）                                                                                                                                                                                    | 评审通过；3.2 的概念模型文字修订                                                                                                                                                                                                                                                                                                            |
| **G1** 目标核心（前置：G-S2 小验证，见 9.6 待核实点） | 表与迁移；`nexus_goal_search / get / create / propose / entry_add / link`；RPC；"目标"标签页（类别选择区、待确认分组）与创建对话（`startCreation`、类别创建指南注入、`ask_user` 选项卡片）；事件；软删除与硬清除（回执）；敏感值扫描 | 创建幂等与相似目标拦截；一层嵌套；`proposed` 不触发任何主动行为；Agent 自发提出的目标只能在控制台确认、Agent 没有确认入口；`nexus_goal_create` 无有效创建授权一律拒绝、授权一次性且绑定会话与类别、过期或会话结束即作废；Agent 不能改用户原话；目标与条目不出现在授权、完成判定、claim 链的读取路径里；清除后无残留且不删关联对象；归属隔离 |
| **G2** 进展与度量                                     | 条目指向 Task / claim 并显示实时状态；度量（manual / claim）；页面标签                                                                                                                                                               | 声明被反驳后标签变化；撤回条目不改文字；claim 度量必须有同 Task 的声明                                                                                                                                                                                                                                                                      |
| **G3** 定期回看（前置：G-S1 spike）                   | `goal_reviews`；抽出共用的 cron 回合认证；回看回合的白名单；忽略计数与自动暂停；通知接入                                                                                                                                             | 认证失败不给任何工具；回合内没有任何动作 / 决策 / 偏好工具；限额；被忽略后询问并暂停；未送达不计忽略；休眠后错过的回看合并补一次或跳过；唤醒时限量执行；跨时区周期不漂移；Watcher 回归不退化                                                                                                                                                |
| **G4** 技能与场景                                     | `moneywise` 的金融类目标参考文件、薄入口 `goals`（含兴趣类与其他类的创建 / 持续支持指南）；评测场景                                                                                                                                  | 创建只一条、已有则更新、不给个性化财务建议、不把号码写进目标                                                                                                                                                                                                                                                                                |
| 后期                                                  | 简报、势头（估计）、健康 / 人际 / 职业 / 效率类别、目标专属会话                                                                                                                                                                      | 另行评审                                                                                                                                                                                                                                                                                                                                    |

### 11.2 任务表建议

任务表目前没有目标相关的行，建议补充：

| 分类                    | 子任务                                | 建议优先级 / 里程碑 | 说明                               |
| ----------------------- | ------------------------------------- | ------------------- | ---------------------------------- |
| Nexus Agent Core Plugin | Nexus Goals（长期目标）               | P1 / M3             | G1–G2                              |
| Nexus Agent Core Plugin | Goals 定期回看                        | P1 / M3             | G3；依赖通知（第 79 行）和 Watcher |
| Moneywise               | Skills 设计：goal-setting-and-support | P1 / M3             | G4，随上面两行                     |
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
| R12    | 机器随用户换时区，回看时间漂移（影响：经常出差或旅居的用户尤甚）                                  | 回看按固定 IANA 时区推进（7.4）                                 |
| G-S1   | 宿主定时服务在休眠唤醒后的补跑行为、上限、是否同时触发大量任务（影响：回看是否按 7.4 的假设工作） | G3 前做 spike；结论前按最坏情况防护                             |
| 未核实 | 通知出口能否在插件内外发，及能否确认送达（状态文档 5.2）（影响：忽略计数的口径）                  | 通知方案定后再接 G3；确认不了送达就按"未送达"处理               |

### 12.2 待决策

1. 是否接受"目标不是授权、不是证据"的硬规则，以及 Agent 提出的目标必须经用户确认才生效？
2. ~~v1 类别只做 `travel` 与 `money`~~ **已定（2026-10-27）**：v1 只做 `finance`、`interests`、`something_else` 三类；旅行是短期事项，不算长期目标；健康、人际暂不做（见第 0 节）。
3. 回看实现选项 B（独立 `goal_reviews`，抽取共用认证）还是 A / C？
4. ~~目标"完成"是否只能用户操作~~ **已定**：只能用户操作，Agent 只可建议。
   4a. ~~确认 Agent 提出的目标~~ **已定**：v1 走控制台"待确认"分组加 `nexus.goal.confirm`；另有用户手动创建目标的页面，创建后用若干相关问题与用户确认细节（9.6）；聊天内确认留给后续。
5. ~~嵌套一层~~ **已定**：沿用，目标可以有子目标，子目标下不能再有。
6. ~~每 owner 活跃目标上限~~ **已定：20 个**（`goalMaxActivePerOwner` 默认 20）。忽略阈值（建议 3 次）、回看最小间隔仍待定，属 G3。
7. 度量里的财务数字在 G5a 之前只能手填，是否接受？
8. 是否在任务表补上 11.2 的行，里程碑定在 M3？
9. ~~概念模型措辞~~ **已定**：L3 对外叫"事项"（代码标识符仍是 `task`），Goal 是 L4 中长期目标，已改主设计文档 §4 与本文 3.4。
10. 技能放置：`moneywise` 的 `references/goals.md`（金融类）+ 薄入口 `goals`（兴趣类与其他，各带一份类别指南），是否接受（10.1）？
11. 本机运行下回看是"尽力而为"（错过合并补一次、超过一个周期则跳过）是否接受？每次唤醒最多补几个（建议 2）、每周回看次数上限多少？
12. "被忽略"只统计已确认送达的提醒是否接受？在通知渠道确认不了送达之前，是否干脆不做自动暂停，只做静音和手动停？
13. ~~`category` 的 `CHECK` 写全 Muse 的 7 个值~~ **已定**：写全 7 个值，v1 由写入口只放行三类（数据库层面不再拦住"没开放的类别"，靠写入口和测试保证）。
14. ~~相关问题用服务端模板还是 Agent 来问~~ **已定**：Agent 来问（聊天里一次一个，选项用核心的 `ask_user`），没有服务端模板。~~创建结果是否多一步确认~~ **已定（截图后）**：从目标页发起的创建对话聊完直接建进行中，不再多确认；只有 Agent 自发提出的目标进"待确认"。
15. ~~Muse 页面上"手动创建"实际是什么样~~ **已由用户截图确认**：类别选择页 + 聊天，无表单（2.5、9.6）。
16. ~~新增字段 `current_state`（一行现状）~~ **已定**：接受。

---

## 13. G1 落地记录（2026-10-27）

G-S2 小验证通过（见 9.6 四点），随后实现了 G1：表与迁移 `stage6-0001-goals`、`nexus_goal_search / get / create / propose / entry_add / link`、`nexus.goal.*` RPC、控制台“目标”页与创建对话、软删除与硬清除（回执）、`goal_changed` 事件、敏感值扫描。

**与上文提案相比的差异**（以代码为准）：

- `goals` 表多一列 `questions_json`：Agent 用 `nexus_goal_propose` 附带的待问问题（至多 3 个），在“待确认”卡片上显示，用户的回答作为记录写入。
- 新表 `goal_creation_grants`：一次性创建授权（会话键、类别、可选父目标、签发人、过期时间、已采集的用户回复与去重键、消费时间、撤销时间）。同一会话同时只有一条未用的授权，2 小时过期。服务端在 `before_prompt_build` 里采集该会话的用户回复，作为目标的 `user_words`；页面固定的开场白不算。
- `nexus_goal_create` 的重试窗口：授权已被用掉后 10 分钟内，同一会话再调用会返回那条刚建好的目标，而不是报错（防止 Agent 因超时重试得到“没有权限”）。
- 新增 RPC `nexus.goal.forFile`：文件详情里显示“指向这个文件的目标”，没有时安静地不显示。
- 配置：`goalsEnabled`（需要 `tasksEnabled`）、`goalMaxActivePerOwner`（默认 20）。工具都是可选工具，必须放进 `tools.alsoAllow`；`scripts/mac-nexus-preset.sh` 的默认工具列表和开关已加上。
- 事件 `goal_changed` 只带目标 id、动作与状态。
- 控制台页面的两个开关（显示副标题、自动排序）保存在浏览器本地存储里，属于每个浏览器的小偏好；存储被禁用时只在本次页面生命周期内生效。

### 13.1 真实界面验收（2026-10-27，开发网关 127.0.0.1:19001）

原先列的三个待验证点已验证：

1. **会话键一致。** 页面 `host.sessions.create()` 返回的键经 `normalizeKey` 后，与钩子、工具里的 `ctx.sessionKey` 一致；`nexus_goal_create` 凭授权成功保存（“建立储蓄”以进行中状态入库，来源是创建对话）。
2. **用户回复可采集。** `before_prompt_build` 能拿到 `messages` 与当前消息 id，授权里的 `user_words` 正常累积，页面固定的开场白被跳过。
3. **工具放行与卡片。** 放进 `tools.alsoAllow` 后 Agent 能调到六个目标工具；兴趣类对话出现了 `ask_user` 选项卡片。

验收中发现并已修复的问题：

| 现象                                                                   | 原因                                                                                                                                                                             | 处理                                                                                                                                                                                        |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进行中目标左侧勾选框单击即完成，容易误点                               | 勾选直接调用 `nexus.goal.complete`                                                                                                                                               | 先弹确认框，确认后才完成；取消不改变状态                                                                                                                                                    |
| 创建对话里 Agent 调的是 `nexus_goal_propose`，目标进了待确认，没有追问 | 指南已注入，但模型自行选了 propose                                                                                                                                               | 服务端兜底：会话持有有效创建授权时，`nexus_goal_propose` 返回 `use_create`；指南同步加强（本对话直接用 `nexus_goal_create`，不要 propose）                                                  |
| 待确认目标点“批准”后直接生效，跳过 Agent 的待问问题                    | 批准按钮直接调用 `nexus.goal.confirm`                                                                                                                                            | “批准”改为打开提案卡片，问题与回答在卡片内完成后再确认                                                                                                                                      |
| 点类别卡片提示“没能新建对话”                                           | 页面给新会话传了固定标签，网关要求会话标签唯一，第二次点击冲突                                                                                                                   | 页面不再传标签；会话标题由网关按开场白自动生成                                                                                                                                              |
| 第二个对话报 provider error，目标没建成                                | ①模型暂时“容量已满”（`server_overloaded`，瞬时错误）；②之后模型转入 exec / 代码模式，而目标工具是 direct-only，在代码模式里调不到（`tools.nexus_goal_create is not a function`） | ①属提供商问题，重试即可；②在 `prependContext` 每轮注入创建提醒（`GOAL_CREATION_REMINDER`），并在指南里写明“把 `nexus_goal_create` 与 `ask_user` 当作普通工具直接调用，不要包进 exec 或脚本” |

### 13.2 已知限制（验收后确认）

- **选项卡片不保证出现。** `ask_user` 是宿主的核心工具，模型是否调用取决于模型：兴趣类对话出现了卡片，理财类对话有时只给文字选项。指南与提醒只能提高概率，不是保证；文字选项下用户直接回复同样能走通（回复被采集为 `user_words`），只是没有卡片的点选体验。不要在验收标准或对外说明里写成“一定出现卡片”。
- **模型过载是瞬时错误。** 出现“Selected model is at capacity”时，授权仍有效（2 小时内），在同一对话里重发即可；10 分钟重试窗口保证已建好的目标不会重复创建。
- **exec / 代码模式下调不到 direct-only 工具。** 这是 Codex 工具目录的行为，不是插件的 bug；现在靠提示词引导，未做服务端兜底。
- **会话标签必须唯一**（网关约束），任何从页面发起的创建都不要再传固定标签。

测试状态：云端 609 项通过，6 项失败均为 `src/spikes/` 的垫片噪声；类型检查干净；Mac 上 `oxfmt`、`oxlint`、`pnpm test:extension nexus-agent-core`、`build-dist.mjs` 均已通过。预设脚本现为 28 个工具。

## 14. G2 落地记录（2026-10-27）

G2（进展与度量）已实现：迁移 `stage6-0002-goal-metrics`、条目 / 关联的实时状态、手填与声明驱动两种度量、`nexus.goal.metric.set / remove`、控制台详情页的度量区与状态标签、添加条目时可选关联事项与声明。云端：全量测试 610 项通过（`src/spikes/` 的垫片噪声除外），类型检查干净；浏览器端用 Chromium 跑了 28 项页面测试和一次端到端流程；**Mac 上的 oxfmt、oxlint、vitest、打包与真实界面验收已完成，结果见 14.4**。

### 14.1 做了什么

- **表 `goal_metrics`**，与第 5 节 DDL 的差异（以代码为准）：多了 `direction`（`up` 至少达到 / `down` 降到以内）、`reached_at`（上一次达到目标的时间，保证每次“越过”目标只写一条系统条目）、`created_at`、`updated_at`；`(owner_id, goal_id, name)` 唯一；`source='claim'` 时 `current` 必须为空（数值不存，读取时从声明取）。`task_id` / `claim_id` 仍无外键，写入时校验声明属于该 Task。随目标级联删除，清除回执里的 `metric_count` 现在是真实计数。
- **实时状态（只读，不存）**：`nexus.goal.get` 返回的条目带 `pointer`（事项是否已清除、事项状态与标题、声明状态、声明是否已清除），关联里的事项带状态与标题，`claim` 度量带当前数值与声明状态。声明被反驳、Task 被清除时，标签变化，条目文字不变。声明状态的中文标签：已声明 / 已被证据支持 / 已核验 / 被反驳 / 未知。
- **度量规则**：每个目标至多 10 个；名称 ≤60 字、单位 ≤20 字、数值绝对值 ≤1e12；名称与单位过敏感值扫描，数字本身不扫；**理财类目标只能手填**（`finance_manual_only`，服务端拒绝）；来源和声明指针创建后不可改；`proposed` 目标不能加度量；已完成的目标仍可改度量（与条目一致，只有用户能写）。达到目标值**只写一条系统条目**（文字按页面语言，由服务端生成），不完成目标、不触发其他动作；声明驱动的度量在读取时判断“已达到”，且只有声明为“已被证据支持 / 已核验”才算，不写系统条目（声明变化发生在目标代码之外）。
- **接口**：`nexus.goal.metric.set`（新建或按 `metricId` 更新；更新时没给的字段保持原值，`target` / `current` 给 `null` 表示清空）与 `nexus.goal.metric.remove`，都是 `operator.write`，代码在 `src/goal-metric-rpc.ts`；`nexus.goal.entry.add` 增加可选 `claimId`（必须同时带 `taskId`）；事件新增动作 `metric_set` / `metric_removed`（仍只带 id、动作、状态）。**Agent 没有任何写度量的工具**；`nexus_goal_get` 会读到度量（来源标为 `self_reported` 或 `claim`，附声明状态与 `targetReached`），以及条目 / 关联的实时状态。
- **控制台**：详情页新增“度量”区（名称、数值 / 目标 / 单位、进度条（仅“至少达到”且目标 > 0）、“自述”或声明状态标签、“已达到”、更新时间；添加与编辑弹窗；声明驱动要先选事项再选声明；理财类目标只显示“我自己填”）；活动里的条目显示对应标签，没有指针的笔记显示“自述”；关联的事项显示标题与状态；“添加记录”可选关联事项与声明。代码拆到 `browser/goal-progress.ts`、`src/goal-label.ts`。

### 14.2 已知限制

- 详情弹窗是打开时读一次的快照：事项或声明在弹窗打开后变化，要关掉重开才看到新标签（页面本身在收到 `claim_changed` / `task_changed` 事件时会刷新，但不会重绘已经打开的弹窗）。
- 声明的值要是数字（或 `{ "value": n }` / `{ "amount": n }`）才显示数值，否则显示“暂无数值”。
- 条目 / 度量选择事项时只列最近 100 个事项（含已结束的），声明至多 100 条；更多时要先在事项页找到编号，现在没有搜索框。
- “已达到”的系统条目只在手填度量被保存时写；回看、通知出口属于 G3。
- 任务状态标签显示原始状态名（如 `executing`），与任务页一致，没有翻译。

### 14.3 验证与顺手修的问题

- 新增账本测试 11 项（`goal-metric-ledger.test.ts`）、RPC 测试 2 项、Agent 工具测试 1 项、页面测试 11 项（`goal-metrics-view.test.ts`）。
- 在 Chromium 里跑页面测试时发现，G1 的 `goals-view.test.ts` 有两处写错，已改：写入断言没有排除页面首次加载时的 `nexus.vault.stats` 探测（`writes()` 的过滤加上 `stats`），以及页面菜单测试没关第一个菜单就开第二个。页面测试因此拆成 `goals-view-kit.ts`（共用夹具）、`goals-view.test.ts`、`goal-metrics-view.test.ts` 三个文件。
- `goal-rpc.ts` 超过 700 行，度量的 RPC 拆到 `goal-metric-rpc.ts`，公共的 `makeGuarded` / `needGoalId` 放进 `goal-rpc-support.ts`。

### 14.4 Mac 验收清单

1. `pnpm exec oxfmt --write extensions/nexus-agent-core`、`pnpm exec oxlint extensions/nexus-agent-core`、`pnpm test:extension nexus-agent-core`（含 `browser/goal*.test.ts`，G1 的页面测试从未在 Mac 上跑过）、`node extensions/nexus-agent-core/scripts/build-dist.mjs`，然后重启网关（迁移 `stage6-0002-goal-metrics` 会在启动时自动应用）。
2. 在“兴趣”目标的详情里添加一个手填度量（名称、单位、目标值、当前值）：列表里出现数值与进度条，标签是“自述”；把当前值改到目标值：出现“已达到”，活动里多一条“已达到目标：…”，目标仍是“进行中”。
3. 先在任务页让 Agent 或你自己建一个带声明的事项，再给目标加“来自声明”的度量：显示声明的当前值与状态；在任务页把声明改成被反驳后重开目标详情，标签变为“被反驳”。
4. 理财类目标：添加度量时没有“事项里的声明”这个选项，只能自己填。
5. “添加记录”里选一个事项（可再选声明）：活动里这条记录带事项标题与声明状态；不选则显示“自述”。
6. 让 Agent 打开这个目标（`nexus_goal_get`）：能看到度量与状态，但没有工具能改它。

**验收结果（2026-10-27，开发网关）**：

- 第 1 项通过（oxfmt、oxlint、`pnpm test:extension`、`build-dist` 全部通过，迁移随网关重启应用）。
- 第 2、4 项：用户在兴趣类和理财类目标上都添加了度量，未报问题。
- 第 3 项通过，用“本周练习时长 12 小时”的声明做的声明驱动度量。**其中“声明被反驳后标签变为被反驳”没有验**：声明状态由证据推导，用户不能手改，Agent 只能写 `ASSERTED` / `UNKNOWN`，自动核验目前只覆盖 `executed`；代码里对声明调用 `nexus.claim.retract`（`operator.write`，目前只有网关接口，没有控制台按钮）会使其变为 `REFUTED`，但未在真实环境运行过。该标签只在云端测试里通过直接改库验证过。
- 第 5 项通过（记录关联事项与声明，显示事项标题与声明状态；不关联显示“自述”）。
- 第 6 项用户未单独回报。

小结文档：`nexus-agent-core-goals-g1-g2-summary.md`。

**G2 之后**：G3（定期回看，需要通知出口与 G-S1）、G4（技能：`moneywise` 的 `references/goals.md` 与薄入口 `goals`）。真实提供商、个人 Wiki 仍按用户的决定后置。

## 15. G2.1 补丁与 G-S1 结论（2026-10-28）

### 15.1 G2.1：三个小补丁（已实现，待 Mac 验收）

- **声明撤回按钮**：任务页的声明表在可写连接下多一列“操作”，除“被反驳”外的声明有“撤回”按钮；点开后是确认框（写明不可恢复、会使引用它的目标度量不再计入“已达到”），确认才调用 `nexus.claim.retract`（原因固定为“用户在控制台撤回”）。这是 14.4 第 3 项“被反驳”标签第一次能在界面里复现：撤回后重开目标详情（或见下条自动刷新）应显示“被反驳”。
- **详情窗自动刷新**：目标详情窗打开期间，收到 `task_changed` / `claim_changed` / `goal_changed` 事件会按最新数据重画（同一时刻只保留一个详情窗；400 ms 防抖合并连发事件）。其他窗口叠在详情上方、或详情已被关闭时不会重画，不会打断正在填写的表单。
- **选事项**：加了搜索框（走 `nexus.task.list` 的 `keyword`，匹配标题、目标、摘要、实体，一次最多 100 个）；已选中的事项在后续搜索里保持可选；事项状态与声明状态在目标页里改为中文（`executing` → 执行中等），任务页仍显示系统原词。
- 测试：页面测试新增 `goal-live-view.test.ts`（7 项）、`actions.test.ts` 撤回按钮（3 项）、`sanitize.test.ts`（1 项）；云端 608 项 Node 测试通过，类型检查干净；浏览器端测试在 Chromium 里跑过。

### 15.2 G-S1：宿主定时服务在休眠、重启后的行为

**方法**：读宿主源码（`src/cron/service/`），并在 Mac 上用宿主自己的测试夹具写了一个临时探针（`gs1-probe.test.ts`，只观察、不提交）。下面“源码结论”都带出处；“探针结果”见 15.3。

**源码结论**

| 问题                                         | 结论                                                                                                                                                                                                                                                                                 | 出处                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| 定时器多久醒一次                             | 最长 60 秒醒一次（`MAX_CRON_TIMER_DELAY_MS = 60_000`），注释写明用于“进程被暂停或墙钟跳变后尽快恢复”。机器睡眠期间 Node 定时器不走，醒来后第一个 tick 会把所有 `nextRunAtMs ≤ 现在` 的任务当作到期                                                                                   | `timer-scheduler.ts` `armTimer`                                                                                  |
| 休眠唤醒（网关进程没重启）时，到期任务怎么跑 | 全部到期任务一次进入执行；同时执行的上限是 **8**（`DEFAULT_CRON_MAX_CONCURRENT_RUNS`），超过的排队等空位。**这条路径没有“每次最多补几个”的上限，也没有错开时间**                                                                                                                     | `timer-scheduler.ts` `onAdmittedTimer`、`run-admission-capacity.ts`、`config/cron-limits.ts`                     |
| 错过多个周期怎么补                           | cron 类任务**只补一次**：一次运行结束后，下一次时间从“运行结束时刻”往后算，错过的几个周期自然合并成一次                                                                                                                                                                              | `timer-outcomes.ts`（`computeJobNextRunAtMs(job, result.endedAt)`，另有 2 秒最小重触发间隔 `MIN_REFIRE_GAP_MS`） |
| 网关重启后怎么补                             | `runMissedJobs`：同步补跑**最多 5 个**（`DEFAULT_MAX_MISSED_JOBS_PER_RESTART`），其余顺延并按 **5 秒**错开（`DEFAULT_MISSED_JOB_STAGGER_MS`）；启动时若要求推迟 agent 回合，则 agentTurn 类任务推迟 **2 分钟**（`DEFAULT_STARTUP_DEFERRED_MISSED_AGENT_JOB_DELAY_MS`）。补跑是串行的 | `timer-catchup.ts` `planStartupCatchup`、`timer-execution-timeout.ts`                                            |
| 能否关掉错过补跑                             | 全局配置 `cron.skipMissedJobs`（默认 false）：开启后重启时跳过错过的周期性任务，只安排下一个未来时间；一次性 `at` 任务仍会补。是全局开关，插件不能只为自己关                                                                                                                         | `timer-catchup.ts`、`config/schema.help.automation.ts`                                                           |
| 失败后的重试                                 | 出错的周期任务按退避表延后，期间不会被当作到期                                                                                                                                                                                                                                       | `timer-runnable.ts` `isErrorBackoffPending`                                                                      |

**对设计 7.4 的修正**

1. 7.4 的假设（“唤醒后可能一次到期多个”）成立，而且比假设更直接：休眠唤醒走的是普通 tick 路径，最多 8 个同时跑，没有上限和错开。**宿主不会替我们限流。**
2. “错过多个周期只补一次”由宿主自然保证（对 cron 类任务）；但“错过超过一个完整周期就跳过并写‘已跳过’”宿主不做，且默认配置下重启还会补跑，所以这一条必须由 Nexus 在回看**触发时自己判断**：比较到期时刻与现在，超过一个周期就不跑模型回合、只写系统条目。
3. “每次唤醒最多执行 N 个”也要自己做。逐目标一个 cron 任务会让宿主把它们同时拉起，插件只能在回合开始时拒绝，仍可能先付出启动成本。**建议改成每个 owner 一个“回看调度员”任务**：它按固定节奏（例如每天一次）触发，一次回合里只挑最多 N 个到期的目标（按优先级和上次回看时间），其余顺延。这样错过合并、限额、免打扰顺延都在我们自己的代码里，宿主的 8 并发也碰不到。代价是回看时间只精确到调度员的节奏（对周 / 月回看足够）。设计 7.2 的 B 方案随之改为“一个调度员任务 + `goal_reviews` 表记录各目标的到期时刻”，Watcher 的认证与白名单抽取方式不变。
4. 插件创建定时任务、接收 `cron_changed` 事件、拿到 `ctx.trigger="cron"` 且 `toolsAllow:[]` 生效，这些已被阶段 4 的 spike 4 与回检功能验证过（见阶段 4 小结），G3 沿用同一条路径。

**仍然没有答案的（需要实机，G3 之前或期间验证）**

- Mac 合盖休眠时网关进程是被挂起还是被系统结束：被挂起则走上面的“休眠唤醒”路径，被结束（或用户退出应用）则走“重启补跑”路径。两条路径都已有结论，但哪条在日常里更常发生要看实机。
- 夏令时与时区变化时 `next_review_at` 的推进（宿主 cron 类任务自带 `tz`，需要在 G3 的测试里用固定时区覆盖）。
- 回看回合的产出放在哪：cron 回合跑在某个会话里，输出会进入该会话的对话记录；通知出口（状态文档 5.2，WP3）还没有，v1 前只能是控制台徽标 + 对话内提示。这是 G3 的前置决定，不是 G-S1 能回答的。

### 15.3 探针结果（2026-10-28，Mac 上跑宿主自己的测试夹具）

12 个每周一 09:00 UTC 的 agent 任务，上一次运行在 24 天前、第一个错过的时刻在 17 天前（即错过 3 个周期）：

| 场景                                      | 实测                                                                                                                                            | 与源码结论                  |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A 休眠唤醒（不重启，直接一次 timer tick） | 12 个任务**各运行 1 次**（12 次调用、12 个不同任务），**同时在跑 8 个**；下一次时间都是 `2026-11-02T09:00Z`（从运行结束时刻往后算的下一个周一） | 吻合：错过多个周期只补一次  |
| B1 网关重启，不推迟 agent 回合            | 立即补跑 **5 个**；其余 7 个顺延 5、10、15 … 35 秒                                                                                              | 吻合：上限 5、错开 5 秒     |
| B2 网关重启，推迟 agent 回合              | 立即补跑 **0 个**；12 个全部顺延，从 2 分钟起每个错开 5 秒（120 … 175 秒）                                                                      | 吻合：agent 任务推迟 2 分钟 |

**A 的并发峰值**：第一次探针用了假定时器，12 个任务逐个跑完（峰值显示 1），不代表真实并发。改成真实定时器、前 8 个运行卡住不放后实测：**8 个任务同时在跑，其余 4 个排队**（`startedBeforeRelease = 8`、`peak = 8`），放行后 12 个各跑 1 次。与源码结论（`resolveRunConcurrency() = 8`）一致。也就是说休眠唤醒后宿主不会替我们限流，一次最多同时拉起 8 个模型回合。探针是临时文件，已删除。

**G3 的建议顺序**（含上面的修正）：①通知的第一条出口决定（状态文档 5.2）；②`goal_reviews` 表 + 调度员任务 + 触发时自检（到期、超期跳过、限额、免打扰）；③回看回合的白名单与产出（进展草稿 + 控制台徽标）；④忽略计数与自动暂停。

### 15.4 G2.1 验收与 G2.2：控制台的目标关联（2026-10-28）

**G2.1 验收**：用户在真实界面里撤回一条声明后重开目标详情，度量显示“被反驳”，通过。

**用户发现的缺口**：目标详情的“关联”区一直显示“还没有关联的事项或文件”，而添加记录时明明选过事项和声明。原因是两个不同的概念——记录上的事项 / 声明只是这条记录自己的出处（显示在活动里），目标的“关联”是“这个事项属于这个目标”（一个事项至多属于一个目标）。后者原先只有 Agent 的 `nexus_goal_link` 工具能建，控制台没有入口。G2.2 补上：

- “关联”区加“添加关联”：用与度量相同的事项选择器（带搜索），只选事项，不出现声明；每条关联带“移除”，二次确认，文案说明只取消挂靠、事项本身不受影响。两个弹窗关闭（完成或取消）后都回到目标详情。
- 添加记录且选了事项时，出现可选项“同时把这个事项关联到目标”，**默认不勾**（关联会占用事项的唯一归属）。先保存记录、再关联；关联被拒绝时记录已保存，弹窗关闭并提示“已记录，但没能关联事项：…”，避免重试导致记录重复。
- 常见拒绝改成中文句子：事项已属于另一个目标；事项已失败 / 已取消 / 正在清除；关联数已达上限。其余仍显示服务端原话。
- 代码：新增 `browser/goal-links.ts`、`browser/goal-errors.ts`（错误文案从 `goals-view.ts` 抽出，`describeGoalError` 仍从原处导出）；`linkRow` 移到 `goal-links.ts`。文件关联（vault_file）仍只能由 Agent 或文件页面建立，控制台可移除但不能添加。
- 测试：页面测试 `goal-links-view.test.ts` 9 项（添加、被拒、取消、移除、只读与待确认目标、记录同时关联三种情形）；云端 608 项 Node 测试通过，类型检查干净；浏览器端在 Chromium 里跑过（`files-view` 的 12 项在本地替身下本来就失败，与本次无关）。

## 16. G3a：回看提醒层（2026-10-28，已实现，待 Mac 验收）

用户的要求是“先试试控制台徽标加对话内提示，看看效果好不好”。所以这一步只做**提醒层**：不建定时任务，不开后台模型回合，不依赖通知出口。它回答的问题是“用户会不会觉得这种提醒有用、会不会烦”，G3 的其余部分（调度员、`goal_reviews`、白名单回合、忽略计数）等看过效果再定。

### 16.1 用户的三个决定

| 问题       | 决定                                       |
| ---------- | ------------------------------------------ |
| 范围       | 只做提醒层，不开定时模型回合               |
| 回看周期   | 每个目标自己设，默认关                     |
| 对话内提示 | 每次到期只提示一次；用户回应或点“稍后”后停 |

### 16.2 规则

- **数据**：新表 `goal_review_plans`（迁移 `stage6-0003-goal-review-plans`），每个目标至多一行：周期（每周 / 每两周 / 每月）、下次到期时间、上次回看时间、`snoozed_until`（用户说“稍后”）、`nudged_at`（对话已经提过这一次到期）。随目标级联删除。
- **到期**：目标是进行中且未删除，`下次到期时间 ≤ 现在`，且没有在“稍后”期内。到期是读取时算出来的，不存。已完成、待确认、已删除的目标不提醒（计划行留着，重新打开后继续算）。
- **设周期**：新周期从“现在”起算，第一次提醒在一个完整周期之后；同一个周期重复设置不改变日期；换周期会清掉“稍后”和“已提示”标记；选“不提醒”删除计划行。
- **已回看**：下次到期 = 现在 + 一个周期；写**一条**系统条目“已回看这个目标”（按页面语言）；清掉两个标记。
- **重新打开**：已完成的目标重新打开时，回看计时重新开始（下次到期 = 现在 + 一个周期，清掉“稍后”和“已提示”标记），不会因为完成期间日期已过而一打开就到期。
- **稍后**：推迟 2 天；清掉“已提示”标记，所以 2 天后如果仍到期，对话会再提一次。
- **对话内提示**：用户发起的对话回合开始时，若有到期且未提示过的目标（最多 3 个，按到期先后），在用户消息旁加一小段说明（英文，标题当数据、去换行、截 80 字）。读取这些目标时同一个事务里把 `nudged_at` 标上，所以每个到期日只会被提一次，两个会话同时开始也不会重复。创建目标的对话（带创建授权）里不提示。提示要求 Agent：先答用户问的，再用一句话提到“有目标到回看时间了，现在看还是稍后”；用户同意之前不读目标、不记录。同意后：`nexus_goal_get` 读 → 两三句总结 → 问**一个**问题 → 用 `nexus_goal_entry_add` 记下 → `nexus_goal_review(done)`；说稍后就 `nexus_goal_review(snooze)`；说不想被提醒就告诉用户去目标页关掉。
- **代码位置**：这段对话内提示（以及创建对话的引导）抽成了 `goalTurnContext`（`src/goal/goal-hook.ts`），钩子只调用它；它有自动化测试（普通对话到期提示一次、无会话键不提示也不标记、其他用户不受影响、创建对话不提示、存储失败不影响本回合）。
- **一个已知取舍**：钩子在重试或压缩时可能重跑，第一次已把目标标成“已提示”，那一次的提示文字若没有进入最终的对话，就不会再补。代价是偶尔少提一次，换来绝不重复提。

### 16.3 接口

- 控制台 RPC（`src/goal-review-rpc.ts`）：`nexus.goal.review.set { goalId, cadence: weekly|biweekly|monthly|null }`（write）、`nexus.goal.review.act { goalId, action: done|snooze, lang? }`（write）、`nexus.goal.review.due`（read，返回到期计划和数量，给徽标用）。`nexus.goal.list` 的每一行和 `nexus.goal.get` 带 `review`（没有计划则没有这个字段）。
- 与 9.2 的差别：9.2 写的 `review.set / cancel / list` 以本节为准——`cancel` 并入 `set` 的 `cadence: null`，`list` 由 `goal.list` 里的 `review` 和 `review.due` 取代。
- Agent 工具：新增第 7 个 `nexus_goal_review { goalId, action: done|snooze }`（可选工具，需要放进 `tools.alsoAllow`；预设脚本的工具清单 28 → 29）。它只移动提醒，不写进展、不完成目标；**Agent 不能设周期**。`nexus_goal_get` 现在多返回只读的 `review { cadence, due, nextDueAt, lastReviewedAt }`。
- 事件：`goal_changed` 新增动作 `review_set`、`review_done`、`review_snoozed`，仍然只带 id 和动作。
- 内核：`src/store/goal-review-ledger.ts`（`goalReviewSet / Act / List / Nudge`，全部是同步事务、按 owner 过滤），挂在 `goal-ledger.ts` 里。

### 16.4 控制台

- 目标详情新增“定期回看”区：周期下拉（不提醒 / 每周 / 每两周 / 每月）；有计划时显示“下次回看”或“已推迟，… 之后再提醒”、“上次回看”，到期时显示“该回看了”标记和“已回看”“稍后（2 天）”两个按钮；底部一句说明“只在你打开控制台或开始聊天时提醒，不会在后台自己运行”。只读连接只显示、不能改；待确认和已完成的目标不显示这一区。
- 目标详情窗改为**原地更新**（验收中发现点“已回看”后详情跳回顶部）：详情已经打开时，数据变化或点“已回看 / 稍后”不再关掉重开，而是保留同一个窗口，只清空并重填里面的内容，标题和“⋯”菜单项一起刷新，滚动位置和焦点不动；刷新不会打开用户已经关掉的窗口，目标在别处被删除时窗口自动关闭，较慢的旧回答不会盖掉较新的。“添加度量 / 添加关联 / 重命名”等仍是先关详情、弹小窗、结束后回详情（刻意不叠窗）。
- 列表里到期的进行中目标标题后面有“该回看了”标记。
- “目标”标签后面显示到期数量，如“目标 (2)”；每次加载页面时读取一次（页面开着时到期不会自己刷新，点“刷新”或有事件重载即可）。
- Control UI SDK 没有给插件页签加徽标的入口，所以徽标在 Nexus 页面自己的导航里。

### 16.5 刻意没做（留给完整 G3）

- 没有 cron 任务和“回看调度员”；没有 `goal_reviews` 表；没有后台模型回合，所以**没有自动写进展草稿**。
- 没有“错过太久就跳过”：现在的行为是“到期就一直到期”，用户回应或点稍后才动；也就不需要宿主 cron 的补跑规则（G-S1 的结论到完整 G3 才用得上）。
- 没有忽略计数 / 自动暂停：用户不理会时，每个到期日只提示一次，之后只剩徽标和标记。
- 没有通知出口（状态文档 5.2）：提醒只在用户打开控制台或开始聊天时出现。
- 没有免打扰、没有按目标类别区别对待（理财和兴趣一样处理）。

### 16.6 验证

- 云端：Node 测试 630 项全部通过（新增账本 10 项、服务 / RPC / 对话提示 / Agent 工具 12 项）；类型检查干净；Chromium 里的页面测试新增 10 项通过（其余 14 项失败与改动前一致，是本地替身环境的问题）。
- 手工验证见 16.7。

### 16.7 Mac 验收清单

1. **命令**：`pnpm exec oxfmt extensions/nexus-agent-core`、`pnpm exec oxlint extensions/nexus-agent-core`、`pnpm test:extension`、构建，全部通过；重启开发网关后迁移自动建表。
2. **放行新工具**：把 `nexus_goal_review` 加进 `tools.alsoAllow`（命令见交付说明）后重启网关。
3. **设周期**：打开一个进行中的目标，在“定期回看”里选“每周”：提示“已设为每周回看，第一次在 …（约 7 天后）”；改成“不提醒”提示“已关闭回看提醒”。
4. **制造到期**：执行一条 SQL，把所有计划的下次到期时间改成过去（命令见交付说明）。刷新页面：该目标行有“该回看了”，标签变成“目标 (1)”，详情里有标记和两个按钮。
5. **稍后**：点“稍后（2 天）”：提示“好，… 之后再提醒”，标记消失，徽标消失；再执行一次第 4 步的 SQL 会重新到期。
6. **对话提示**：到期状态下，打开一个普通对话，随便问一句别的：回答之后 Agent 应用一句话提到“有目标到回看时间了”，并问现在看还是稍后；再发一条消息，**不应再提**。
7. **走一遍回看**：回答“现在看”：Agent 应读目标、简短总结、只问一个问题；你回答后它记一条进展并把提醒标成已回看。回到目标详情：下次回看日期变成约 7 天后，活动里有一条系统记录“已回看这个目标”，徽标消失。
8. **说“稍后”**：再制造一次到期，在新对话里回答“稍后再说”：Agent 应把它推迟 2 天，不再追问。
9. **不该提醒的**：已完成的目标、待确认的目标、创建目标的对话里，都不应出现回看提示。
10. **体验判断（这一步真正要回答的）**：提示是有用还是烦？一天内提到一次是否合适？徽标在页面开着时不自动刷新是否影响使用？

---

## 附：资料索引

- Muse（概念参考，转述，非拷贝）：`MuseAI-Skills/home/hatch/docs/goals.md`、`MuseAI-Skills/opt/hatch/skills/goals/SKILL.md`、`MuseAI-Skills/opt/hatch/skills/goals/creation/{career,health,interests,money,productivity,relationships,something_else}.md`、`MuseAI-Skills/opt/hatch/skills/goals/guides/<category>/scaffold.md`、`MuseAI-Skills/opt/hatch/skills/muse_db/references/schema.md`（`goals` 表组）、`MuseAI-Skills/home/hatch/docs/client-surfaces.md`（Goals 标签页的描述）
- Nexus：`extensions/nexus-agent-core/nexus-agent-core-design.md`（§4 概念模型与命名纪律、§6.1 关系完整性、§10 Watcher、§11 偏好、§14 已知缺口）、`extensions/nexus-agent-core/docs/nexus-agent-core-museai-skills-assessment.md`（技能包结构与 G 系列缺口）、`extensions/nexus-agent-core/docs/nexus-agent-core-plugin-status-and-remaining-work.md`（通知、审计、收口项）、`extensions/nexus-agent-core/docs/nexus-agent-core-personal-file-vault-design.md`
- 项目：`docs/nexus/nexus-architecture-design-2026-10-02.md`（ADR-03）、`docs/nexus/nexus-development-roadmap-2026-10-02.md`
