# Nexus Agent Core Plugin：安装与演示手册

> 2026-10-16。适用：用官方 OpenClaw（不含 Nexus）+ `npm-pack:` 本地包安装 Nexus，并用仓库里的探针脚本做演示与验收。
> 对外发布（`npm:` / `clawhub:`）的命令在 §7，尚未实际发布过。

## 1. 已验证的事实（2026-10-16，Mac，官方 OpenClaw 2026.9.8）

- `npm pack` 的包能被 `openclaw plugins install npm-pack:... --accept-capabilities` 安装；`plugins list` 来源为安装包（`Origin: global`），不再是 `stock:`。
- 网关能加载打包后的 `dist/index.js`；SQLite worker `sqlite-store.worker.js` 正常启动，`nexus.sqlite` 创建在状态目录 `plugins/nexus-agent-core/` 下，`nexus.task.list` 返回空列表。
- 打开 `customPlugins` 后，Control UI 的 `/nexus` 页面可打开（空数据）。
- 仓库自带 Nexus 时，同 id 的安装包会被内置版覆盖（`duplicate plugin id`）。要验证安装包，必须用官方 npm 版 OpenClaw，不能用本仓库的 CLI。

## 2. 已知限制（第三方安装）

1. **`before_prompt_build` 被拦截**：非内置插件必须设 `plugins.entries.nexus-agent-core.hooks.allowConversationAccess=true`，否则“未完成事项注入提示词”不生效。
2. **证据原文存储不可用**：宿主只允许内置插件或官方外部插件目录里的插件调用 `openBlobStore`（`src/plugins/plugin-trust.ts`、`registry-runtime.ts`）。`npm-pack:` 本地包、第三方 `npm:`、ClawHub 都不满足。插件会自动降级（2026-10-16 起）：即使打开了 `evidenceBlobsEnabled`，启动时也只打一条 warn（`evidence bytes are off for this install (openBlobStore is only available for trusted plugins in this release)...`），不再出现 `evidence reconcile failed`；之后证据字节相关的 RPC（上传、读取、清除）返回错误码 `nexus_evidence_unavailable`，`nexus_evidence_add` 的 `blob` 引用返回 `evidence_bytes_unavailable`，后台对账 / 回收 / 清除续跑都跳过。任务、声明、execution 证据、元数据证据、决策、偏好、回检不受影响。第三方安装下建议不设 `evidenceBlobsEnabled`，就连这条 warn 也没有。
3. 可选工具需要 `tools.alsoAllow`；第三方插件需要 `--accept-capabilities`；原生 Control UI 需要 `gateway.controlUi.experimental.customPlugins=true` 并重启网关。

## 3. 构建与打包（开发机）

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw
git status --short extensions/nexus-agent-core   # 先提交代码，再打包
pnpm exec oxfmt extensions/nexus-agent-core
node extensions/nexus-agent-core/scripts/build-dist.mjs
git diff --stat extensions/nexus-agent-core/openclaw.plugin.json   # controlUi 哈希变了要一并提交

mkdir -p /tmp/nexus-pack && cd extensions/nexus-agent-core
npm pack --pack-destination /tmp/nexus-pack
tar -tzf /tmp/nexus-pack/*.tgz | head -40   # 应有 dist/index.js、dist/src/store/sqlite-store.worker.js、dist/control-ui/<hash>/，不应有 .ts 源码
```

`build-dist.mjs` 复用仓库的 `scripts/lib/plugin-npm-runtime-build.mjs`（tsdown；`openclaw` 与 `openclaw/*` 外置，`typebox` 来自 `dependencies`），并在末尾检查入口、worker、唯一的 control-ui 哈希目录。`package.json` 用 `openclaw.runtimeExtensions: ["./dist/index.js"]` 指向编译产物，`openclaw.extensions` 仍是 `./index.ts`，所以源码开发模式不变。

## 4. 安装（干净环境）

```bash
mkdir -p /tmp/oc-official && cd /tmp/oc-official
npm init -y >/dev/null && npm i openclaw            # 官方 npm 版，不含 Nexus
OC=./node_modules/.bin/openclaw
$OC --version                                        # 需 >= 2026.9.4

export OPENCLAW_STATE_DIR=$(mktemp -d)               # 隔离状态目录；只在这里执行一次！记下它，其他终端用 export OPENCLAW_STATE_DIR=<这个路径>
echo "$OPENCLAW_STATE_DIR"
$OC plugins install npm-pack:/tmp/nexus-pack/openclaw-nexus-agent-core-2026.9.4.tgz --accept-capabilities
$OC plugins list | grep -i nexus                     # 来源是安装包路径，不是 stock:
$OC plugins inspect nexus-agent-core                 # Origin: global；Artifact kind: npm-pack
```

预期：安装日志以 `Installed plugin: nexus-agent-core` 结束；不出现 `duplicate plugin id`、`requires compiled runtime output`、`no authoritative package-owner metadata`。

## 5. 配置

```bash
TOKEN=$(openssl rand -hex 16); export TOKEN          # 测试用 token，不要贴到聊天里
$OC config set gateway.port 19777
$OC config set gateway.auth.mode token
$OC config set gateway.auth.token "$TOKEN"
$OC config set gateway.controlUi.experimental.customPlugins true
$OC config set plugins.entries.nexus-agent-core.hooks.allowConversationAccess true

C=plugins.entries.nexus-agent-core.config
for k in tasksEnabled decisionsEnabled claimsEnabled preferencesEnabled watchersEnabled fakeProviderIdempotent; do
  $OC config set $C.$k true
done
$OC config set $C.fakeProviderMode '"ok"' --strict-json   # 假供应商，只用于演示，不产生任何外部效果
# 第三方安装不要设 evidenceBlobsEnabled（见 §2.2）；设了也只会降级并打一条 warn

$OC config set tools.alsoAllow '["nexus_task_reserve","nexus_task_create","nexus_task_get","nexus_task_update","nexus_task_note","nexus_task_search","nexus_action_prepare","nexus_action_authorize","nexus_decision_request","nexus_action_commit","nexus_claim_add","nexus_evidence_add","nexus_claim_verify","nexus_preference_get","nexus_preference_set","nexus_preference_confirm","nexus_watch_create","nexus_watch_cancel","nexus_watch_report"]' --strict-json
```

`tools.alsoAllow` 是整个列表替换，不是追加。不含 `nexus_spike_probe`。

启动网关（终端 A，保持运行）：

```bash
$OC gateway run --allow-unconfigured
```

预期启动日志：`nexus-agent-core register: mode=full ... tasksEnabled=true decisionsEnabled=true claimsEnabled=true`、`watcher hooks registered`、`worker startup state` 里有 `sqlite-store.worker.js`、`nexus: startup reconciliation pendingDecisions=0 ...`，末行 `ready`。不应再有 `before_prompt_build blocked`；不应有 `evidence reconcile failed`（因为没开 `evidenceBlobsEnabled`）。

## 6. 演示脚本

> **说明：本节是“命令行功能验证”，不是功能演示。** 面向观众的演示（只用 OpenClaw 界面：聊天 + Nexus 页面，安装用 tgz，覆盖官方 OpenClaw 与 Mac App 两种环境）见 `nexus-agent-core-delivery-and-ui-demo.md`。本节的命令表适合彩排前自检、定位问题。

准备：终端 B 先 `export OPENCLAW_STATE_DIR=<§4 记下的目录>`、`export TOKEN=...`（与 §5 同一个值）、`OC=/tmp/oc-official/node_modules/.bin/openclaw`。**不要再执行 `mktemp -d`**：它每次都会生成一个新的空目录；探针脚本和 `sqlite3` 读的是终端 B 的 `$OPENCLAW_STATE_DIR`，必须和终端 A 里网关启动时的目录是同一个，否则会报 `unable to open database ".../plugins/nexus-agent-core/nexus.sqlite"`（RPC 却是成功的，因为 RPC 走网关）。自检：

```bash
ls "$OPENCLAW_STATE_DIR/plugins/nexus-agent-core/nexus.sqlite"     # 必须存在
# 不确定网关用的哪个目录时（状态目录是输出路径里 /plugins/ 之前的那一段，不是 nexus.sqlite 文件本身）：
lsof -p "$(lsof -nP -iTCP:19777 -sTCP:LISTEN -t | head -1)" | grep -i nexus.sqlite | sed -E 's#.* (/.*)/plugins/nexus-agent-core/nexus\.sqlite.*#\1#'
```

`OPENCLAW_STATE_DIR` 必须是目录。如果误设成了 `.../nexus.sqlite` 这个文件，探针会报 `ENOTDIR: not a directory, mkdir '.../nexus.sqlite/tmp/openclaw-501'`。
探针脚本在仓库里，需要在仓库根目录运行，并且本机装有 `sqlite3`：

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw
S=extensions/nexus-agent-core/spikes
run() { node --import ./scripts/tsx.mjs "$@"; }       # 不要写成 RUN="node --import ..." 再用 $RUN：zsh 不会按空格拆分变量，会报 "no such file or directory: node --import ./scripts/tsx.mjs"
ARGS=(--url ws://127.0.0.1:19777 --token "$TOKEN")    # 用 "${ARGS[@]}" 展开，bash / zsh 都行
```

**探针必须用单独的状态目录。** 官方 OpenClaw（如 2026.9.8）创建的 `state/openclaw.sqlite` 比仓库代码（2026.9.4）新，探针里的 `GatewayClient` 会打开这个库来读写本机设备身份，用同一个目录会报 `SqliteSchemaVersionError: ... uses newer schema version 19; this build supports 17`。办法是给探针一个独立目录，里面只放指向网关 `plugins/` 的符号链接（探针查 `nexus.sqlite` 时走这条链接）：

```bash
GW="$OPENCLAW_STATE_DIR"                              # 网关用的目录（§4）
PROBE=$(mktemp -d)                                    # 探针专用，只做一次
ln -s "$GW/plugins" "$PROBE/plugins"
ls "$PROBE/plugins/nexus-agent-core/nexus.sqlite"     # 必须存在
```

之后每条探针命令前加 `OPENCLAW_STATE_DIR="$PROBE"`，例如 `OPENCLAW_STATE_DIR="$PROBE" run $S/claim-flow.mts "${ARGS[@]}"`；`$OC` 命令仍用 `$GW`。下表里的 `$RUN $S/xxx.mts $ARGS` 都按这个写法理解。

浏览器：`$OC dashboard`（带 token 打开），再进 `/nexus`。

| 幕                              | 操作                                                                                                                          | 预期                                                                                                                                                                                                                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 空状态                        | `$OC gateway call nexus.task.list --params '{}'`；浏览器看事项列表                                                            | `total: 0`；页面三个标签（事项 / 偏好 / 清除回执），列表为空                                                                                                                                                                                                               |
| 2 待决策卡片                    | `$RUN $S/ui-fixture.mts $ARGS`                                                                                                | 新增 1 个事项，页面显示“4 待决策”徽标；详情里有 D-R1（R1 发消息）、D-R2（R2 预订）、D-R3（R3 付款 CNY 100）、D-多（两个候选预订），以及一条 60 分钟后的回检                                                                                                                |
| 3 审批操作                      | 在页面里：D-R1 点一次确认批准；D-R2 / D-R3 必须先勾选二次确认才能批准；D-多 必须先选一个动作；再取消回检                      | 各决策状态变更，待决策数递减；批准后出现 ready 的执行（假供应商）；回检显示已取消                                                                                                                                                                                          |
| 4 声明与证据                    | `$RUN $S/claim-flow.mts $ARGS`                                                                                                | 脚本末尾全部通过；页面出现一个已完成（succeeded）事项，详情里声明、证据、步骤日志每行都有创建 / 开始 / 结束时间，已处理的决策与执行也有时间；证据“字节”列为“无”，没有“查看原文”按钮（元数据证据，符合 §2.2）                                                               |
| 5 标准授权 R1                   | 取幕 2 事项的编号：`OPENCLAW_STATE_DIR="$PROBE" run $S/r1-flow.mts --task <taskId> --token $TOKEN --url ws://127.0.0.1:19777` | 全部通过；结尾撤销本次签发的 standing grant。脚本每次运行用不同的 vendor（`Acme Rooms <随机>`），所以在幕 3 里批准过 D-R1、或重复运行都不影响结果。旧版脚本固定用 `Acme Rooms`，遇到事项上已有该 vendor 的 standing grant 会在第 2、4 步误报，最后报 `grantId is required` |
| 6 并发提交                      | `$RUN $S/concurrent-commit.mts --task <仍打开的 taskId> --n 6 $ARGS`                                                          | 供应商账本只增加 1 行；恰好 1 个调用是首次执行，其余是重放或 `pending_confirmation(in_flight)`                                                                                                                                                                             |
| 7 偏好                          | `$RUN $S/preference-flow.mts $ARGS`；页面“偏好”标签                                                                           | ALL PASS；页面可新增 / 编辑 / 删除偏好                                                                                                                                                                                                                                     |
| 8 筛选与语言                    | 事项列表设置状态、关键字、创建时间筛选 → 进详情 → 返回；右上切换英文                                                          | 返回后筛选保留；英文界面文案正常                                                                                                                                                                                                                                           |
| 9（可选，需模型）回检           | 需要网关配置了可用模型：`$RUN $S/watch-flow.mts $ARGS`                                                                        | ALL PASS；`watch_changed` 顺序 created → scheduled → firing → exhausted，耗尽后出现一张 acknowledge 决策；`$OC cron list --all` 无残留 `nexus-watch-*`                                                                                                                     |
| 10（仅内置 / 官方安装）证据原文 | 需要 `evidenceBlobsEnabled=true`，只在 trusted 安装下可用：`$RUN $S/blob-flow.mts $ARGS`                                      | 第三方安装下不通过，这是 §2.2 的限制，不是缺陷                                                                                                                                                                                                                             |

模型驱动的演示（可选）：给网关配好模型后，在对话里让 agent 调用 `nexus_task_create` 等工具；没有模型时，上面的探针都是经 `tools.invoke` / RPC，不依赖模型。

## 7. 对外发布后的用户安装（尚未实际验证）

```bash
openclaw plugins install npm:<包名> --accept-capabilities        # 或 clawhub:<包名>
openclaw config set plugins.entries.nexus-agent-core.hooks.allowConversationAccess true
openclaw config set plugins.entries.nexus-agent-core.config.tasksEnabled true   # 其余开关按需
openclaw config set tools.alsoAllow '[...]' --strict-json
openclaw config set gateway.controlUi.experimental.customPlugins true
# 重启网关
```

没有官方的 `npx -y xxx install` 方式。发布前仍需决定：发布到 npm 还是 ClawHub、包名与作用域（现为 `@openclaw/nexus-agent-core` 且 `private: true`）、哪些开关默认关闭。

## 8. 收尾

```bash
# 终端 A：Ctrl+C 停网关
echo "$OPENCLAW_STATE_DIR"                            # 确认是 §4 的临时目录，不是 ~/.openclaw
rm -rf "$OPENCLAW_STATE_DIR"                          # 可选；不删则保留演示数据
unset OPENCLAW_STATE_DIR TOKEN                        # 每个用过的终端都要执行
```
