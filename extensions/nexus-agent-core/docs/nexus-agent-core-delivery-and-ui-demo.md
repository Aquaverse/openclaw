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

| 分发模式                      | 用户要做什么（目标） | 今天是否成立                                                                              | 本手册入口       |
| ----------------------------- | -------------------- | ----------------------------------------------------------------------------------------- | ---------------- |
| **OpenClaw.app 内置版**       | 打开 App 就能用      | **构建时加 `OPENCLAW_INSTALLER_NEXUS_PRESET=1` 即成立**（见 2.1）；不加则和以前一样默认关 | §2.1、§5 B-2     |
| **官方目录 / 受信插件安装版** | 安装 + 一次信任确认  | **不成立**：Nexus 还没进官方目录，这条要等上架                                            | §2.2             |
| **本地 `npm-pack:` 压缩包**   | 开发者按步骤配置     | 成立，已在官方 OpenClaw 和 Mac App 上验证                                                 | §2.3、§3、§5 B-1 |

### 2.1 普通用户：OpenClaw.app 内置版

这是“安装后启动即可用”的路径，也是唯一能做到零配置的一条：内置插件不受第三方的限制，不需要 `hooks.allowConversationAccess`，不需要 `customPlugins` 就能在左侧看到 Nexus，证据原文存储也可用。

插件自己的默认值是“关”（所有功能开关 `false`，19 个工具是 optional、要列进 `tools.alsoAllow`），所以由**打包时的开关**在安装后替用户做一次：

```bash
OPENCLAW_INSTALLER_NEXUS_PRESET=1 ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
```

也可以在仓库根的 `installer.env` 里写 `OPENCLAW_INSTALLER_NEXUS_PRESET=1`（环境变量优先）。不设这一项，打出来的 App 和以前一样，Nexus 保持关闭。

打开后，安装后的 App 会（`scripts/mac-nexus-preset.sh`，pkg 安装时先跑一次，之后每次启动 App 检查一次）：

1. 启用 Nexus 插件；
2. 打开功能开关：`tasksEnabled`、`decisionsEnabled`、`claimsEnabled`、`preferencesEnabled`、`watchersEnabled`（想改用 `OPENCLAW_INSTALLER_NEXUS_SWITCHES=a,b,c`；要演“查看原文”再加 `evidenceBlobsEnabled`）；
3. 确保供应商是假的（`fakeProviderMode` = `"ok"`，不会产生任何外部效果）；
4. 把 Nexus 的 19 个工具**追加**到 `tools.alsoAllow`：原来列表里的项全部保留，已有的不重复添加；原列表不是“纯字符串数组”（读不出来、或含非字符串项）时一律不改它，只记日志，并且不写完成标记，下次启动再试；
5. 每一项都先读当前值，已经是目标值就不写；**真的写了配置才重启一次网关**，什么都没改就不重启（所以重复执行、或机器上已手工配好，都不会打断网关）。

之后用户直接打开 App：左侧有 Nexus，聊天里 agent 能用 Nexus 的工具。

**同一条命令里的另外三个一键功能开关**（默认模型、llama 本地后备、LiteLLM 路由），取值 `0` / `1` / 不设，环境变量优先于 `installer.env`。**“不设”不等于“启用”**：它沿用旧的、由配置决定的行为（对应的 `installer.env` 项填了才会开，没填就是关）；只有 `1` 才表示“必须开”，缺配置会让构建失败，只有 `0` 才表示强制关。要“默认就开”，必须在 `installer.env` 里把对应配置填全，或显式传 `1`：

```bash
OPENCLAW_INSTALLER_NEXUS_PRESET=1 \
OPENCLAW_INSTALLER_DEFAULT_MODEL=0 OPENCLAW_INSTALLER_LLAMA=0 OPENCLAW_INSTALLER_LITELLM=0 \
ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
```

| 变量                               | `0`                                                    | `1`                                                                            | 不设                                                        |
| ---------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| `OPENCLAW_INSTALLER_DEFAULT_MODEL` | 不写默认在线模型；App 首次启动由自己的模型选择界面询问 | 必须有 `installer.env` 里的 `DEFAULT_AI_BASE_URL` / `_MODEL`，没有就让构建失败 | 有就写，没有就不写（和以前一样）                            |
| `OPENCLAW_INSTALLER_LLAMA`         | 不打包 llama-server，没有本地后备模型                  | 必须有 `DEFAULT_LLAMA_MODEL`（和 `SKIP_LLAMA_BUNDLE=1` 冲突，会报错）          | 配了模型就打包（和以前一样）                                |
| `OPENCLAW_INSTALLER_LITELLM`       | 不打包 LiteLLM                                         | 打包（需要 `OPENCLAW_LITELLM_VERSION`、`OPENCLAW_UV_VERSION`）                 | 沿用 `installer.env` 的 `OPENCLAW_INSTALLER_ENABLE_LITELLM` |

这三个开关**不影响**网关和安装流程：pkg 的 postinstall 照常静默装好网关的 LaunchAgent 并跳过交互式 onboarding，只是不再带模型相关的配置。LiteLLM 的混合路由要“llama 后备 + 在线默认模型”都在才会生效，只开 LiteLLM 而关了其中一个，构建时会给出警告。

几点说明：

- **每个预设版本只执行一次。** 脚本在 `~/.openclaw/.nexus-preset-applied` 记下版本；用户之后自己关掉某个开关、从允许列表里去掉某个工具，不会在下次启动时被改回。想让已装机器重新应用，要升 `scripts/build-mac-installer.sh` 里的 `NEXUS_PRESET_VERSION`。本机重测时删掉这个标记文件再启动 App 即可（删文件由你自己执行）。
- **日志**：`~/Library/Logs/OpenClaw/nexus-preset.log`，每一步和是否改了 `alsoAllow` 都有记录。
- **只对内置了 Nexus 的 App 有效。** 没有内置 Nexus 的 App（官方发行版）上 `plugins enable` 会失败，脚本记一条警告就退出，不影响别的。压缩包安装走 §2.3，不受这个开关影响。
- **假供应商仍是唯一的供应商。** 这个预设不改变“演示 / 开发版”的性质；接入真实供应商前不要把它当正式版默认值。

### 2.2 官方目录 / 受信插件安装版

目标体验是“一次安装、一次确认”。这条路径取决于 OpenClaw 官方把 Nexus 收进外部目录（并且来源信息匹配）：只有这样宿主才会把 `openBlobStore` 等受限接口授予它，也才有官方的信任确认界面。这两件事都在宿主一侧，我们不能（也不应该）在插件里绕过。

在 Nexus 上架之前，本节没有可演示的内容，不要承诺给用户。分发形式的选择（内置 / 官方目录 / 第三方 npm 或 ClawHub）仍是待定项，它同时决定证据字节要不要改存 SQLite。

### 2.3 本地 `npm-pack:`：开发 / 验收路径

本地压缩包路径不是零配置用户路径。它用于开发者验证、演示和回归，包含插件信任、工具 allowlist、阶段开关、日志检查以及环境 A/B。先完成 §3 的交付物检查，再按 §3.1–§3.3 配置；完成后演示部分从 §6 开始。每次卸载 / 重装后都要重做配置（见 §3 交付检查表的“卸载”一行）。

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

**B-2：你 fork 打的 App（Nexus 是内置的）** —— 这个 App 里装压缩包会被内置版覆盖（日志 `duplicate plugin id ... bundled plugin`），所以跳过 §3.1，只做 §3.2 里的功能开关、`fakeProviderMode` 和 `tools.alsoAllow`（`customPlugins` 和 `hooks.allowConversationAccess` 可省，内置插件不需要），再做 §3.3。**如果这个 App 是用 `OPENCLAW_INSTALLER_NEXUS_PRESET=1` 打的（§2.1），§3.2 也不用做**，直接看 `~/Library/Logs/OpenClaw/nexus-preset.log` 确认预设已应用，再做 §3.3 的自检。这条路径是“内置分发”的演示，证据原文存储可用，可以额外演“查看原文”（需要先用探针脚本或 RPC 上传一份证据，页面本身没有上传按钮）。

## 6. 演示脚本（全程在界面里）

**布置**：浏览器开两个标签，一个是 OpenClaw 聊天，一个是 Nexus 页面（左侧 Nexus）。Nexus 页面开始是空的。事项列表按“最近更新在前”排序，发生变化的事项会跳到最前，属于正常。

**从干净状态开始。** 第 2–4 幕都围绕“东京订房”，如果事项列表里已经有几条东京的事项（彩排留下的），agent 在第 4 幕会拿搜索结果里相似度最高的那条去挂动作，可能挂错事项。正式演示前按 §8 的清理步骤清空，或至少每幕开始前在聊天里报出事项编号（“针对 TXXXXXXXX 这个事项……”）。

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

- **对 agent 说**：“再帮我登记一个一模一样的：10 月 20 日东京订房。”（日期要和第 2 幕一致。）
- **看到（聊天）**：agent 告诉你已有相近事项（给出编号），问你是不是同一件事，**先问再做**。回复“就是同一件，不用新建”。
- **看到（Nexus）**：事项列表没有多出第二条。这是服务端保证的：agent 登记时拿到 `created:false` 和一个覆盖令牌，没有令牌的重试一律建不出重复事项。
- **兜底**：agent 没问就说“我会按你的确认继续创建”，但列表里并没有新事项——这是它把“再登记一个一样的”当成了确认。对它说“先别创建，这和刚才那条是同一件事吗？”。想演“确实要新建”，就回复“这是另一件事（日期不同）”，agent 才会用令牌重试，列表里多一条。
- **讲**：“它先看了‘进行中的事项’清单，不确定就问你；即使它不问，服务端也不会让重复事项悄悄进来。”

### 第 4 幕：对外动作要先过你这一关（联系供应商，R1）

- **对 agent 说**：“给 Hotelier 酒店发条消息，问 10 月 20 日有没有房。”
- **看到（聊天）**：agent 登记动作后先停下，告诉你需要你同意。聊天里可能弹出审批卡片（以实际界面为准）。工具调用列表里会有一条红色的 **Nexus Action Authorize 失败（`no_policy`）**，这是**预期**：它在说“还没有持续授权”，随后 agent 才发起决策。批准之后会再出现一次成功的 Authorize 和 Commit。
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
