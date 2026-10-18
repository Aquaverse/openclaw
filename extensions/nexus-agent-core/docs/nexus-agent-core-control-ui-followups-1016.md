# Nexus Agent Core — 控制台后续（2026-10-16）

补充 `nexus-agent-core-control-ui-module.md`。

## 筛选在详情返回后保留

- 现象（安装版）：事项页设了筛选，进详情再回来，筛选回到默认。原因：详情页的「← 事项」和顶部「事项」标签都链接到不带筛选的列表。
- 修复（`browser/page.ts`）：`createNexusPage()` 闭包里记住最后一次列表筛选（含页码）；从非列表页发往「无筛选列表」的链接/导航改为带上记住的筛选。在列表页里再点「事项」标签仍是清空（"重来"）。记忆只在模块存活期间有效，刷新应用即清空。
- 测试：`page.test.ts` 新增 1 条。安装版已验证筛选保留。

## 查看原文（证据文本预览）

- 任务详情的证据表新增「原文」列；仅有字节的行有「查看原文」按钮。**"有字节"= `blob_key` 非空且 `redactionState` 不是 `purged`**（`ui-render.ts` 的 `hasBytes`）。存了字节的证据 `redactionState` 是 `raw`（schema 默认值），不是 `none`。
- 第一版误按 `redactionState === "none"` 判断，导致 dev 里上传了证据也没有按钮；同一个错误还让「字节」列对存了字节的证据显示 `raw` 而不是「在库」。已一并改正：现在显示「在库」/「无」（只有元数据）/`purged`。
- 对话框：`nexus.evidence.handle` + 一次 `nexus.evidence.read`（`operator.read`），最多前 64 KiB；只显示 UTF-8 文本（含 NUL、非法 UTF-8、控制字符超 2% 视为非文本，不预览）；截断时注明"前 N 字节，共 M 字节"；显示类型、大小、内容哈希；文本经 `textContent` 放入 `<pre>`，先过宿主 `redact`。
- `evidence_has_no_bytes` 的含义：该证据行没有字节（`blob_key` 为空，如 `execution` 引用只存元数据；或已 purged），句柄不能开。对话框把它翻成「这条证据没有原文」；表里这类行不显示按钮。
- 文件：新增 `browser/evidence-view.ts`；改动 `ui-render.ts`（`preview` 选项、`hasBytes`）、`i18n.ts`、`sanitize.ts`（新动作 `evidence-view`）、`actions.ts`（`NexusModel.evidence`）、`data.ts`、`style.ts`。
- 测试：`actions.test.ts` 新增 6 条（按钮只在有字节的行且「字节」列正确、文本不成标记、截断说明、二进制不预览、`evidence_has_no_bytes` 友好提示、解码边界）。
- dev 验收方法：`node openclaw.mjs --dev gateway call nexus.evidence.upload --params '{"taskId":"<未结束事项>","name":"receipt.txt","mediaType":"text/plain","dataBase64":"..."}'` 上传一份文本证据，刷新页面。注意终端里残留的环境变量可能让命令连到正式网关（本次就遇到过）。

## 详情页时间列

声明（创建、更新）、证据（创建 = 采集时间）、步骤日志（开始、结束）新增时间列，格式与决策 / 执行一致（本地时间 `YYYY-MM-DD HH:mm:ss`）。待决策列表没有创建时间（`DecisionRecord` 无此字段），保持只显示截止时间（用户决定先不加）。

## 打包流程摸底

- `openclaw plugins pack` 面向 `defineToolPlugin` / `defineFeaturePlugin` 写法的插件：先 `collectPluginsValidationResult`，其中 `loadToolPlugin` 要求入口导出静态 authoring metadata。Nexus 是手写 `openclaw.plugin.json` + `definePluginEntry`，所以报 `plugin entry does not expose tool or feature authoring metadata: ./index.ts`。这不是 bug，是形态不匹配。
- 官方文档对手写 manifest 的插件给的路径是：构建出 JS（`openclaw.extensions` 指向 `./dist/index.js`，`npm pack` 带上 `dist/`），`npm pack` → `openclaw plugins install npm-pack:<tgz>` → 发布用 `clawhub package publish` 或 `npm publish`。TypeScript 源入口只用于源码检出。运行时依赖必须在 `dependencies`。
- 待办：Nexus 要走这条路，需要先有一个把 `index.ts`、SQLite worker、`browser/` 资源构建进 `dist/` 的构建步骤，并去掉 `private: true`、处理 `@openclaw/` 作用域名。
- 用户安装后还需要：`plugins enable --accept-capabilities`、功能开关（现在默认全关）、`gateway.controlUi.experimental.customPlugins=true`（用户自己装的插件原生页面默认不加载）、optional 工具放行（`tools.alsoAllow`）。拟把任务/声明/证据/偏好/回检工具改成非可选，`nexus_action_*` 与 `nexus_decision_request` 保持可选。

## 待决策：R2 / R3 的聊天审批卡片没有二次确认（2026-10-18，留作后续参考）

**现状。** 预订（R2）和付款（R3）在 Nexus 决策页批准时必须先勾选二次确认；但聊天里的核心审批卡片只有「允许一次 / 拒绝」，点一次「允许一次」就是一次真实批准，没有勾选。原因：卡片由宿主渲染，插件的 `requireApproval`（`src/plugins/hook-before-tool-call-result.ts`）只能传 `title / description / scope / severity / timeoutMs / allowedDecisions / onResolution`，没有勾选框或自定义控件。设计文档 §8.11 也记着：R2 没有 approval scope，「结构化确认只能靠 Nexus 决策页」。

**已做的缓解（2026-10-18，不改宿主）。** `src/decision/approval-text.ts`：R2 / R3 的卡片标题加【R2】前缀，说明里写「高风险：这里点一次即批准；需要二次确认请到 Nexus 决策页」。这只是提示，不是拦截。手册第 5 幕据此说明：要演示二次确认，别点聊天卡片，去 Nexus 页面批准。

**要不要把聊天里的单击批准也关掉，是个安全与便利的取舍，没有定。下面是可选方案，按改动大小排序。**

1. **R2 / R3 只在 Nexus 页面批准（只改插件，推荐的第一步）。**
   - 做法：`decision-runtime.ts` 的 `beforeToolCall` 里，决策风险档为 R2 / R3 时不返回 `requireApproval`（现在的失败兜底就是返回 `undefined`，决策留在页面）；新增配置项（例如 `coreApprovalMaxTier`，默认 `R1`，`openclaw.plugin.json` 的 `configSchema` 与 `task-module.ts` 的 `coreApprovalEnabled` 旁边同步加）。
   - 效果：二次确认绕不过去；聊天里 agent 的回复是「请到 Nexus 决策页批准」，批准后靠已有的 `execution_ready` 注入和 `readyExecutions` 让 agent 继续（这条链路的 VM 测试已覆盖，宿主端注入未在 R2 上实测，落地时要在安装版验一遍）。
   - 代价：预订、付款必须离开聊天页面；演示第 5 幕的聊天卡片消失，手册要改回「只在页面批准」。
   - 要改的测试：`decision-flow.test.ts` 里用 R2 预订验证卡片的那条改成 R1（联系供应商），另加一条「R2 不出卡片、决策留 pending」。
2. **卡片只保留「拒绝」（只改插件，未验证）。** 把 R2 / R3 的 `allowedDecisions` 设为 `["deny"]`：聊天里只能拒绝，批准只能去页面。是否会被宿主正常渲染（只有一个按钮的卡片）、超时和 `onResolution` 行为是否正常，都没有试过，要先在安装版上验证。
3. **两次卡片（只改插件，体验差）。** 第一次批准后插件不放行，而是再发起一张「再确认一次」的决策与卡片。需要给决策加阶段字段、账本和 authority hash 都要跟着改，不推荐。
4. **改 OpenClaw 的 `src/` / `ui/`（改宿主，和上游分叉，需要单独评估）。**
   - 在 `PluginHookBeforeToolCallResult.requireApproval` 加一个可选的「需要勾选确认」字段（例如 `requireAck: { label }`），审批协议（`packages/gateway-protocol/src/schema/approvals.ts`）、审批管理端、Control UI 的审批卡片组件（`ui/`）和 macOS 原生 App 的审批界面都要支持：勾选后「允许」才可点。
   - 渠道里的审批（按钮式）没法放勾选框，要定义降级：要求再点一次，或直接只给「拒绝」。
   - 另一条路是按设计文档 §8.11 给 R2 补一个 `booking` approval scope（现在只有 `message-send / payment / external-post / standing-grant` 四种），用专门的卡片展示预订信息；同样要改协议和各端渲染。
   - 代价：改动面大、要跟上游同步；要先确认是否允许动 `src/` 和 `ui/`。建议只有方案 1 / 2 满足不了时再做，并先向上游提一个 RFC。

**建议顺序：** 先做方案 1（改动小、行为确定、可测试）；方案 2 在安装版验证后可作为「聊天里仍可拒绝」的补充；方案 4 作为长期方向记录，不在近期排期。

**关联：** 设计文档 §8.11（approval scope 映射）与 §8.10（卡片文本）、`docs/nexus-agent-core-delivery-and-ui-demo.md` 第 5 幕。
