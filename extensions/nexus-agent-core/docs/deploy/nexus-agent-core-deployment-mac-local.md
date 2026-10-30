# Nexus 单机部署方案：装在自己的 Mac 上（单用户，本机 / 局域网）

> 状态：设计草案 v0.1（2026-10-29），**尚未在你的 Mac 上逐条跑过**。凡标 **【待验证 Mn】** 的，是按 OpenClaw 文档推断、没有实机确认的点，统一列在第 15 章。
>
> 范围：**只给自己用的单用户**；服务跑在你自己的 Mac 上；**只做本机和局域网访问，不暴露外网**（第 14 章只给"以后要外网怎么办"的方向）。
>
> 命令依据：本机仓库 `docs/` 下的 OpenClaw 文档（仓库 `package.json` 仍是 2026.9.4，文档已随同步更新到更新的版本）。**个别命令在你装的版本里可能还不存在或参数不同，以 `openclaw <命令> --help` 为准**（见 M1）。
>
> 相关文档：多用户 Linux 版见 [nexus-agent-core-deployment-plan.md](./nexus-agent-core-deployment-plan.md)；Nexus 本身的安装开关见插件 [README](../../README.md)。

---

## 0. 一页纸摘要

| 项            | 做法                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态          | 一个用户 = 一台 Mac。**不需要** portal、Docker、nginx、邀请码、域名、证书                                                                                       |
| 运行方式      | `OpenClaw.app`（打包安装）+ 它安装的**每用户 launchd 服务** `ai.openclaw.gateway`，网关监听 `127.0.0.1:18789`；退出 App 不会停网关                              |
| Nexus         | 打包时带预设（`OPENCLAW_INSTALLER_NEXUS_PRESET=1`），首次启动自动启用插件、打开开关、固定模拟提供商、放行工具                                                   |
| 访问          | ① 本机：Mac App 或 `openclaw dashboard` 打开的网页控制台；② 局域网（可选）：`gateway.bind=lan` + token，手机/平板/另一台 Mac 访问 `http://<主机名>.local:18789` |
| Telegram      | 自己建 bot，`openclaw channels add --channel telegram --token …`，长轮询（只出站、不需要入站端口），私聊配对                                                    |
| WhatsApp      | `openclaw channels login --channel whatsapp` 扫码（关联设备，非官方协议）；推荐专用号码，也支持"给自己发消息"的自聊模式                                         |
| 保持在线      | 关键风险：**Mac 休眠 = 助手离线**。要设置接电不休眠、处理合盖、重启后登录（第 5 章）                                                                            |
| 通道风险      | 两个通道的连接速查、16 条风险和处置手册见**第 16 章**                                                                                                           |
| 备份          | `openclaw backup create --verify` 或停网关后打包 `~/.openclaw`（第 11 章）                                                                                      |
| 与 PRD 的差距 | PRD（BR-01）要求 Agent 跑在专用机器上、不是个人电脑；**本方案是自用 / 开发验收形态**，不满足该条（第 1 章）                                                     |

---

## 1. 与服务器版、与 PRD 的关系

### 1.1 为什么能简化这么多

服务器版要解决"多个陌生用户共用一台机器"的隔离、开通、路由、计量。单人自用都不存在：没有租户、没有邀请码、没有对公网的入口。所以 Mac 自用 = **官方 Mac 应用的标准用法 + Nexus 预设 + 两个聊天通道的配置 + 常驻与备份的运维约定**。

### 1.2 与 PRD 的偏差（需要认账）

| PRD 条款                                                         | 本方案                      | 说明                                                          |
| ---------------------------------------------------------------- | --------------------------- | ------------------------------------------------------------- |
| BR-01 浏览器与 Agent 主机是专用机器，**不是用户个人电脑**        | **不满足**                  | Agent 和它的浏览器就跑在你的个人 Mac 上                       |
| BR-02 登录 / MFA / 验证码由用户在受保护的 Agent 浏览器会话里接手 | 满足，且更直接              | 受管浏览器窗口就在你的屏幕上，也可在控制台 Browser 面板里操作 |
| BR-03 用户离开不会停止 Agent 主机                                | **取决于 Mac 是否一直开着** | 第 5 章                                                       |
| CH-01~04 Telegram、WhatsApp 为 P0                                | 满足（模拟提供商前提下）    | 第 8、9 章                                                    |
| §4.3 IM 只是命令/交付入口，不是执行主机                          | 满足                        | 执行在这台 Mac 的网关里                                       |

另一个必须说清的差别：**服务器版里 Agent 被关在容器里；这里 Agent 以你的 macOS 用户身份运行**，它的 shell 类工具能碰到你这个用户能碰到的一切（文稿、钥匙串之外的个人文件、浏览器登录态等）。Nexus 文件柜的"敏感文件"只保证不经 `nexus_file_*` 工具提供，**挡不住 shell 工具读取状态目录**（已实测，插件 README §2.5 / §4.4）。因此强烈建议第 13 章的"专用 macOS 用户"做法。

---

## 2. 架构

```
你的 Mac（macOS 15+）
┌───────────────────────────────────────────────────────────────────┐
│  OpenClaw.app（菜单栏，Connection / 控制台入口，可随时退出）            │
│        │  WebSocket                                                  │
│        ▼                                                            │
│  launchd 服务  ai.openclaw.gateway   ──► ~/Library/Logs/openclaw/gateway.log
│  127.0.0.1:18789（默认 loopback；局域网访问时改为 lan）                 │
│   ├─ Nexus 插件（内置）  → ~/.openclaw/plugins/nexus-agent-core/        │
│   │        nexus.sqlite、vault/（文件柜）                               │
│   ├─ 受管浏览器（独立的 "openclaw" Chrome/Chromium 配置，非你的日常浏览器）  │
│   ├─ Telegram 通道（长轮询，仅出站） ───────────────► api.telegram.org    │
│   └─ WhatsApp 通道（Baileys 关联设备） ─────────────► WhatsApp 服务器      │
│  状态目录 ~/.openclaw/（openclaw.json、会话、凭据、工作区…）                │
└───────────────────────────────────────────────────────────────────┘
        ▲ 局域网（可选）：手机 / 平板 / 另一台 Mac  http://<主机名>.local:18789
```

要点：

- 网关由 **launchd** 管：开机登录后自启、崩溃自动拉起、退出 App 不影响。
- Telegram 长轮询、WhatsApp 关联设备都是**由 Mac 主动连出去**，家里路由器不需要做任何端口映射。
- 默认只监听本机，**不改配置就不会被局域网其他设备访问到**。

---

## 3. 前置条件

| 项                   | 要求                                                                                                                                                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 系统                 | macOS 15 或更高（2026.10.4 起的 Mac App 要求）                                                                                                                                                                                                                                  |
| 构建（仅自己打包时） | 仓库根目录、`pnpm`、Xcode 命令行工具；本地构建**必须**带 `ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1`（见 4.1）                                                                                                                                                              |
| 网络                 | 能访问：模型供应商、`api.telegram.org`、WhatsApp 服务器、你要让助手浏览的网站。若所在网络访问不了 Telegram / WhatsApp，需要另配出站代理——WhatsApp 通道认宿主机的标准代理环境变量（`HTTPS_PROXY` 等），但 launchd 服务**不继承终端的环境变量**，需要写进服务环境后重启网关（M3） |
| 磁盘                 | 状态目录放**本地非同步盘**（不要 iCloud 云盘、Dropbox 等），否则同步延迟和文件锁会影响会话和网关状态；`openclaw doctor` 会对常见同步路径告警                                                                                                                                    |
| 电源                 | 台式 Mac / Mac mini / 长期接电的 MacBook；最好有 UPS                                                                                                                                                                                                                            |
| 磁盘加密             | 建议开 FileVault：状态目录里有 token、bot token、WhatsApp 会话、文件柜原文和对话记录（明文）                                                                                                                                                                                    |

---

## 4. 安装

### 4.1 方式一（推荐）：打包 `OpenClaw.app`，带 Nexus 预设

这是插件 README 的主路径。**本地构建务必带 `ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1`**：不带时是"正式编译 + 正式签名"，没有 Apple 签名身份会直接报 `No signing identity found`，且部分 Xcode 工具链编不过 MLX 的 Metal 着色器。

```bash
cd /Users/apple/workSpace/abcIM/ai/openclaw

# 自用推荐：内置 Nexus，不打包默认模型 / 本地模型 / 路由器（模型密钥不进安装包）
OPENCLAW_INSTALLER_NEXUS_PRESET=1 \
OPENCLAW_INSTALLER_DEFAULT_MODEL=0 OPENCLAW_INSTALLER_LLAMA=0 OPENCLAW_INSTALLER_LITELLM=0 \
ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
```

- 产物：`dist/OpenClaw.app`、`dist/OpenClaw-<version>-Install.dmg`。
- `OPENCLAW_INSTALLER_NEXUS_SWITCHES` 不写时默认打开：`tasksEnabled, decisionsEnabled, claimsEnabled, preferencesEnabled, watchersEnabled, vaultEnabled, evidenceBlobsEnabled`。**目标（`goalsEnabled`）不在默认列表里**，要用就写进开关列表，或装好后手动 `config set`（4.4）。
- 临时签名的代价：别的 Mac 首次打开会提示"无法验证开发者"（右键 → 打开一次）；**每次重新构建后，系统权限（TCC）授权不保留**，需要重新授权（屏幕录制、辅助功能等，见 `platforms/mac/permissions`）。
- 想带默认在线模型 / llama.cpp 兜底 / LiteLLM 路由时才打开对应开关；`installer.env` 里的模型地址和 key 会**明文**打进安装包，自用也别把这个 dmg 发给别人。
- 想先看是否已装过：已装过的机器**预设只在每个预设版本应用一次**（标记文件 `~/.openclaw/.nexus-preset-applied`），重新打包不会改变已有配置，见 4.4 和 10.2。

### 4.2 首次启动

1. 把 `OpenClaw.app` 拖进"应用程序"并打开（临时签名的包：右键 → 打开）。
2. 首次启动选 **This Mac（本机）**。App 会运行内置的安装脚本：在 `~/.openclaw` 下装一份用户态 Node 和与 App 匹配的 `openclaw` 命令行，再安装并启动 launchd 服务——**不需要终端、Homebrew 或管理员权限**，但需要联网下载运行时。
3. 失败时点 **Retry setup**；仍失败就手动安装 CLI（文档要求 Node 24.16+ 或 26.1+）：`npm install -g openclaw@<版本> --allow-scripts=openclaw`，然后在引导里点 **Check again**。
4. 按 App 的"选择模型"界面配置模型（key 只留在 `~/.openclaw`，不进安装包）。
5. 首次启动时预设脚本自动运行（日志 `~/Library/Logs/OpenClaw/nexus-preset.log`），有变化时会重启网关一次。

之后 shell 里使用的命令行路径：`~/.openclaw/bin/openclaw`（下文简写为 `openclaw`，可把 `~/.openclaw/bin` 加进 `PATH`）。

### 4.3 安装后验证（逐条过）

```bash
openclaw --version
openclaw gateway status --deep          # launchd 服务在跑、端口 18789、监听 loopback
openclaw health                         # 网关健康
openclaw plugins list | grep -i nexus   # nexus-agent-core 已启用，来源是内置而不是 npm-pack
openclaw config get plugins.entries.nexus-agent-core.config.tasksEnabled   # true
openclaw logs 2>&1 | grep -i -E "nexus|blocked|duplicate|error" | tail -n 40
```

期望：日志里有 `nexus-agent-core register: mode=full … tasksEnabled=true decisionsEnabled=true claimsEnabled=true`、`watcher hooks registered`；**没有** `before_prompt_build blocked`、`evidence reconcile failed`。然后在 App 左侧能看到 **Nexus**，创建一个事项并读回、上传一个文件到文件柜并搜索到。

### 4.4 已装机器上补开关 / 不想重装

预设不会重复应用，所以对已装机器手动改（`tools.alsoAllow` 是**整体替换**，先 `config get` 再合并；这里是 29 个工具的完整清单，来自插件 README）：

```bash
P=plugins.entries.nexus-agent-core
openclaw config set $P.config.goalsEnabled true        # 例如补上"目标"

openclaw config get tools.alsoAllow                     # 先看现有项
openclaw config set tools.alsoAllow '[
  "nexus_task_reserve","nexus_task_create","nexus_task_get","nexus_task_update","nexus_task_note","nexus_task_search",
  "nexus_action_prepare","nexus_action_authorize","nexus_decision_request","nexus_action_commit",
  "nexus_claim_add","nexus_evidence_add","nexus_claim_verify",
  "nexus_preference_get","nexus_preference_set","nexus_preference_confirm",
  "nexus_watch_create","nexus_watch_cancel","nexus_watch_report",
  "nexus_file_search","nexus_file_get","nexus_file_attach",
  "nexus_goal_search","nexus_goal_get","nexus_goal_create","nexus_goal_propose",
  "nexus_goal_entry_add","nexus_goal_link","nexus_goal_review"
]' --strict-json
```

`tools.alsoAllow` 热更新；插件配置改动需要 `openclaw gateway restart`（**用 `restart`，不要拆成 `stop` + `start`**）。

### 4.5 提醒：提供商仍是模拟的

Nexus 的"外部动作"（发消息、预订、付款）目前全部走 fake provider，只在本地记账，不会真的联系任何供应商，也不花钱。预设固定 `fakeProviderMode="ok"`。通过 Telegram / WhatsApp 看到"已提交"时，不要理解为现实世界已经发生。

---

## 5. 让它一直在线（Mac 自用最容易翻车的地方）

助手靠这台 Mac 的网关进程运行。Mac 睡了：网关被冻结，Telegram / WhatsApp 不收消息，Nexus 的回检（Watcher）和定时任务不执行。

### 5.1 机制与已知行为

- **launchd 服务**：开机登录后自启、崩溃自动重启；退出 App 不影响。**它是"用户级"LaunchAgent，需要该用户已登录桌面会话才会运行**——开了 FileVault 的机器断电重启后，要先在登录窗口输入密码，网关才会起来（M5）。
- **休眠唤醒**：网关醒来后约 30 秒内检测到进程被冻结，会在手头工作空闲时重连各通道并刷新健康状态；Telegram 会把睡眠期间的未读更新保留一段时间（Bot API 的行为，约 24 小时）；WhatsApp 离线消息在重连时可能被投递，网关对此有去重保护。**这是"追补"，不是"持续在线"**：睡着时的回检不会准点跑。
- 想要 BR-03 的"用户离开不停止"，就必须让 Mac 不休眠。

### 5.2 建议设置

```bash
pmset -g                                # 看当前电源设置
sudo pmset -c sleep 0                   # 接电时系统永不休眠（显示器照常关，省电）
sudo pmset -c displaysleep 10           # 显示器 10 分钟后关
sudo pmset -a womp 1                    # 网络唤醒（可选）
# MacBook 合盖也不休眠（会发热，务必保证通风；或接外接显示器 + 键鼠走"合盖模式"）：
sudo pmset -a disablesleep 1            # 【待验证 M4：不同机型/系统表现不同；用完 `disablesleep 0` 还原】
```

图形界面里对应：系统设置 → 电池 / 能源 → "显示器关闭时防止自动进入睡眠"（接电源适配器时）。其他：

- 系统设置里关闭"自动安装 macOS 更新后重启"，或在你可控的时间窗口更新；更新后确认第 4.3 节的验证命令。
- 想让断电恢复后自动开机：台式 Mac / Mac mini 在"节能 → 断电后自动启动"里打开。
- 自动登录与 FileVault 不能同时开启（macOS 限制）；要"断电自恢复"就得在两者间取舍。用 UPS 比关 FileVault 更稳妥。
- 不要退出你的 macOS 用户登录（用"快速用户切换"切走是可以的：该用户的后台 LaunchAgent 仍在运行，见 13.2）。

### 5.3 自检

```bash
openclaw gateway status --deep         # 重启 / 唤醒后确认服务在
openclaw channels status --probe       # 两个通道都在线
```

菜单栏图标：休眠姿态表示网关断开或未配置；健康行橙色 = 有失败原因，红色 = 需要重新登录通道。

---

## 6. 本机访问

### 6.1 Mac App

安装后默认就是连本机网关，左侧导航里有 Nexus、事项、决策、文件、目标等页面。菜单栏 → **Connection…** 可看本机网关健康行（状态点、通道摘要，带 **Retry now** / **Open logs**）。

### 6.2 浏览器里的网页控制台

```bash
openclaw dashboard              # 打开控制台，带一次性所有者配对链接
openclaw dashboard --no-open    # 只打印链接
```

一次性配对链接成功后，这个浏览器会获得长期的管理员设备凭据，之后重开不再依赖共享 token。**不要把配对链接发给别人。**

### 6.3 网关 token

命令行直连、探针脚本、其他设备手动登录时需要：

```bash
openclaw config get gateway.auth.token
```

token 等同于整台助手的钥匙：不要贴进聊天、issue、日志或截图。怀疑泄露就换：`openclaw config set gateway.auth.token "$(openssl rand -hex 24)"`，再 `openclaw gateway restart`，所有已连接设备要重新登录。

---

## 7. 局域网访问（可选）

默认网关只监听本机。要从手机、平板或同一网络的另一台电脑访问：

```bash
openclaw config get gateway.auth.mode      # 必须是 token 或 password；非 loopback 绑定必须有认证
openclaw config set gateway.bind lan
openclaw gateway restart
openclaw gateway status --deep             # 确认监听的是局域网接口
```

- 首次监听局域网接口时，macOS 可能弹窗"是否允许接受传入连接"，选允许；如果你开了 macOS 防火墙，需要放行 `node`/OpenClaw 的入站。
- 访问地址：`http://<Mac 主机名>.local:18789/`（或 `http://<局域网 IP>:18789/`）。局域网私有地址、`.local`、链路本地、CGNAT 和 `.ts.net` 主机的同源页面加载**不需要**写 `gateway.controlUi.allowedOrigins`；用其他类型的域名 / HTTPS 代理才需要。
- 其他设备第一次连接可能出现"等待批准"：在本机已登录的控制台里批准，或命令行：

```bash
openclaw devices list
openclaw devices approve <请求 id>        # 命令名与参数以 `openclaw devices --help` 为准（M7）
```

- **另一台 Mac 的 App** 想连这台：Connection → Gateways → Add Gateway，地址填 `ws://<主机名>.local:18789`，认证选 Token。文档允许对私有 / `.local` 地址使用明文 `ws://`；公网地址必须 `wss://`。
- **手机上传文件到 Nexus 文件柜**：分块上传入口是 `http://<主机名>.local:18789/plugins/nexus-agent-core/vault-upload`，用网关 token 认证，需要 `operator.write`；手机和 Mac 要在同一网络（或同一 VPN）。

**局域网访问的风险**（务必知道）：

- 走的是**明文 HTTP**：token 和页面内容在局域网里没有加密。只在你信任的家庭 / 办公网使用，**不要在咖啡店、酒店、访客 Wi-Fi 里打开 `bind=lan`**；出门前改回 `openclaw config set gateway.bind loopback && openclaw gateway restart`。
- **绝不要**在路由器上把 18789 做端口映射到公网。
- 局域网里能连到端口的人只要拿到 token 就是完整 operator。路由器上给这台 Mac 做固定 IP / 预留地址，便于以后加防火墙规则。

---

## 8. Telegram

**前提**：自己在 Telegram 里创建一个 bot（平台无法代办）。Telegram 通道默认**长轮询**：只需要这台 Mac 能**出站**访问 `api.telegram.org`，家里路由器不用做任何设置；不需要 webhook。

1. 在 Telegram 里找 `@BotFather`（核对用户名恰好是 `@BotFather`）→ `/newbot` → 起名，拿到 bot token（也可以用 BotFather 的网页版 `t.me/BotFather?startapp`）。
2. 配置：

   ```bash
   openclaw channels add --channel telegram --token <bot-token>
   ```

   这会把 token 写进 `~/.openclaw/openclaw.json`；Telegram 的默认私聊策略就是 `pairing`。**不要把 token 贴进聊天或截图。**也可手写配置：`channels.telegram.{enabled:true, botToken:"…", dmPolicy:"pairing"}`。注意 Telegram 通道**不使用** `openclaw channels login telegram`。

3. 验证（默认热加载，网关会自己应用；离线就 `openclaw gateway start`）：

   ```bash
   openclaw channels status --probe
   ```

4. 在 Telegram 里给你的 bot 发任意一句话，它会创建配对请求并回复配对码：

   ```bash
   openclaw pairing list telegram
   openclaw pairing approve telegram <CODE>        # 配对码 1 小时过期
   ```

   也可在控制台 Settings → Channels → DM access requests 里批准。配对批准之后，这个 Telegram 账号才算你；别人给 bot 发消息只会得到配对码，不会被执行。

5. 再发一句话，助手应当回复。
6. 建议再做两件事：把 `channels.telegram.allowFrom` 收紧为你自己的 Telegram 用户 ID（查法见 Telegram access-control 文档的 “Finding your Telegram user ID”）；在 BotFather 里用 `/setjoingroups` 关掉拉群，减少暴露面。

**说明**

- 需要审批时可能带内联按钮；按 PRD CH-03，载荷不能安全绑定时会回落为"需登录的网页决策链接"——局域网内就是第 7 章的控制台地址，所以**出门在外只用 Telegram 时，无法点开这个链接**（除非走第 14 章的方式）。
- 排障：`openclaw channels status --probe`、`openclaw logs --follow`；启动报 unauthorized token = token 错了或被 `/revoke` 过；轮询不稳定多半是出站网络问题。
- 换 token / 解绑：重新 `channels add`，并在 BotFather 里 `/revoke` 旧 token。
- 风险与应急见第 16 章。

---

## 9. WhatsApp

**事实**：OpenClaw 的 WhatsApp 通道走 Baileys（WhatsApp Web **关联设备**协议），没有官方 Business API 或 Twilio 通道；登录只能扫二维码。这是非官方接入，**号码有被 WhatsApp 限制的可能**；家庭宽带 IP 通常比机房 IP 更不容易触发风控，但这只是经验判断，没有官方保证（M6）。不要用它做群发或联系陌生人。

### 9.1 两种用法

|          | 专用号码（推荐）                                                   | 个人号码自聊                                                            |
| -------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| 做法     | 副号 / eSIM 登录到一部手机，用它关联；你用自己的主号给它发消息     | 用自己的号码关联，给"自己"发消息                                        |
| 配置基线 | `dmPolicy: "pairing"` 或 `"allowlist"` + `allowFrom:["+你的主号"]` | `dmPolicy:"allowlist"`、`allowFrom` 含你自己的号码、`selfChatMode:true` |
| 优点     | 边界清晰、不会和自聊混淆、号码受限不影响主号                       | 不需要第二个号码                                                        |
| 缺点     | 需要一个号码                                                       | 号码被限制直接影响主号；自己给自己发的探测消息也可能变成 Agent 输入     |

### 9.2 步骤

```bash
# 1) 配置访问策略（以专用号码为例；把号码换成你自己的 E.164 号码）
openclaw config set channels.whatsapp.dmPolicy '"allowlist"' --strict-json
openclaw config set channels.whatsapp.allowFrom '["+8613800000000"]' --strict-json

# 2) 关联：命令行会渲染二维码，用手机 WhatsApp 扫
openclaw channels login --channel whatsapp
```

- 首次选择 WhatsApp 时，`openclaw channels add --channel whatsapp` 或 `channels login` 会提示安装 WhatsApp 插件；也可手动 `openclaw plugins install @openclaw/whatsapp`（这是外部插件，需要联网）。
- 手机上：**WhatsApp → 设置 → 已关联设备 → 关联设备**，扫终端里的二维码。二维码会过期，过期就重新执行登录命令。本机终端就在你面前，所以扫码很简单（服务器版里最麻烦的"把二维码送到手机"在这里不是问题）。
- 在 App 里也可以做：Dashboard → Settings → **Channels** 有登录二维码、登出、探测、最近断线 / 错误（M6：以你装的版本为准）。
- 用 `pairing` 策略时：你的个人号码给这个号码发消息，收到配对码，然后

  ```bash
  openclaw pairing list whatsapp
  openclaw pairing approve whatsapp <CODE>      # 1 小时过期；每个账号最多 3 个待处理
  ```

- 验证：`openclaw channels status --probe`，再发一句话看回复。

### 9.3 运行与风险

- 登录态保存在状态目录（`~/.openclaw` 下的 WhatsApp 认证目录）。丢了就必须重新扫码，所以**备份要包含它**（第 11 章），且备份文件是敏感数据。
- 掉线的常见原因：手机上手动退出了关联设备、号码被限制、长期不联网。处理：重新 `channels login`。
- 出站必须有活动的 WhatsApp 监听，否则发送会立即失败（网关睡眠期间同理）。
- 实验功能 `whatsapp_call`（MeowCaller 语音通话）默认关闭，本方案不用。
- 风险登记与应急见第 16 章。

---

## 10. Agent 浏览器与"用户接手"

### 10.1 浏览器是什么

OpenClaw 在本机起一个**专用的 Chrome/Brave/Edge/Chromium 配置**（配置名 `openclaw`），由网关里的本地控制服务驱动，与你日常的浏览器**数据隔离**（不碰你的个人 profile）。Agent 在里面开标签、读页面、点击、输入。

- **有头 / 无头**：由 `browser.headless`（全局或按 profile）、环境变量 `OPENCLAW_BROWSER_HEADLESS=0|1` 决定；`openclaw browser start --headless` 是单次无头启动。用 launchd 服务跑时，是否显示窗口取决于你的登录会话——**自用想亲自接手，用有头（headless=false）**（M8）。
- **内置的 `user` profile 会附着到你真实的、已登录的 Chrome 会话**（通过 Chrome DevTools MCP）。这很强大也很危险：Agent 能操作你所有已登录的账号。**默认不要启用**；自用最好只用隔离的 `openclaw` 配置。
- macOS 上可以显式把系统 Chrome 的指定 cookies 复制到受管 profile（只复制所选 cookies，不含 localStorage / IndexedDB），见 `openclaw browser` 的导入命令。慎用。

### 10.2 登录 / MFA / 验证码的接手（BR-02）

- 最直接：Agent 卡在登录页时，你在屏幕上看到的 `openclaw` 浏览器窗口里自己输入、完成验证，然后回到对话告诉助手继续。
- 或者在网页控制台的 **Browser 面板**里操作同一个浏览器（可键入、粘贴；需要有 `operator.admin` 的连接）。
- 登录态保存在受管 profile 目录里，**属于备份的敏感内容**。

### 10.3 权限

Mac App 需要的系统权限（屏幕录制、辅助功能、自动化等）见 `platforms/mac/permissions`。**临时签名构建每次重装后授权不保留**，所以自用想稳定，要么固定一个构建不频繁重装，要么用真实开发者签名（设置 `SIGN_IDENTITY`，对外分发再加 `NOTARIZE=1`）。

---

## 11. 备份与恢复

状态目录 `~/.openclaw` 里有：配置、token、bot token、WhatsApp 会话、对话记录（**2026.10.10 起 secrets 在记录里不再遮盖**）、Nexus 数据库与文件柜原文、受管浏览器登录态。它是这套系统最敏感的数据。

### 11.1 推荐：内置备份命令

```bash
openclaw backup create --dry-run --json          # 先看会包含哪些路径，确认含 plugins/nexus-agent-core（M2）
openclaw backup create --output ~/Backups --verify
openclaw backup verify ~/Backups/<归档文件>.tar.gz
openclaw backup enable --repository ~/Backups/openclaw-git --every 24h   # 可选：定期把数据库备份进你自己的 Git 仓库（私有、加密盘上）
```

归档包含配置、授权、通道凭据、会话，默认含工作区；**归档里有敏感内容，放在加密卷上**（FileVault 之外，可用加密磁盘映像），不要放云盘。

### 11.2 兜底：停网关后整目录打包

```bash
openclaw gateway stop            # macOS 上用 launchctl bootout，不会持久禁用自启
tar --zstd -cf ~/Backups/openclaw-$(date +%F).tar.zst -C ~ .openclaw
openclaw gateway start
```

停网关是为了让 SQLite 和 WhatsApp 凭据处于一致状态。Time Machine 也能备份该目录，但它**不替代**定期的、验证过的归档；并且 Time Machine 的备份盘要加密。

### 11.3 恢复

```bash
openclaw gateway stop
mv ~/.openclaw ~/.openclaw.broken-$(date +%F)
openclaw backup restore ~/Backups/<归档文件>.tar.gz --target ~/restored-openclaw    # 先恢复到临时目录检查
# 确认无误后，用恢复出的内容替换 ~/.openclaw，再：
openclaw gateway start
openclaw channels status --probe          # WhatsApp 登录态可能已失效，需要重新扫码
```

**建议每月做一次恢复演练**，否则备份等于没有。注意：整目录回滚时，已永久清除的文件和回执会一起"复活"（插件 README §4.6）；状态目录不要放进云同步。

---

## 12. 日常运维

### 12.1 命令速查

```bash
openclaw gateway status --deep          # 服务与监听
openclaw gateway restart                # 重启（不要 stop + start 代替）
openclaw health
openclaw channels status --probe        # Telegram / WhatsApp
openclaw logs --follow
openclaw doctor                         # 体检；加 --fix 会修复，且只清理能确认的游离 launchd 任务
tail -n 200 ~/Library/Logs/openclaw/gateway.log
tail -n 50  ~/Library/Logs/OpenClaw/nexus-preset.log
```

### 12.2 升级

1. 先备份（11.1）。
2. 用新的源码重新 `pnpm mac:installer`（同样带 `ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1`），安装新 App。
3. 预设**不会重跑**：新增的开关或工具要按 4.4 手动补；或把 `scripts/build-mac-installer.sh` 里的 `NEXUS_PRESET_VERSION` 加一再打包（预设只增不改，不会覆盖你手动关掉的开关）。
4. 重装后按 4.3 验证；数据库向前迁移，回退旧版前先确认新库旧版能否读（先备份、遇到"数据库版本更新"警告就不要硬回退）。
5. 临时签名构建：重新授权系统权限（10.3）。

### 12.3 卸载 / 重置

Nexus 插件卸载或重装会**重置插件自己的配置**（开关回到 false、`hooks` 授权丢失），数据在 `~/.openclaw/plugins/nexus-agent-core/`，不会随卸载删除。完整清理前先备份。开发验证时可用独立状态目录 `OPENCLAW_STATE_DIR=<临时目录>` 隔离，不碰正式的 `~/.openclaw`。

---

## 13. 安全

### 13.1 威胁与对策

| 威胁                                | 对策                                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------- |
| 局域网内其他设备                    | 默认 `loopback`；开 `lan` 时必须 token / password；只在可信网络开；路由器不做公网映射               |
| token / bot token 泄露              | 不贴聊天 / 截图 / issue；怀疑泄露立即轮换（6.3）、`/revoke`（第 8 章）                              |
| Agent 的 shell 能读你的文件         | 用专用 macOS 用户（13.2）；不要启用 `user` 浏览器 profile；按 OpenClaw 安全文档收紧 exec / 工具策略 |
| 提示注入（网页内容诱导 Agent 做事） | Nexus 的决策 / 授权机制是产品层防线；部署层不替代它。重要动作保持"需用户批准"                       |
| 备份泄露                            | 加密卷；不上云盘；不入公共仓库                                                                      |
| 状态目录明文                        | FileVault；本机账户密码；锁屏                                                                       |
| WhatsApp 号码被限制                 | 专用号码；低频；不群发（第 9 章）。通道专项风险汇总见第 16 章                                       |

### 13.2 强烈建议：给助手一个专用 macOS 用户

做法：在"系统设置 → 用户与群组"新建一个**标准用户**（例如 `nexus`），把 OpenClaw.app、launchd 服务、`~/.openclaw`、受管浏览器全都装在这个用户下，你的主账号只通过局域网 / `localhost` 之外的方式（浏览器、Mac App 的 Add Gateway、Telegram）去访问它。

好处：Agent 的 shell 只能碰到 `nexus` 用户的文件，碰不到你主账号的文稿、桌面、浏览器登录态。

代价与注意：

- 需要保持 `nexus` 用户的桌面会话——用"快速用户切换"切回你的主账号，`nexus` 的 LaunchAgent 仍在后台运行（M5：要实测切换后网关与受管浏览器是否照常工作，尤其有头浏览器）。
- 主账号用 Mac App 连接 `nexus` 账号的网关，需要 `gateway.bind lan`（或同机 loopback 端口，视 Mac App 是否允许从另一个用户连 loopback）。这时 7 章的风险提示同样适用（M7）。
- 文件柜的 `vaultImportRoots` 默认只允许读"下载、文稿"，在专用用户下它们是 `nexus` 自己的目录，想导入主账号的文件需要通过上传，而不是路径导入——这恰好是更安全的默认。

如果你只是临时试用，可以先不做这一步，但要意识到此时 Agent 与你同权限。

---

## 14. 以后要从外网访问（方向，不在本方案范围）

你选择了先只做本机 / 局域网。需要时按风险从低到高：

1. **Tailscale Serve（推荐，tailnet 内才可见）**：`gateway.bind` 保持 `loopback`，`gateway.tailscale.mode: "serve"`，网关给 tailnet 内设备提供 HTTPS。设备都装 Tailscale，**不对公网开放**。出门在外就能打开控制台（也解决第 8 章里 Telegram 审批回落链接打不开的问题）。
2. **SSH 隧道**：任何机器都能用的兜底；Mac 上可用 LaunchAgent 保持隧道（文档 `gateway/remote` 有完整步骤）。
3. **Tailscale Funnel（公网 HTTPS）**：要求共享密码；等于把控制台放到公网，需要额外加固，不建议自用阶段采用。

若目标变成"让朋友 / 多个用户使用"，直接转到服务器版方案（[nexus-agent-core-deployment-plan.md](./nexus-agent-core-deployment-plan.md)），不要在家里的 Mac 上硬扛多用户。

---

## 15. 待验证清单与验收

### 15.1 待验证（装好后逐条过）

| #   | 要确认什么                                                                                                                                  | 怎么验证                                                              | 不成立时                                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| M1  | 本文命令在你装的版本里是否存在 / 参数是否一致（`channels add --token`、`dashboard`、`backup create`、`devices approve`、`gateway restart`） | 每条命令跑一次 `--help`                                               | 以 `--help` 为准；仓库同步到新版本后重打包                                               |
| M2  | `openclaw backup create` 的归档是否包含 `plugins/nexus-agent-core/`（`nexus.sqlite`、`vault/`）和 WhatsApp 认证目录                         | `--dry-run --json` 看路径；真实恢复一次                               | 改用 11.2 的整目录打包                                                                   |
| M3  | launchd 服务是否继承代理环境变量；写入服务环境的正确方式                                                                                    | 在受限网络下启动，看通道状态                                          | 用 `openclaw gateway install --force` 前设好环境，或按文档配置服务环境                   |
| M4  | `pmset -c sleep 0` / `disablesleep 1` 在你的机型与系统版本上的实际效果（合盖、屏保、唤醒）                                                  | 关屏 + 合盖放置数小时后看通道是否在线、Watcher 是否准点               | 改用外接显示器合盖模式；或换常驻机器                                                     |
| M5  | 重启后（含 FileVault）网关何时恢复；专用 macOS 用户 + 快速用户切换时网关与有头浏览器是否照常运行                                            | 实际重启一次；切换用户后跑一个浏览任务                                | 自动登录（放弃 FileVault）/ UPS / 主账号直接使用                                         |
| M6  | WhatsApp 在你的家庭网络上的稳定性；App 的 Channels 页面是否提供扫码                                                                         | 连续运行一周；记录掉线次数                                            | 以命令行扫码为准；不稳定则降级为"可选通道"                                               |
| M7  | 另一台设备 / 另一个 macOS 用户连接本网关时的设备批准流程；`bind=lan` 下 Mac App 连接                                                        | 实连一次                                                              | 在本机控制台批准；必要时改用 password 认证                                               |
| M8  | 受管浏览器在 launchd 服务下是否显示窗口、你能否直接接手登录页                                                                               | 让助手打开一个需要登录的站点                                          | 设 `OPENCLAW_BROWSER_HEADLESS=0` / `browser.headless=false`，或用控制台 Browser 面板接手 |
| M9  | 撤销一个已配对的 Telegram / WhatsApp 账号的命令或控制台入口；`allowFrom` 修改后是否热加载                                                   | `openclaw pairing --help`；控制台 Channels 页；改后用被撤销账号发消息 | 以控制台操作为准；必要时重启网关                                                         |
| M10 | 通过 Telegram / WhatsApp 发来的文件、图片、语音去向：是否进入文件库或被提取                                                                 | 各发一次，查文件页和日志                                              | 验证前不经 IM 传敏感文件                                                                 |
| M11 | WhatsApp 手机长时间不联网后，网关与 `channels status` 如何反映；是否出现 14 天登出                                                          | 查官方说明；实际观察                                                  | 手机保持联网；掉线后重扫                                                                 |
| M12 | 需要代理的网络下，launchd 服务能否让 Telegram 长轮询出站（与 M3 相关）                                                                      | 在受限网络启动，看 `channels status --probe`                          | 按 M3 设置服务环境                                                                       |

### 15.2 验收清单

1. 4.3 的验证命令全部通过；Nexus 页面可见；事项 / 文件柜可用。
2. 重启 Mac 并登录后，不动任何东西，`gateway status --deep` 与 `channels status --probe` 均正常。
3. 接电关屏放置 2 小时后，Telegram 发一句话仍能回复。
4. Telegram 完成配对；陌生账号给 bot 发消息只收到配对码、不被执行。
5. WhatsApp 完成扫码与配对（或自聊），发一句话有回复；手机退出关联设备后，状态能反映出需要重新登录。
6. 让助手打开一个需要登录的站点，你能亲自完成登录后让它继续。
7. （启用局域网时）手机在同一 Wi-Fi 能打开控制台；退出该 Wi-Fi 后访问不到；改回 `loopback` 后局域网访问断开。
8. `openclaw backup create --verify` 成功；在临时目录恢复一次并能读到 Nexus 数据。
9. 按 16.5 演练一次"怀疑 bot token 泄露"：撤销、重新添加、旧 token 失效、新 token 可用、配对列表无陌生账号。
10. （若启用 WhatsApp）手机联网正常时连续一周，记录掉线次数与原因，填入 M6 / M11。

---

## 16. Telegram / WhatsApp：本地部署的连接速查与风险

> 第 8、9 章是逐步操作；本章把它们压成"选哪个、怎么接、哪里会出事、出事怎么办"，并补上第 13 章没覆盖的通道专项风险。**风险的概率与影响是按自用单机场景做的定性判断，不是统计数据**；标【待验证】的点见 15.1 的 M9–M12。

### 16.1 先选哪条路

|                 | Telegram                                                             | WhatsApp                                                        |
| --------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| 接入方式        | 官方 Bot API（自己建 bot）                                           | 非官方"关联设备"协议（Baileys），无官方企业接口可用             |
| 入站需求        | 无。Mac 主动长轮询 `api.telegram.org`，不开端口                      | 无。Mac 主动连 WhatsApp 服务器                                  |
| 你需要准备      | Telegram 账号（任意）；BotFather 给的 bot token                      | 一个专用手机号 + 登录该号的手机（推荐）；或用主号自聊（不推荐） |
| 封号 / 限制风险 | 低（官方机制）                                                       | **中**：号码可能被限制，且没有申诉保证                          |
| 消息保密        | bot 聊天是 Telegram 云端聊天，**不是端到端加密**，不支持 secret chat | 消息本身端到端加密，但关联设备（你的 Mac）上是明文              |
| 审批体验        | 可带内联按钮，不能安全绑定时回落为网页链接                           | 同左，按钮支持因版本而异【待验证】                              |
| 建议角色        | **主通道**                                                           | **可选通道**，先跑稳 Telegram 再接                              |

建议顺序：① 先接 Telegram，连续用一周；② 再决定要不要接 WhatsApp；③ 接 WhatsApp 时只用专用号码，不用主号。

### 16.2 Telegram：连接速查

| 步骤 | 做什么                                                                                    | 成功的样子                                     |
| ---- | ----------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1    | 在 Telegram 里找 `@BotFather`（核对用户名完全一致）→ `/newbot`，记下 bot token            | 拿到形如 `数字:字符串` 的 token                |
| 2    | `openclaw channels add --channel telegram --token <token>`（别把 token 贴进聊天或截图）   | 命令成功；`openclaw.json` 里出现 Telegram 配置 |
| 3    | `openclaw channels status --probe`                                                        | Telegram 显示 running / 探测通过               |
| 4    | 给你的 bot 发一句话 → 收到配对码 → `openclaw pairing approve telegram <CODE>`（1 小时内） | 再发一句话，助手回复                           |
| 5    | 收紧：`allowFrom` 只放你自己的 Telegram 用户 ID；BotFather 里 `/setjoingroups` 关闭拉群   | 陌生账号发消息只得到配对码                     |

常见失败：

| 现象                | 多半原因                                                       | 处理                                                                        |
| ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 启动报 unauthorized | token 错了，或被 `/revoke` 过                                  | 重新取 token，再 `channels add`                                             |
| 发消息没反应        | 还没配对；或 Mac 休眠 / 断网                                   | `pairing list telegram`；`channels status --probe`；检查电源设置（第 5 章） |
| 时好时坏            | 出站网络到 `api.telegram.org` 不稳，或需要代理但服务没继承代理 | 换网络；代理见 M3 / M12                                                     |

### 16.3 WhatsApp：连接速查

| 步骤 | 做什么                                                                                                                   | 成功的样子                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 0    | 准备专用号码（副号 / eSIM），在一部手机上登录 WhatsApp。**不要用主号**                                                   | 手机上能正常收发                                                         |
| 1    | `openclaw config set channels.whatsapp.dmPolicy '"allowlist"' --strict-json`，再设 `allowFrom` 为你**主号**的 E.164 号码 | 配置写入成功                                                             |
| 2    | `openclaw channels login --channel whatsapp`，终端出二维码                                                               | 终端显示二维码（首次会提示装 WhatsApp 插件，需联网）                     |
| 3    | 手机：WhatsApp → 设置 → 已关联设备 → 关联设备 → 扫码（二维码会过期，过期重跑 step 2）                                    | 状态变为已连接                                                           |
| 4    | 用你的主号给专用号发一句话                                                                                               | 助手回复；若走 `pairing` 则按 `openclaw pairing approve whatsapp <CODE>` |
| 5    | `openclaw channels status --probe`                                                                                       | 显示已连接                                                               |

常见失败：

| 现象                 | 多半原因                                                                                                          | 处理                                                   |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 突然不回             | 手机端手动退出了关联设备；号码被限制；Mac 休眠                                                                    | `channels status --probe`；需要时重新 `channels login` |
| 反复要求扫码         | 认证目录丢了或被覆盖（恢复备份后常见）                                                                            | 重新扫码；备份里要含认证目录（M2）                     |
| 手机很久没联网后掉线 | WhatsApp 的关联设备规则：手机长时间（官方说明约 14 天）不上线，关联设备会被登出【待验证 M11，以官方当前说明为准】 | 手机保持联网；掉线后重扫                               |
| 发送立即失败         | 没有活动的 WhatsApp 监听（网关在睡眠或通道掉线）                                                                  | 先让网关恢复在线                                       |

### 16.4 风险登记表

等级说明：可能性、影响各分 低 / 中 / 高。"残余"指做完缓解后还剩的风险。

| #   | 通道     | 风险                                                                                                        | 可能性 | 影响                     | 缓解                                                                                                       | 残余                       |
| --- | -------- | ----------------------------------------------------------------------------------------------------------- | ------ | ------------------------ | ---------------------------------------------------------------------------------------------------------- | -------------------------- |
| R1  | Telegram | **bot token 泄露**：token 明文在 `~/.openclaw/openclaw.json`、备份、截图里；拿到的人能冒充 bot 收发消息     | 中     | 高                       | FileVault；专用 macOS 用户；备份加密且不上云盘；不贴聊天；怀疑泄露立即 `/revoke` + 重新 `channels add`     | 低                         |
| R2  | Telegram | 陌生人搜到 bot 并发消息 / 骚扰                                                                              | 中     | 低                       | `dmPolicy: pairing`（只回配对码，不执行）；`allowFrom` 收紧；关闭拉群；不公开 bot 用户名                   | 低                         |
| R3  | Telegram | bot 聊天**非端到端加密**，内容存在 Telegram 云端                                                            | 确定   | 中                       | 不在聊天里发身份证号、卡号、密码、验证码；这与 Nexus"不保存敏感值"一致                                     | 中（属平台性质，无法消除） |
| R4  | Telegram | 你的 Telegram 账号或手机被盗，别人能指挥助手                                                                | 低     | 高                       | 开 Telegram 两步验证；手机锁屏；**接真实能力前必须收紧聊天批准**（见 R9）；丢手机时在 Mac 上撤销配对（M9） | 中                         |
| R5  | Telegram | Mac 休眠或断网期间收不到消息；Telegram 对未取走的更新通常只保留约 24 小时，超时的消息会丢【以官方说明为准】 | 中     | 中                       | 接电不休眠、合盖策略（第 5 章）；重要事不要只靠 IM 一次性下达                                              | 中                         |
| R6  | WhatsApp | **号码被限制 / 封禁**：属非官方协议；发送频率异常、群发、联系陌生人会提高概率；无官方保证、无申诉保证       | 中     | 中（专用号）/ 高（主号） | 专用号；低频；不群发；不主动联系陌生人；先用 Telegram 作主通道                                             | 中                         |
| R7  | WhatsApp | **认证目录 = 一台"关联设备"**：谁拿到 `~/.openclaw` 里的 WhatsApp 认证目录，就能以该设备身份收发消息        | 低     | 高                       | FileVault；专用 macOS 用户；备份加密、不上云盘；怀疑泄露时手机端立即移除该关联设备                         | 低                         |
| R8  | WhatsApp | 上游协议变更导致突然不可用（逆向协议的固有风险）                                                            | 中     | 低                       | WhatsApp 只作可选通道；不要让关键流程只依赖它                                                              | 中                         |
| R9  | 两者     | **聊天卡片对高风险动作单击批准**（已知不足，见现状文档 5.6）：IM 里的一次误点或被盗号可批准动作             | 低     | 当前低 / 接真实能力后高  | 当前所有外部动作走模拟提供商，不会真对外发；**接真实能力之前**必须先实现"高风险只在网页批准"               | 当前低                     |
| R10 | 两者     | 提示注入：IM 里转发的网页、文件、他人消息里夹带指令                                                         | 中     | 中                       | 产品层已有批准机制；转发来源不明的内容前先想想；不要因为 IM 里一句话就批量批准                             | 中                         |
| R11 | 两者     | 在 IM 里聊的内容进入 Nexus 的任务、记忆和对话记录（同一个助手）                                             | 确定   | 低                       | 知情即可；不想留存的内容用"忘掉"（清除）功能；文件和备份同样按敏感数据对待                                 | 低                         |
| R12 | 两者     | 出门在外只用 IM 时，网页批准链接是局域网地址，点不开                                                        | 确定   | 低                       | 出门前把需要批准的事处理掉；以后要外网访问见第 14 章                                                       | 低                         |
| R13 | 两者     | **网关在线但通道掉线**，你以为助手在，实际收不到                                                            | 中     | 中                       | 每天或每次用前 `channels status --probe`；可在控制台 Channels 页查看；验收清单第 3、5 条                   | 低                         |
| R14 | 两者     | 消息附件（文件、图片、语音）去向不明：是否进入文件库、是否被提取【待验证 M10】                              | 中     | 低                       | 验证前不要通过 IM 发敏感文件；用控制台文件页上传                                                           | 低                         |
| R15 | WhatsApp | 自聊模式下，自己给自己发的备忘或探测消息被当成助手输入                                                      | 中     | 低                       | 用专用号模式，不用自聊                                                                                     | 低                         |
| R16 | WhatsApp | 服务条款对非官方客户端和自动化有限制，账号层面有违规风险【以 WhatsApp 当前条款为准】                        | 中     | 中                       | 同 R6；不用于商业群发                                                                                      | 中                         |

### 16.5 处置手册

| 场景                         | 立即做                                                                                                   | 然后做                                                                                                   |
| ---------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 怀疑 bot token 泄露          | ① BotFather `/revoke`，生成新 token ② `openclaw channels add --channel telegram --token <新 token>`      | `openclaw pairing list telegram` 看有没有不认识的账号；`openclaw logs --follow` 查异常；检查备份文件去向 |
| 手机丢了 / Telegram 账号被盗 | ① 在 Telegram 里对账号做"终止其他会话" ② 在 Mac 上撤销该账号的配对并收紧 `allowFrom`（命令 / 入口见 M9） | 必要时 `/revoke` bot token；暂时停用 Telegram 通道                                                       |
| WhatsApp 号码被限制          | 停止从该号发消息；手机端移除关联设备                                                                     | 换专用号重新 `channels login`；不要立即用主号替代                                                        |
| 怀疑 WhatsApp 认证目录泄露   | 手机端 WhatsApp → 已关联设备 → 移除该设备                                                                | 重新扫码；检查 `~/.openclaw` 权限和备份去向                                                              |
| 助手不回消息                 | `openclaw channels status --probe`                                                                       | 看是否休眠、断网、已掉线；`openclaw logs --follow`；必要时重启网关                                       |
| Mac 要换机 / 重装            | 备份含认证目录（M2）                                                                                     | 恢复后 WhatsApp 多半需要重新扫码，Telegram 一般不用                                                      |

### 16.6 建议的上线节奏

1. **第 1–2 天**：只接 Telegram，完成配对，做 15.2 的第 3、4 条。
2. **第 3–7 天**：日常使用，观察休眠 / 断网对 Telegram 的影响（R5、R13）。
3. **第 2 周**：决定是否接 WhatsApp；若接，只用专用号 + `allowlist`，先低频使用，连续一周记录掉线次数（M6）。
4. **接真实邮箱 / 日历等能力之前**：先完成 R9 的收紧，并重新评审本表。

---

## 17. 附录

### 17.1 关键路径

| 路径                                                | 内容                                                   |
| --------------------------------------------------- | ------------------------------------------------------ |
| `~/.openclaw/`                                      | 状态目录：配置、凭据、会话、工作区、用户态 Node 与 CLI |
| `~/.openclaw/bin/openclaw`                          | App 安装的命令行                                       |
| `~/.openclaw/openclaw.json`                         | 配置（含 token、bot token，明文）                      |
| `~/.openclaw/plugins/nexus-agent-core/nexus.sqlite` | Nexus 数据库                                           |
| `~/.openclaw/plugins/nexus-agent-core/vault/`       | 个人文件柜                                             |
| `~/.openclaw/.nexus-preset-applied`                 | Nexus 预设已应用标记                                   |
| `~/Library/LaunchAgents/ai.openclaw.gateway.plist`  | 网关 launchd 服务                                      |
| `~/Library/Logs/openclaw/gateway.log`               | 网关日志（标准输出与错误合并）                         |
| `~/Library/Logs/OpenClaw/nexus-preset.log`          | Nexus 预设日志                                         |
| 端口 `18789`                                        | 网关（默认 loopback）                                  |

### 17.2 与服务器版方案的差异一览

| 维度                | 服务器版（Linux + Docker）       | 本方案（自己的 Mac）                 |
| ------------------- | -------------------------------- | ------------------------------------ |
| 用户                | 多用户，邀请码注册               | 你自己                               |
| 隔离                | 每用户一个容器                   | 无；建议专用 macOS 用户              |
| 入口                | `a.b.com` + nginx + 每实例 token | `localhost` / 局域网 + 网关 token    |
| 前置服务            | portal + provisioner             | 无                                   |
| 常驻                | Docker `unless-stopped`，不休眠  | launchd + 电源设置，休眠即离线       |
| 浏览器              | 容器内 Chromium（无头）          | 受管 Chrome 配置（可有头，直接接手） |
| Telegram / WhatsApp | portal 引导 + admin RPC          | 命令行 / 控制台                      |
| 备份                | 停机错峰加密                     | `openclaw backup` 或停网关打包       |
| PRD BR-01           | 容器近似（有差距）               | 不满足                               |
