# Nexus Agent Core Plugin：压缩包交付与 UI 演示手册

> 2026-10-17。目标：说明 Nexus 的三种交付路径，并在完成准备后**只在 OpenClaw 界面里**演示：和 agent 聊天、在 Nexus 页面点按钮。命令只出现在“准备”和“收尾”，不出现在演示过程中；“安装即用”只适用于 App 内置版或宿主已完成一次信任配置的安装版。
> 命令行逐条验证功能（探针脚本）见 `nexus-agent-core-install-and-demo.md`，那份是验证，不是演示。

## 1. 先说清楚的几件事

- **压缩包只能用命令装一次。** 控制台的“插件”页没有选本地 `.tgz` 的入口（我查了 `ui/src/pages/plugins`，只看到从目录安装和卸载；`plugins.install` 的 `npm-pack` 来源在底层 RPC 里有，但页面没接）。所以“安装”是准备步骤；装好之后的一切都在界面里。
- **agent 要有模型。** 演示主线是聊天：你对 agent 说话，agent 调 Nexus 的工具。模型用你平时的方式配置好（控制台的模型 / 认证设置，或命令行的配置向导，以实际版本为准）。**API key 不要贴到聊天或文档里。**
- **第三方安装必须开 `hooks.allowConversationAccess`。** Nexus 的“协议说明”（告诉 agent 怎么用这些工具、有哪些进行中的事项）是靠 `before_prompt_build` 注入的，宿主对非内置插件默认拦截它。不开的话，agent 不知道怎么用 Nexus，演示会失败。
- **第三方安装没有证据原文存储**（宿主只给内置 / 官方目录的插件 `openBlobStore`）。不要设 `evidenceBlobsEnabled`，演示里不演“上传 / 查看原文”。这一项只有“fork 打的 App（内置）”那条路径才能演。
- **agent 的行为是概率的。** 每一幕的“预期”写的是协议要求的结果，正式演示前请先完整彩排一遍；每幕都给了一句兜底的话术，agent 跑偏时用。

## 2. 三种分发模式：先选你是哪一种

普通用户不应该逐项理解 `tasksEnabled`、`tools.alsoAllow` 或 `customPlugins`。这些是宿主信任和开发验收开关，不是产品使用步骤。按下面的分发方式选择路径：

| 分发模式                      | 普通用户动作                                                        | 能力范围                                                              | 本手册入口 |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------- |
| **OpenClaw.app 内置版**       | 打开 App；在 Nexus 功能页启用标准配置（如果发行版已预置则无需配置） | Task、Decision、Claim、Preference；内置版可提供证据字节               | §2.1       |
| **官方目录 / 受信插件安装版** | 安装后接受一次 Nexus 信任/工具授权，再重启 Gateway                  | 与宿主授权和插件来源有关；证据字节以宿主是否授予 `openBlobStore` 为准 | §2.2       |
| **本地 `npm-pack:` 压缩包**   | 按开发者提供的安装配置步骤操作                                      | 适合演示和验收；第三方压缩包默认没有证据原文存储，不能承诺零配置      | §2.3、§3   |

### 2.1 普通用户：OpenClaw.app 内置版

这是“安装后启动即可用”的目标路径。Nexus 已由 App 作为 bundled plugin 提供时，用户不需要执行本手册后面的 `config set` 命令，也不需要手动打开 `hooks.allowConversationAccess` 或 `customPlugins`。启动 App 后：

1. 打开 Nexus 页面；如果发行版提供“启用 Nexus”按钮，只点一次。
2. 进入聊天，直接告诉 agent 要登记事项；首次使用时按页面提示允许 Nexus 工具。
3. 若要使用回检，再在 Nexus 页面打开 Watcher；不要为了基础 Task 功能打开开发探针。

如果 App 没有内置 Nexus，而是要安装一个本地 `.tgz`，请改走 §2.3；本地压缩包不能假定宿主会自动授予会话注入、Control UI 或证据字节权限。

### 2.2 官方目录 / 受信插件安装版

官方目录安装的目标体验是“一次安装、一次确认、之后在界面使用”。安装器或宿主引导应一次性处理插件信任、Nexus 工具授权和 Control UI；用户不应手写 19 个工具名。当前发行版如果没有这层引导，请按 §3 的开发/验收步骤完成一次配置，并把它视为临时安装流程，而不是最终产品体验。

第三方插件的会话内容访问和 Control UI 仍受宿主安全策略控制；不能由插件静默绕过。证据原文能力也必须以宿主实际授予 `openBlobStore` 为准。

### 2.3 本地 `npm-pack:`：开发 / 验收路径

本地压缩包路径不是零配置用户路径。它用于开发者验证、演示和回归，包含插件信任、工具 allowlist、阶段开关、日志检查以及环境 A/B。先完成 §3 的交付物检查，再按 §3.1–§3.3 配置；完成后演示部分从 §6 开始。

## 3. 开发 / 验收路径：压缩包交付与配置

打包（开发机，代码已提交之后）：

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw
pnpm exec oxfmt --check extensions/nexus-agent-core
node extensions/nexus-agent-core/scripts/build-dist.mjs
git diff --stat extensions/nexus-agent-core/openclaw.plugin.json    # controlUi 哈希变了就先提交

rm -rf /tmp/nexus-pack && mkdir -p /tmp/nexus-pack
(cd extensions/nexus-agent-core && npm pack --pack-destination /tmp/nexus-pack)
ls -l /tmp/nexus-pack
shasum -a 256 /tmp/nexus-pack/*.tgz
tar -tzf /tmp/nexus-pack/*.tgz | head -40
```

交付前逐项确认：

| 项   | 要求                                                                                                                                                                                                                                                                                                                                                |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 文件 | `openclaw-nexus-agent-core-2026.9.4.tgz`（以 `npm pack` 的输出为准）                                                                                                                                                                                                                                                                                |
| 内容 | 有 `package.json`、`openclaw.plugin.json`、`dist/index.js`、`dist/src/store/sqlite-store.worker.js`、`dist/control-ui/<一个哈希目录>/`；**没有** `.ts` 源码、`spikes/`、`docs/`、测试                                                                                                                                                               |
| 校验 | 把 `shasum -a 256` 的结果随压缩包一起给对方                                                                                                                                                                                                                                                                                                         |
| 版本 | 记下 `package.json` 的 version 和 `controlUi` 哈希，以及打包时的 `git rev-parse --short HEAD`                                                                                                                                                                                                                                                       |
| 要求 | OpenClaw >= 2026.9.4（`peerDependencies`）；本机 Node 能联网装 `typebox` 依赖                                                                                                                                                                                                                                                                       |
| 安装 | `openclaw plugins install npm-pack:<绝对路径>.tgz --accept-capabilities`                                                                                                                                                                                                                                                                            |
| 配置 | 见 §3.2；安装本身**不会**打开任何功能（默认全关）                                                                                                                                                                                                                                                                                                   |
| 限制 | 无证据原文存储；需要 `allowConversationAccess`；需要 `customPlugins` 才能在左侧看到 Nexus 页面                                                                                                                                                                                                                                                      |
| 卸载 | `openclaw plugins uninstall nexus-agent-core`，再重启网关；数据在状态目录 `plugins/nexus-agent-core/nexus.sqlite`，不会随卸载删除。**卸载 / 重装会把插件自己的配置重置**（功能开关全回到 `false`、`hooks` 授权丢失，`openclaw plugins enable` 也不会恢复），重装后必须重做 §3.2 再重启网关；`customPlugins` 和 `tools.alsoAllow` 是全局配置，会保留 |

### 公共步骤：安装与配置（环境 A、B 都用）

下面所有命令里的 `openclaw` 指“要演示的那个 OpenClaw”：环境 B 是 App 自带的命令行；环境 A 是隔离安装的 `$OC`（见 §4，把 `openclaw` 换成 `$OC`）。

**3.1 安装压缩包**（只做一次；卸载后重装也要再做 3.2：卸载会重置插件自己的配置，日志里会看到 `mode=full ... tasksEnabled=false`，插件在但什么都没挂上）

```bash
openclaw plugins install npm-pack:/tmp/nexus-pack/openclaw-nexus-agent-core-2026.9.4.tgz --accept-capabilities
openclaw plugins list | grep -i nexus        # 来源是安装包路径，不是 stock:
```

安装不会打开任何功能，也不会让左侧出现 Nexus 页面；**必须再做 3.2 并重启网关**。

**3.2 配置**（先按平时的方式配好模型；API key 不要贴到聊天或文档里）

```bash
# 让左侧出现 Nexus 页面（第三方插件的控制台页面默认关闭）
openclaw config set gateway.controlUi.experimental.customPlugins true

P=plugins.entries.nexus-agent-core
# 允许 Nexus 通过 before_prompt_build 把协议说明和进行中的事项注入 agent（不开则 agent 不会用 Nexus）
openclaw config set $P.hooks.allowConversationAccess true
for k in tasksEnabled decisionsEnabled claimsEnabled preferencesEnabled watchersEnabled fakeProviderIdempotent; do
  openclaw config set $P.config.$k true
done
# 演示用假供应商：不会产生任何外部效果
openclaw config set $P.config.fakeProviderMode '"ok"' --strict-json

# 放行 Nexus 的 19 个工具。tools.alsoAllow 是整体替换：先 `openclaw config get tools.alsoAllow`，有原有项就一并写进来
openclaw config set tools.alsoAllow '["nexus_task_reserve","nexus_task_create","nexus_task_get","nexus_task_update","nexus_task_note","nexus_task_search","nexus_action_prepare","nexus_action_authorize","nexus_decision_request","nexus_action_commit","nexus_claim_add","nexus_evidence_add","nexus_claim_verify","nexus_preference_get","nexus_preference_set","nexus_preference_confirm","nexus_watch_create","nexus_watch_cancel","nexus_watch_report"]' --strict-json
```

**3.3 重启网关并自检**

环境 B：`openclaw gateway restart`，然后完全退出并重新打开 App（或刷新控制台）。环境 A：见 §4。

自检（网关日志里）：有 `nexus-agent-core register: mode=full ... tasksEnabled=true decisionsEnabled=true claimsEnabled=true`、`watcher hooks registered`，**没有** `before_prompt_build blocked`，没有 `evidence reconcile failed`；左侧能看到 Nexus。看不到时依次查：

```bash
openclaw plugins list | grep -i nexus
openclaw config get gateway.controlUi.experimental.customPlugins     # 应为 true
openclaw logs 2>&1 | grep -i -E "nexus|blocked|duplicate|error" | tail -n 40
```

## 4. 环境 A（可选）：官方 OpenClaw + 隔离目录

不碰正式的 `~/.openclaw`，随时丢弃。不想碰 App 时才用；只演示 App 可跳过。

```bash
mkdir -p /tmp/oc-official && cd /tmp/oc-official
[ -d node_modules/openclaw ] || { npm init -y >/dev/null && npm i openclaw; }
OC=/tmp/oc-official/node_modules/.bin/openclaw
$OC --version                                         # >= 2026.9.4

export OPENCLAW_STATE_DIR=$(mktemp -d)                # 只在这里执行一次，记下输出
echo "$OPENCLAW_STATE_DIR"
```

然后做 §3.1、§3.2（`openclaw` 换成 `$OC`），再加上隔离环境专用的端口和 token：

```bash
TOKEN=$(openssl rand -hex 16)                          # 测试 token，不要贴到聊天里
$OC config set gateway.port 19777
$OC config set gateway.auth.mode token
$OC config set gateway.auth.token "$TOKEN"
$OC gateway run --allow-unconfigured                   # 终端 A，保持运行
```

终端 B：`export OPENCLAW_STATE_DIR=<上面记下的目录>`，`$OC dashboard`（会带 token 打开浏览器）。

## 5. 环境 B：Mac 上的 OpenClaw.app（当前主线）

App 的网关是 launchd 服务，状态目录是正式的 `~/.openclaw`（端口 18789），**不用临时目录**，沿用 App 自己的端口和 token。**先备份，且终端里先 `unset` 这几个变量，否则命令可能连到别的环境。**

```bash
unset OPENCLAW_STATE_DIR OPENCLAW_GATEWAY_URL OPENCLAW_GATEWAY_TOKEN
openclaw --version
openclaw backup create                                  # 先备份
```

**B-1：官方发行版 App（不含 Nexus）+ 压缩包** —— 最接近“用户拿到压缩包”的真实场景。依次做 §3.1、§3.2、§3.3。

**B-2：你 fork 打的 App（Nexus 是内置的）** —— 这个 App 里装压缩包会被内置版覆盖（日志 `duplicate plugin id ... bundled plugin`），所以跳过 §3.1，只做 §3.2 的开关（`hooks.allowConversationAccess` 那条可省，内置插件不需要）和 §3.3。这条路径是“内置分发”的演示，证据原文存储可用，可以额外演“查看原文”（需要先用探针脚本或 RPC 上传一份证据，页面本身没有上传按钮）。

## 6. 演示脚本（全程在界面里）

**布置**：浏览器开两个标签，一个是 OpenClaw 聊天，一个是 Nexus 页面（左侧 Nexus）。Nexus 页面开始是空的。事项列表按“最近更新在前”排序，发生变化的事项会跳到最前，属于正常。

### 第 1 幕：空状态

- **做**：打开 Nexus 页面。
- **看到**：事项 / 偏好 / 清除回执三个标签，事项列表为空。
- **讲**：“这是 Nexus：把一件要持续好几轮才办完的事，从聊天里提出来，变成一条可追踪、可审批的记录。”

### 第 2 幕：从聊天里登记事项

- **对 agent 说**：“帮我登记一个事项：10 月 20 日在东京订一间房，预算每晚 800 元。先别订，只登记。”
- **看到（聊天）**：agent 登记事项并回复事项编号；没提到的信息（出发地、证件等）它会问你，不会编造。
- **看到（Nexus）**：刷新或等几秒，事项列表出现这条事项，状态为进行中；点进详情能看到目标和预算。
- **兜底**：agent 没动手时说“请用 Nexus 的任务工具登记这件事”。

### 第 3 幕：重复登记会被拦住

- **对 agent 说**：“再帮我登记一个一模一样的：10 月 20 日东京订房。”
- **看到**：agent 告诉你已有相近事项，问你是不是同一件事，不会悄悄建第二条。回复“就是同一件，不用新建”。
- **讲**：“它先看了‘进行中的事项’清单，不确定就问你。”

### 第 4 幕：对外动作要先过你这一关（联系供应商，R1）

- **对 agent 说**：“给 Hotelier 酒店发条消息，问 10 月 20 日有没有房。”
- **看到（聊天）**：agent 登记动作后先停下，告诉你需要你同意。聊天里可能弹出审批卡片（以实际界面为准）。
- **看到（Nexus）**：事项出现“1 待决策”；打开决策，看到“是否允许持续为联系供应商自动签发执行凭证”，选项批准 / 拒绝。
- **做**：点“批准”。
- **看到**：决策变成已处理。点批准后 agent 通常在同一轮里接着办（聊天卡片是同步批准的），回复假供应商的确认号（`FAKE-xxxx`），详情页执行记录多一行成功。只有 agent 停下来等你时才回一句“已批准，请继续刚才那个动作（先 authorize 取 executionId 再 commit）”——**不要只说“我批准了，继续”**，太含糊，agent 可能重新建事项。
- **注意**：这一幕只发**一次**。批准的是“持续授权”（该事项里对 Hotelier 的联系供应商动作），之后再发同一类消息**不会再弹决策**，直接成功，这是预期。要再演一次弹卡片，换一个供应商名字或新建事项。
- **兜底**：agent 报 `execution_not_found` 时（它把 actionId 当成了 executionId；2026-10-17 之后的版本会在错误里直接提示先 authorize），对它说“对这个动作调用 nexus_action_authorize 取得 executionId，再 commit”。
- **讲**：“这是演示用的假供应商，什么真实的事都没发生。agent 自己批不了，也绕不过去。”

### 第 5 幕：预订需要二次确认（R2），拒绝是终局

- **对 agent 说**：“帮我订 Park Hotel，10 月 20 日入住。”
- **看到（Nexus）**：待决策出现；这次**必须先勾选二次确认**才能点批准。
- **做 1**：先点“拒绝”。回聊天，agent 说明被拒绝了、没有订，不会换个办法再试，而是问你想怎么办。
- **做 2**：再对 agent 说“那还是订吧”，Nexus 出现新的待决策，勾选后批准；agent 提交，回复成功。
- **讲**：“拒绝不会被绕开；预订和付款比联系供应商多一道确认。”

### 第 6 幕：说“办成了”要有证据

- **对 agent 说**：“订房成功了吗？有凭据吗？”
- **看到（聊天）**：agent 把“订房已执行”登记成一条声明，并把执行回执挂成证据，再告诉你结果；它自己写不了“已证实”，状态由证据推导。
- **看到（Nexus）**：事项详情的声明和证据表里多了对应的行，**每行都有创建时间**；执行回执作为证据出现。
- **再说**：“把这个事项标成完成。” 完成要看账本：声明还没被证据支撑时，agent 的请求会被拒绝，并如实告诉你缺什么，事项状态保持不变；声明已被证据支撑时则可以完成。彩排时先确认这一幕走哪条路，再决定要不要演“被拒绝”。
- **讲**：“‘完成’不是 agent 说了算，是看账本里有没有足够的证据。”

### 第 7 幕：偏好只是默认，不是授权

- **对 agent 说**：“记住：我订酒店偏好靠近地铁。”
- **看到（Nexus）**：待决策里出现一条偏好确认（agent 不能直接替你写“用户明说的偏好”）；批准后“偏好”标签里出现这一项，可以编辑 / 删除。
- **再对 agent 说**：“帮我挑个酒店，按我的偏好。” agent 会读取该偏好；但它仍不能因此自动付款。

### 第 8 幕：请 Nexus 到时回检

- **对 agent 说**：“订好后，30 分钟后帮我看看对方有没有回复。”
- **看到（Nexus）**：事项状态变成“监视中”，详情里有一条回检，带“取消”按钮。
- **做**：点“取消”，回检消失，计划中的定时任务被移除。
- **想看真的触发**：把时间说成“1 分钟后”，等待约 1–3 分钟，会跑一次真实的模型回合，结果是满足 / 未满足 / 受阻；重试次数耗尽仍没满足时，会产生一张“确认知悉”的决策。

### 第 9 幕：页面本身

- **做**：在事项列表设置状态、关键字、创建时间筛选 → 点进一个事项 → 返回。右上切换英文再切回。
- **看到**：返回后筛选保留；列表分页正常；详情页的声明、证据、步骤、决策、执行都带时间；英文界面文案正常。
- **清除回执标签**：第三方安装（没有证据原文存储）下只会是空列表——清除功能本身不可用，这是预期；它不应报错。（2026-10-17 前的打包版本在这里会报 `unknown method: nexus.task.purgeReceipts`，已修复，需重新 `build:dist` + `npm pack` 后重装。）

### 第 10 幕（只在 B-2）：证据原文

- 第三方安装下**跳过**。内置路径下，证据表“原文”列有“查看原文”按钮，点开是只读的文本预览（二进制显示“内容不是文本”）。

## 7. 收尾

```bash
# 环境 A（用过才需要）
# 终端 A：Ctrl+C 停网关
echo "$OPENCLAW_STATE_DIR"                              # 确认是临时目录，不是 ~/.openclaw
rm -rf "$OPENCLAW_STATE_DIR"                            # 可选
unset OPENCLAW_STATE_DIR TOKEN                          # 每个用过的终端都要执行

# 环境 B（装了压缩包的 App；数据在 ~/.openclaw，不会随卸载删除）
openclaw plugins uninstall nexus-agent-core && openclaw gateway restart   # 想还原时
# 或用 §5 开头做的备份恢复
```

## 8. 彩排清单

- [ ] 模型能正常对话（先随便问一句）。
- [ ] 左侧能看到 Nexus；启动日志没有 `before_prompt_build blocked`、没有 `evidence reconcile failed`。
- [ ] 第 2–8 幕各完整走一遍，记下 agent 的真实回复，必要时改兜底话术。
- [ ] 想从干净状态正式演：环境 A 换一个新的临时状态目录重装配置；App 路径没有临时目录，先停网关，把 `~/.openclaw/plugins/nexus-agent-core/` 下的 `nexus.sqlite*` 用 `mv` 挪走（不要 `rm`，以便回退），再启动网关。
- [ ] 窗口布局：聊天和 Nexus 页面并排，字号调大。
