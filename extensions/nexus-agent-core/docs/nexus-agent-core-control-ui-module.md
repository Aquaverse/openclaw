# Nexus Agent Core — Control UI 浏览器模块

## 状态（2026-10-15）

- 浏览器模块已在 Mac 构建、应用内渲染通过，安装版回归通过（见 pkg-regression 文档）。
- 操作按钮（决策批准/拒绝、取消回检、偏好新增/编辑/删除）代码完成；Mac 侧 oxfmt / tsgo / test:extension / 浏览器 vitest / 资源构建全部通过；**dev 网关（19001）界面验收通过**（见下）。
- 已提交按钮代码；之后又做了「事项列表的筛选与分页」（见下），尚未在 Mac 构建 / 验收。
- 待办（按钮）：提交（含 `openclaw.plugin.json` 的 `controlUi` 哈希、`browser/`、`spikes/ui-fixture.mts`），重新 `mac:installer` 打包，在安装版应用里确认按钮。安装版（18789）在重新打包前仍是无按钮的旧构建。

（2026-10-16 补充：以上待办已完成，最新状态见 `nexus-agent-core-control-ui-followups-1016.md`。）

## 为什么是浏览器模块

应用（WKWebView）里点 Nexus 标签显示「插件面板不可用」，浏览器 `/nexus` 正常。原因：描述符标签页的 iframe 需要网关 cookie（`Secure; SameSite=None`），WKWebView 在 http 回环上不保留。

## 做法

插件自带 Control UI 浏览器模块 `browser/`（`defineControlUiPlugin`），`package.json` 加 `openclaw.controlUi` 与 `assetScripts`（宿主通用构建/复制，`pnpm plugins:assets:build` / `copy`，`mac:installer` 的构建已包含）。注册与侧栏描述符同 id 的页面 `nexus`，宿主优先渲染已注册页面，不再走 iframe/cookie；不注册第二个导航项；HTTP 页保留（永远只读）。数据走既有 RPC，复用 `ui-render.ts` 渲染器，再经 DOMParser 白名单重建后挂入宿主 DOM；订阅 `plugin.nexus-agent-core.*_changed` 去抖刷新。要求插件为 bundled 来源（安装版满足）。

构建坑：扩展自己的 `tsconfig.json` 会覆盖根配置的路径别名，`assetScripts` 的 build/copy 要带 `TSX_TSCONFIG_PATH=../../tsconfig.json`，否则报 `Cannot find package '@openclaw/normalization-core'`。改了 `browser/` 或 `ui-render.ts` 必须先 `oxfmt` 再 `pnpm plugins:assets:build --plugin nexus-agent-core`，并提交 `openclaw.plugin.json` 的 `controlUi` 哈希（`pnpm plugins:assets:check` 会核对）。

## 操作按钮（2026-10-15）

- 仅当连接有 `operator.write`（`host.connection.canWrite`）时渲染；HTTP 页永远只读。
- 范围：`nexus.decision.resolve`（批准/拒绝）、`nexus.watch.cancel`、`nexus.preference.set` / `.delete`。purge（`operator.admin`）不在页面上。
- 渲染器只吐标记（`data-nx-act` + `data-nx-id`），消毒器只保留已知操作名和合法 id；确认对话框由页面已加载的记录构建，不读标记内容。
- 决策：显示问题/类型/风险/事实/选项；多个候选动作必须先选；R2 及以上批准前必须勾选二次确认；R0/R1 一次确认；拒绝不需要勾选。返回按 outcome 分「完成 / 过时（关闭并刷新）/ 错误（对话框保持打开）」。
- 偏好：只有 `stated` 行可编辑（范围、键只读）；新增与编辑一律记为 stated；删除是软删除。
- VM：浏览器模块测试 32 条（路由 3、消毒 8、页面 8、操作 13）、清单 3 条、src 全部 300 条、tsc（含 DOM）干净。真实 vitest 环境和构建在 Mac 跑。

## dev 网关验收（2026-10-15，19001）

用 `spikes/ui-fixture.mts` 造事项 TYAKT799N（R1 / R2 / R3 / 多候选各一条待决策 + 一个 60 分钟回检），全部通过：

- R1 决策对话框「批准」直接可点；R2、R3「批准」为灰，勾选「我已核对…同意授权」后才可点；多候选必须先选一个动作。
- 取消回检后顶部出现「已取消回检 <id>」。
- 编辑自己声明的偏好：范围、键只读，只改值。
- HTTP 页 `/plugins/nexus-agent-core/ui/` 没有任何按钮。
- 此前已验：拒绝一条决策（事项回到 planning）、偏好新增再删除。

尚未在页面上走完：R2/R3 真实批准（产出 ready 的 execution）、过时/被取代/RPC 报错的对话框分支、编辑偏好的保存回读。

## 事项列表：分页与筛选（2026-10-15）

- 动机：列表一次取 100 条，事项多了不好看。选的方案：服务端（存储层 SQL）做；关键字搜标题 + 目标 + 摘要 + 要素；时间按创建时间（预设 + 自定义日期）；HTTP 页与浏览器模块都做，共用一套查询。
- 控件：编号、标题、关键字、状态（全部 / 未结束 / 已结束 / 单个状态）、创建起止时间（本地时间，分钟精度，`datetime-local`）+ 预设（今天 / 近 7 天 / 近 30 天）、每页 20 / 50 / 100、筛选 / 重置。分页：总数、首页 / 上一页 / 页码窗口 / 下一页 / 末页；页码超范围回退最后一页。列表有「创建」「更新」两列，表头标时区（如 UTC+08:00）。页面上所有时间改为本地时间 `YYYY-MM-DD HH:mm:ss`（不再是带 Z 的 UTC）：浏览器模块用浏览器时区；HTTP 页无脚本拿不到浏览器时区，用网关机器时区，筛选栏写明「UTC+08:00 本地时间」。搜索时间按本地时刻换算成毫秒再查库，`to` 含整分钟（库里取下一分钟起点、不含）。
- 存储层：新增 store 操作 `queryTasks`（返回 `{tasks, total}`，`list` 保留）；`nexus.task.list` 向后兼容地加 `offset`、`id`、`title`、`keyword`、`createdFrom`（含）、`createdTo`（不含），响应加 `total`、`offset`。LIKE 通配符转义；类型 / 长度在 RPC 校验。
- 共用模块 `src/task-query.ts`：解析并校验筛选、转 RPC 参数（日期按本地时区）、预设、页码窗口、控件列表 `FILTER_FIELDS`（HTTP 页渲染 `<form>`，浏览器模块建 DOM）。
- 浏览器模块：筛选放在宿主页面参数（`qid qtitle qkw status from to page size`，只写非默认值），所以刷新 / 后退 / 从详情返回都保留；输入框只在筛选参数变化时重置，事件刷新不清掉正在输入的内容。（注：从详情点「← 事项」或「事项」标签返回时筛选会丢，已在 2026-10-16 修复，见 followups-1016。）
- HTTP 页：GET 表单；**该页 CSP 的 `form-action` 由 `'none'` 改为 `'self'`**（处理器只接受 GET / HEAD），其他页仍是 `'none'`。
- 局限：关键字不搜决策 / 声明 / 回执；含 `"` 或反斜杠的关键字匹配不到 JSON 转义后的形式；HTTP 页按网关机器时区，浏览器模块按浏览器时区；夏令时跳过的本地时刻视为无效输入。
- VM 测试：src 325 条（新增存储查询 9、筛选工具 5、本地时间 3、RPC 2、HTTP 页 6），浏览器模块 42 条，tsc 干净。Mac 上 oxfmt / tsgo / vitest / 资源构建待跑，构建后 `openclaw.plugin.json` 的 `controlUi` 哈希会再变，要一并提交。

## 页面语言与筛选栏显示修复（2026-10-15）

- 问题 1：浏览器模块里筛选栏出现在偏好 / 清除回执页。原因：筛选栏的 `display:flex` 盖掉了 `hidden` 属性。修复：样式表加 `.nexus-page [hidden]{display:none !important}`，测试断言规则存在、非列表页筛选栏隐藏。
- 问题 2：界面中英混杂、文字写死中文。做法：`src/i18n.ts` 中 / 英两套文案（键两种语言都要有、占位符一致，英文里不得出现中文，测试检查）。语言来源：浏览器模块用 `host.locale`（每次加载重新读，输入中的内容保留）；HTTP 页用 `Accept-Language`。`zh*` → 中文，其他语言 → 英文，没有 → 中文。
- 覆盖：导航、列表、筛选栏、分页、详情各节与表头、偏好页、清除回执页、所有对话框与通知、偏好校验提示。
- 不翻译：状态名、风险档、RPC 名、编号。状态筛选选项固定英文：`all` / `open` / `closed` + 各状态名。
- 仍是中文：服务端生成并存库的决策问题 / 事实 / 选项文案（参与 authority hash）、步骤日志、事项备注、给模型的工具说明与提示词。要改需先决定「存键值、显示时翻译」还是「按创建语言存」。
- 测试：src 334 条（新增文案 6、HTTP 页语言 3），浏览器模块 50 条，tsc 干净。

## 创建时间输入框改为纯文本（2026-10-15）

- 原生 `datetime-local` 按浏览器自己的语言和格式显示（中文浏览器里是「2026年10月15日 下午 03:00」），与页面统一格式不一致，也不随页面语言变。改为文本框：占位符 `YYYY-MM-DD HH:mm`，接受 `YYYY-MM-DD` 或 `YYYY-MM-DD HH:mm`（空格或 T），内部 / URL 存 `YYYY-MM-DDTHH:mm`，纯日期的「至」取当天 23:59。
- 输入不是真实日期时给出提示（浏览器模块不跳转；HTTP 页表单里显示同一行提示），不再悄悄丢弃。代价：没有日历选择器，预设按钮可代替常用情形。
- 用户确认：服务端生成并存库的内容（决策文案、步骤日志、事项备注）保持原样，不翻译。
- 测试：src 338 条，浏览器模块 53 条，tsc 干净。
