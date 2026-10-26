# Nexus Agent Core Plugin: 安装版（pkg）回归记录

## 2026-10-14（上午）：Stage 2 在安装版上通过

- **包**：`openclaw --version` = `2026.9.4 (18f7662)`；打包命令先于提交 `b2621cdadb6` 执行，所以版本号是 `18f7662`。安装版 `dist/extensions/nexus-agent-core/index.js` 与仓库 `dist/` 里的 sha256 一致。
- **路径**：`~/.openclaw/tools/node-v24.19.0/lib/node_modules/openclaw/dist/extensions/nexus-agent-core`；launchd 网关，端口 18789，状态目录 `~/.openclaw`。
- **配置**（`openclaw config set`）：`decisionsEnabled=true`、`fakeProviderIdempotent=true`、`fakeProviderMode="ok"`、`coreApprovalEnabled=true`、`approvalTimeoutMs=300000`；`tools.alsoAllow` 加 `nexus_action_prepare / authorize / nexus_decision_request / nexus_action_commit`。
- **探针**（`OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789`、`OPENCLAW_STATE_DIR=$HOME/.openclaw`，开放的 Task `T89A1Y7Q4`）：`r1-flow` 全部通过；`concurrent-commit --task`（6 路并发，首次执行恰好 1 个，3 个 `pending_confirmation(in_flight)`，2 个 `replayed`）；`fault-modes` 的 `reject` / `drop_before_send` / `drop_after_success` 全部通过，结束后恢复 `ok`。第一次 `fault-modes reject` 的 5 项 FAIL 是网关仍在 `ok` 模式，不是包的问题。（`concurrent-commit` 新增 `--task`：自己登记动作、请求决策、批准后再并发。）

## 2026-10-14（下午）：Stage 3（切片①②③ + 小缺口收尾）在安装版上通过

- **包**：`openclaw --version` = `2026.9.4 (9b0ac3f)`，等于仓库 HEAD `9b0ac3fb510`（这次是先提交后打包，版本号对得上）。`grep -c "nexus.evidence.handle" $P/index.js` = 2，说明包含读句柄这批代码（上一个 `18f7662` 的包是 0）。
- **配置**：在上面 Stage 2 配置之上打开 `claimsEnabled` 与 `evidenceBlobsEnabled`，`tools.alsoAllow` 加 `nexus_claim_add / nexus_evidence_add / nexus_claim_verify`，重启网关。
- **探针**：`claim-flow.mts`、`blob-flow.mts`（含 handle / read / `task.get` 检查）、`purge-flow.mts`（含 `operator.admin` 的 purge RPC、单条删除、共享对象、回执、`foreign_key_check`）在安装版上**全部通过**。
- 结论：Stage 2 与 Stage 3 切片①②③在 pkg 安装产物上的回归完成；真实 `openBlobStore`、launchd 网关、`~/.openclaw` 状态目录都已覆盖。

## 2026-10-14（晚）：Stage 4（Preference、Watcher、Control UI 浏览器模块）在安装版上通过

- **包**：`openclaw --version` = `2026.9.4 (d18d53f)`；仓库 HEAD `fa6885c251c` 是它的下一个提交。打包时工作区里的代码与 `fa6885c` 相同、只是还没提交，所以版本号落后一个提交，内容一致。`grep -c "nexus.watch.list" $P/index.js` = 1，说明包含 Watcher。
- **配置**：在 Stage 3 配置之上开 `preferencesEnabled`、`watchersEnabled`；`tools.alsoAllow` 整体替换为 19 个 Nexus 工具（task 6、action 4、claim/evidence 3、preference 3、watch 3，不含 `nexus_spike_probe`）。`tools.alsoAllow` 是整个列表替换，不是追加；改完网关热更新，又执行了 `openclaw gateway restart`（launchd）。
- **探针**：`preference-flow.mts` ALL PASS；`watch-flow.mts` ALL PASS（含 `watch_changed` 事件顺序 created → scheduled → firing → exhausted，一次真实的回检模型回合）。结束后 `openclaw cron list --all` 里没有残留的 `nexus-watch-*` 任务。
- **Control UI**：应用（WKWebView）左侧 Nexus 标签由插件自带的浏览器模块渲染，事项 / 偏好 / 清除回执三个标签可见，列表含探针留下的已取消 Task 与 `T89A1Y7Q4` 的"3 待决策"徽标。浏览器模块构建注意：`package.json` 的 `assetScripts` 要带 `TSX_TSCONFIG_PATH=../../tsconfig.json`，否则扩展自己的 `tsconfig.json` 会覆盖根配置的路径别名，构建报 `Cannot find package '@openclaw/normalization-core'`。
- 结论：Stage 4 在 pkg 安装产物上的回归完成。

## 2026-10-15：控制台操作按钮、事项列表筛选与分页、本地时间、中英文本地化在安装版上通过

- **范围**：此前安装版（18789）仍是无按钮的旧构建；这次重新打包（`ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer`）后，在安装版应用里验证了下列内容。包的版本号与 `controlUi` 哈希没有记录。
- **验证内容**（按当时给出的验证清单，具体逐项结果以用户口头确认为准）：决策批准 / 拒绝、取消回检、偏好新增 / 编辑 / 删除按钮；事项列表的分页与筛选（编号、标题、关键字、状态、创建起止时间、预设、每页条数）；列表的创建 / 更新两列与本地时间；筛选栏只出现在事项页；状态下拉为英文选项；界面随应用语言切换中英文；时间输入框为纯文本（`YYYY-MM-DD HH:mm`）并对非法输入给出提示。
- **结论**：用户确认安装版验证结果与 dev 网关（19001）基本一致；"基本"之外的差异没有逐项记录。验证前已在 Mac 上跑过 oxfmt、`pnpm tsgo:extensions`、`pnpm test:extension nexus-agent-core`（含浏览器模块 vitest）和资源构建；dev 网关的逐项验收见 `claude/nexus-agent-core-control-ui-module.md`。
- **仍未覆盖**：R2 / R3 真实批准（产出 ready 的 execution）、过时 / RPC 报错的对话框分支、编辑偏好的保存回读，在 dev 与安装版上都没有走完。

## 2026-10-15（晚）：代码审查修复后重新打包，探针在安装版上通过

- **范围**：审查修复之后重新打包（`ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer`）。这批改动包括：`watcherExtraTools` 改为 Nexus 持有的允许列表、HTTP UI 的 Claims 开关、manifest 删除 `evidenceDebugDelayAfterA2Ms`、证据服务的崩溃窗口改为注入钩子（仅 `spikesEnabled`）、provider 守卫（T6）、spikes 改用 plugin-sdk 导入。包的版本号没有记录。
- **探针**（`OPENCLAW_GATEWAY_URL=ws://127.0.0.1:18789`、`OPENCLAW_STATE_DIR=$HOME/.openclaw`）：`r1-flow`、`claim-flow`、`blob-flow`、`watch-flow`、`preference-flow` **全部通过**。
- **`r1-flow` 的一次误报**：第一次在 `T89A1Y7Q4` 上跑，第 2 步「无 policy → `no_policy`」失败，实际返回 `policy_not_applicable (revoked)`。原因是该事项之前的运行已经签发并撤销过同一 vendor（`Acme Rooms`）的 standing grant，被撤销的授权仍然「覆盖」同类动作，这是设计内行为（`findStandingGrant` 的 `covered`），不是回归；脚本开头「同一个 Task 可以重复运行」的说法不成立。换一个新事项后全部通过。后续可选改进：探针每次用唯一 vendor 名。

## 2026-10-16：筛选保留、查看原文、详情页时间列在安装版上通过

- **范围**：重新打包（`ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer`）后，在安装版应用里验证本轮控制台改动。包的版本号与 `controlUi` 哈希没有记录（下次打包请记下 `openclaw --version` 与 `git diff` 里的 `controlUi` 哈希）。
- **已验证（用户确认）**：事项列表设好筛选后进详情再返回，筛选保留；历史数据里已有的文本证据可以「查看原文」并看到内容；声明、证据、步骤日志的时间列已显示；界面切到英文正常。
- **未单独验证**：二进制证据显示"内容不是文本"、无字节证据行不显示按钮、在列表页再点「事项」标签清空筛选；这几项在浏览器模块单元测试里有覆盖，安装版上没有逐项走。
- **dev 阶段的两个教训**：① 存了字节的证据 `redactionState` 是 `raw`，不是 `none`；第一版按 `none` 判断导致 dev 里按钮不出现，已改为"有 `blobKey` 且不是 `purged`"，「字节」列同时修正。② dev 终端残留环境变量会让 `gateway call` 连到正式网关；上传证据前先确认连的是 19001。另外 `doctor --fix` 在配置无效时会把插件置为 disabled 并清掉它的 config，恢复要重新 `plugins enable` 并重设各开关。
- **打包摸底结论**：`openclaw plugins pack` 只适用于 `defineToolPlugin` / `defineFeaturePlugin` 写法；Nexus 要对外分发需要走 `npm pack`（构建出 `dist/`）+ `npm-pack:` 安装，见 `claude/nexus-agent-core-control-ui-followups-1016.md`。

## 2026-10-16（晚）：第三方安装路径（`npm pack` + `npm-pack:`）在官方 OpenClaw 上通过

- **环境**：官方 npm 版 `openclaw` 2026.9.8（`/tmp/oc-official`，不含 Nexus），隔离状态目录，端口 19777，网关用固定测试 token。插件由 `node extensions/nexus-agent-core/scripts/build-dist.mjs` 构建（`dist/index.js`、`dist/src/store/sqlite-store.worker.js`、`dist/control-ui/<hash>/`），`npm pack` 后以 `plugins install npm-pack:<tgz> --accept-capabilities` 安装；`plugins inspect` 显示 `Origin: global`、`Artifact kind: npm-pack`。包的版本号与 `controlUi` 哈希没有记录。
- **验证**：`docs/nexus-agent-core-install-and-demo.md` §6 演示表的 1–8 幕全部在这个第三方安装上验证过：空状态、待决策卡片（ui-fixture）、页面审批、声明与证据（claim-flow）、标准授权 R1（r1-flow）、并发提交、偏好（preference-flow）、筛选保留与语言切换。第 9 幕（需要模型的回检）与第 10 幕（证据原文，第三方安装下不可用）没有跑。
- **第三方安装的限制**：非内置插件调用 `openBlobStore` 会被宿主拒绝（`plugin-trust.ts`），`before_prompt_build` 需要 `hooks.allowConversationAccess=true`。插件已自动降级：只打一条 warn，证据字节相关的 RPC 返回 `nexus_evidence_unavailable`，`nexus_evidence_add` 的 `blob` 引用返回 `evidence_bytes_unavailable`，其余功能不受影响。证据原文存储是否改成不依赖宿主，取决于分发方式，尚未决定。
- **这轮踩到的坑**（都在手册里写了）：① zsh 不会拆分 `$RUN` 变量，要用函数和数组；② 探针客户端是仓库构建（schema 17），不能用官方网关（schema 19）的状态目录，给探针一个独立目录，里面只放指向网关 `plugins/` 的符号链接；③ `OPENCLAW_STATE_DIR` 必须是目录，不是 `nexus.sqlite` 文件；④ `r1-flow` 固定用 `Acme Rooms`，事项上已有 standing grant 会误报，已改为每次运行用不同 vendor。
- **事项列表默认排序**：最近更新在前，更新时间相同按编号升序（`ORDER BY updated_at DESC, id`），自 Stage 1 起没变。决策批准、拒绝、回检等造成的事项状态变化会让事项重新排到最前；用户决定保持现状。

## 2026-10-26：文件库 F1 + F2 + F3 与文件页改进在安装版上通过

- **范围**：打包默认带上文件柜和证据原文（`OPENCLAW_INSTALLER_NEXUS_PRESET=1`，预设版本 2），命令为 `OPENCLAW_INSTALLER_NEXUS_PRESET=1 OPENCLAW_INSTALLER_DEFAULT_MODEL=0 OPENCLAW_INSTALLER_LLAMA=0 OPENCLAW_INSTALLER_LITELLM=0 ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer`；安装版 2026.9.4（77bb1cf 之后重新打包），网关 18789，状态目录 `~/.openclaw`。
- **已验证（用户确认，功能正常）**：文件页出现；上传、预览、搜索内容、引用码、挂证据与“查看原文”、标敏感后搜不到、分块上传、永久清除；文件页的名称搜索、分页（含切换标签页后保留筛选和页码）、类型 / 收藏 / 敏感筛选、失败原因按语言显示。
- **没有逐项记录输出**：用户口头确认“基本验证完成，功能正常”。
- **仍未做**：WebSocket 只读客户端的权限拒绝（可选实验）；S8 缺口记为已知限制。

## 还没做（可选）

- Stage 2 在安装版上的卡片流（注入、迟到 Deny）和 kill -9 恢复（K1–K3）、Stage 3 的 kill -9 崩溃测试（`blob-flow --phase crash-a / crash-b`，需要调试配置）。
- `incarnation_gone` 启用清单观测（`purge-flow.mts --phase incarnation`），开关保持 off。
