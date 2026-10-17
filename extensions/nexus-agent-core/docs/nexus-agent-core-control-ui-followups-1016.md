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
