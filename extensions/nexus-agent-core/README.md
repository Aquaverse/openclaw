# Nexus Agent Core

Nexus Agent Core 是 OpenClaw 的一个内置插件，给 Agent 增加一套「可控的长任务能力」：事项（Task）、需要用户确认的动作与决策、带证据的结论（Claim / Evidence）、用户偏好、定时回检（Watcher），以及个人文件柜（File Vault）。所有功能默认关闭，按开关逐项启用。

> **请先知道一件事：目前所有“外部动作”（发消息、预订、付款等）都由模拟提供商（fake provider）执行，不会产生任何真实的外部效果。** 详见文末「不足与注意事项」。

目录

- [1. 安装与使用](#1-安装与使用)
  - [1.1 方式一（推荐）：打包 Mac 应用 `pnpm mac:installer`](#11-方式一推荐打包-mac-应用-pnpm-macinstaller)
  - [1.2 方式二：开发环境 `pnpm gateway:dev`](#12-方式二开发环境-pnpm-gatewaydev)
  - [1.3 配置参数](#13-配置参数)
- [2. 插件功能与命令](#2-插件功能与命令)
  - [2.1 功能模块](#21-功能模块)
  - [2.2 Agent 工具](#22-agent-工具)
  - [2.3 网关 RPC](#23-网关-rpc)
  - [2.4 控制台页面](#24-控制台页面)
  - [2.5 个人文件柜](#25-个人文件柜)
- [3. 开发、测试与构建](#3-开发测试与构建)
- [4. 不足与注意事项](#4-不足与注意事项)
- [5. 更多文档](#5-更多文档)

---

## 1. 安装与使用

两种使用方式共用同一份插件代码，区别只在于怎么把它跑起来、配置放在哪里：

|              | 打包 Mac 应用（推荐）                                                      | 开发环境                                                |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------- |
| 命令         | `ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer`（本地） | `pnpm gateway:dev`                                      |
| 面向         | 想直接用、或把安装包交给别人的人                                           | 改插件代码、跑探针脚本的开发者                          |
| 状态目录     | `~/.openclaw/`                                                             | `~/.openclaw-dev/`                                      |
| 数据库       | `~/.openclaw/plugins/nexus-agent-core/nexus.sqlite`                        | `~/.openclaw-dev/plugins/nexus-agent-core/nexus.sqlite` |
| 文件柜的文件 | `~/.openclaw/plugins/nexus-agent-core/vault/`                              | `~/.openclaw-dev/plugins/nexus-agent-core/vault/`       |
| 网关端口     | 应用自管（launchd）                                                        | 默认 19001                                              |
| 开关怎么打开 | 构建时写进 `installer.env`，安装后自动应用                                 | 手动 `config set`                                       |

> 状态目录也可以用环境变量 `OPENCLAW_STATE_DIR` 改掉，上表是默认位置。

### 1.1 方式一（推荐）：打包 Mac 应用 `pnpm mac:installer`

这条命令从源码构建 `OpenClaw.app`，再重新签名并打成安装包。Nexus 插件已经随应用内置，不需要另外安装。

> **本地开发务必带上 `ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1`。** 不带参数的 `pnpm mac:installer` 是**正式编译 + 正式签名**：
>
> - 机器上没有 Apple 签名身份时，会直接报 `No signing identity found` 并终止；`ALLOW_ADHOC_SIGNING=1` 让它退回临时签名；
> - 构建会编译本地 MLX 语音辅助程序，部分 Xcode 工具链编译不过（Metal 着色器），`OPENCLAW_SKIP_MLX_TTS=1` 跳过它。
>
> 所以本地至少要这样运行：
>
> ```bash
> ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
> ```
>
> 下文所有 `pnpm mac:installer` 的命令，在本地开发时都要加上这两个参数。只有正式发布才用真实签名且不跳过 MLX。

**产物**

- `dist/OpenClaw.app`
- `dist/OpenClaw-<version>-Install.dmg`（设置 `SKIP_DMG=1` 则不生成）

**步骤**

1. 在仓库根目录复制环境变量模板（`installer.env` 已被 git 忽略，不要提交，也不要把里面的密钥发给别人）：

   ```bash
   cd <OpenClaw 仓库根目录>
   cp installer.env.example installer.env
   ```

2. 编辑 `installer.env`。和 Nexus 直接相关的只有最后两项；其余是默认模型、本地模型等安装器通用设置，见模板里的注释：

   ```bash
   # 让安装后的应用直接带着 Nexus（只能是 1；其他值或不写 = Nexus 保持关闭）
   OPENCLAW_INSTALLER_NEXUS_PRESET=1

   # 要打开的功能开关，逗号分隔、只能写字母。不写时的默认值如下（含文件柜和证据原文）：
   OPENCLAW_INSTALLER_NEXUS_SWITCHES=tasksEnabled,decisionsEnabled,claimsEnabled,preferencesEnabled,watchersEnabled,vaultEnabled,evidenceBlobsEnabled
   ```

   文件柜（`vaultEnabled`）和证据原文（`evidenceBlobsEnabled`）**默认随包打开**。不想带哪个，就把变量写成不含它的列表，例如不带文件柜：

   ```bash
   OPENCLAW_INSTALLER_NEXUS_SWITCHES=tasksEnabled,decisionsEnabled,claimsEnabled,preferencesEnabled,watchersEnabled,evidenceBlobsEnabled
   ```

   > 开关之间有依赖：`decisionsEnabled` 需要 `tasksEnabled`；`claimsEnabled` 需要 `decisionsEnabled`；`evidenceBlobsEnabled`、`watchersEnabled` 需要 `claimsEnabled`；`preferencesEnabled`、`vaultEnabled` 需要 `tasksEnabled`。

   同一个变量也可以直接写在构建命令前，优先级高于 `installer.env`：

   ```bash
   # 本地开发（临时签名、跳过 MLX 语音辅助程序）
   OPENCLAW_INSTALLER_NEXUS_PRESET=1 ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
   ```

3. 构建（本地开发必须带这两个参数，原因见上方提示）：

   ```bash
   ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
   ```

4. 安装并打开 `dist/OpenClaw-<version>-Install.dmg`（或直接运行 `dist/OpenClaw.app`），在应用左侧导航里找到 **Nexus** 页面。

**推荐配置：内置版、零配置（本地开发的完整命令）**

只想要一个装上就能用 Nexus 的 `OpenClaw.app`，不带默认模型、不带本地模型、不带路由器，用下面这一条命令即可（不需要 `installer.env`，或者 `installer.env` 里没有相关项也行，因为环境变量优先级高于文件）：

```bash
OPENCLAW_INSTALLER_NEXUS_PRESET=1 \
OPENCLAW_INSTALLER_DEFAULT_MODEL=0 OPENCLAW_INSTALLER_LLAMA=0 OPENCLAW_INSTALLER_LITELLM=0 \
ALLOW_ADHOC_SIGNING=1 OPENCLAW_SKIP_MLX_TTS=1 pnpm mac:installer
```

装好以后用户第一次打开应用，会走应用自己的“选择模型”界面，Nexus 已经启用，不需要再执行任何 `openclaw config` 命令。

| 参数                               | 取值 | 作用                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPENCLAW_INSTALLER_NEXUS_PRESET`  | `1`  | 随应用预置 Nexus：安装后自动启用插件、打开功能开关、固定模拟提供商、放行工具（详见下面的“预设做了什么”）。不是 `1` 就保持关闭                                                                                                                                                        |
| `OPENCLAW_INSTALLER_DEFAULT_MODEL` | `0`  | 不把默认在线模型（`installer.env` 里的 `OPENCLAW_INSTALLER_DEFAULT_AI_*`）打进安装包。填 `1` 则必须同时配好 `BASE_URL` 和 `MODEL`，缺了会让构建失败；不设则看 `installer.env` 里有没有填                                                                                             |
| `OPENCLAW_INSTALLER_LLAMA`         | `0`  | 不打包 llama.cpp 本地兜底模型，安装包里没有 `llama-server`，首次启动也不会去 HuggingFace 下载模型。`1` 表示必须打包（需要 `OPENCLAW_INSTALLER_DEFAULT_LLAMA_MODEL`）                                                                                                                 |
| `OPENCLAW_INSTALLER_LITELLM`       | `0`  | 不打包 LiteLLM 智能路由（“Adaptive”混合路由，要在用户电脑上装约 200–300 MB 的 Python 环境）。它依赖本地模型和默认模型，这两项都关掉时它也没有意义                                                                                                                                    |
| `ALLOW_ADHOC_SIGNING`              | `1`  | 机器上没有 Apple 开发者签名身份时，退回“临时签名”而不是报错。适合本机自用和内部测试；缺点是别的 Mac 首次打开会提示“无法验证开发者”（右键 → 打开一次即可），并且每次重新构建后系统权限（TCC）授权不会保留。要对外分发请用真实签名：设置 `SIGN_IDENTITY`，需要时再加 `NOTARIZE=1` 公证 |
| `OPENCLAW_SKIP_MLX_TTS`            | `1`  | 不打包本地 MLX 语音合成辅助程序。它会引入整套 mlx-swift Metal 着色器，部分 Xcode 工具链编译不过，跳过可以避免被它卡住。**release 构建（`BUILD_CONFIG=release`）会拒绝这个参数**，因为正式发布必须带这个辅助程序                                                                      |

三个 `0/1` 开关的规则一致：`1` = 必须带、缺配置就构建失败；`0` = 强制关闭；不设 = 按 `installer.env` 里有没有填对应配置来决定（不等于“开”）。这三个开关都不会影响网关的 LaunchAgent 和非交互式 onboarding，那两步始终执行。

需要 Nexus 之外的功能时，按需把对应开关改成 `1` 并在 `installer.env` 里填好配置，例如带默认在线模型：`OPENCLAW_INSTALLER_DEFAULT_MODEL=1` 加上 `OPENCLAW_INSTALLER_DEFAULT_AI_BASE_URL` / `OPENCLAW_INSTALLER_DEFAULT_AI_MODEL`。文件柜和证据原文默认已随包启用，不需要再写 `OPENCLAW_INSTALLER_NEXUS_SWITCHES`；要关掉其中一个，才在命令前写上不含它的开关列表（见上文）。

**预设（preset）做了什么**

安装后第一次启动时，`scripts/mac-nexus-preset.sh` 会通过安装好的 `openclaw` 命令行完成四件事，全程幂等、读到已经是目标值就不写：

1. 启用插件 `nexus-agent-core`；
2. 打开 `NEXUS_SWITCHES` 里列出的开关；
3. 把提供商固定为模拟提供商（`fakeProviderMode = "ok"`）；
4. 把 Nexus 的全部工具追加进 `tools.alsoAllow`（保留已有条目，不重复）。

有变化时才会重启网关一次。

**要注意的几点**

- **每个预设版本只应用一次**（当前预设版本是 2：版本 2 起默认多打开文件柜和证据原文，已装过版本 1 的机器重新安装后会补上这两项，只增不改）。标记文件是 `~/.openclaw/.nexus-preset-applied`，用户之后自己关掉某个开关或删掉某个工具，不会被下次启动改回去。所以：已经安装过的机器，只改 `installer.env` 重新打包**不会**生效，要么手动执行 `openclaw config set`（见 1.2 的命令），要么把 `scripts/build-mac-installer.sh` 里的 `NEXUS_PRESET_VERSION`（目前写死为 1）加一再打包。
- 预设日志：`~/Library/Logs/OpenClaw/nexus-preset.log`；安装后的命令行在 `~/.openclaw/bin/openclaw`。
- `installer.env` 里的模型地址和 API Key 会**明文**打进安装包，只放可以共享给所有拿到安装包的人的后端，不要放个人密钥。
- 在 Mac 应用里没有出现 Nexus 页面时，先看 `~/.openclaw/bin/openclaw plugins list` 里 `nexus-agent-core` 是否已启用；第三方方式安装的插件还需要 `gateway.controlUi.experimental.customPlugins=true`（内置版本一般不需要）。

### 1.2 方式二：开发环境 `pnpm gateway:dev`

适合改插件代码、跑探针脚本。开发网关使用独立的状态目录 `~/.openclaw-dev`，默认端口 19001，不会碰你正在用的 `~/.openclaw`。

**1）启动网关**（保持这个终端运行）：

```bash
cd <OpenClaw 仓库根目录>
pnpm gateway:dev
```

**2）另开一个终端，打开功能开关**（只需要一次，写进配置文件，之后重启仍然有效）：

```bash
cd <OpenClaw 仓库根目录>
C=plugins.entries.nexus-agent-core.config

node openclaw.mjs --dev plugins enable nexus-agent-core
for k in tasksEnabled decisionsEnabled claimsEnabled preferencesEnabled watchersEnabled; do
  node openclaw.mjs --dev config set $C.$k true
done

# 可选：文件柜、证据原文
node openclaw.mjs --dev config set $C.vaultEnabled true
node openclaw.mjs --dev config set $C.evidenceBlobsEnabled true

# 模拟提供商：只用于演示和验收，不产生任何外部效果
node openclaw.mjs --dev config set $C.fakeProviderMode '"ok"' --strict-json
```

**3）允许 Agent 使用 Nexus 工具。** Nexus 的工具都是可选工具，必须列进 `tools.alsoAllow`；注意这条命令会**整个替换**列表，不是追加，如果已有别的条目，请先 `config get tools.alsoAllow` 再合并：

```bash
node openclaw.mjs --dev config set tools.alsoAllow '[
  "nexus_task_reserve","nexus_task_create","nexus_task_get","nexus_task_update","nexus_task_note","nexus_task_search",
  "nexus_action_prepare","nexus_action_authorize","nexus_decision_request","nexus_action_commit",
  "nexus_claim_add","nexus_evidence_add","nexus_claim_verify",
  "nexus_preference_get","nexus_preference_set","nexus_preference_confirm",
  "nexus_watch_create","nexus_watch_cancel","nexus_watch_report",
  "nexus_file_search","nexus_file_get","nexus_file_attach"
]' --strict-json
```

`tools.alsoAllow` 的修改会热更新；插件代码或 `plugins.entries.*.config` 的修改需要重启网关。

**4）获取网关 Token。** 探针脚本和命令行直连网关时需要：

```bash
TOKEN=$(node openclaw.mjs --dev config get gateway.auth.token)
```

> Token 是凭据，不要贴到聊天、issue 或日志里。

**5）验证。**

```bash
# 事项列表（新环境应为空）
node openclaw.mjs --dev gateway call nexus.task.list --params '{}'

# 打开带 token 的控制台，进入 Nexus 页面
node openclaw.mjs --dev dashboard

# 跑探针脚本（需要 tsx；ws 地址按实际端口）
node --import ./scripts/tsx.mjs extensions/nexus-agent-core/spikes/ui-fixture.mts \
  --url ws://127.0.0.1:19001 --token "$TOKEN"
```

`extensions/nexus-agent-core/spikes/` 下的脚本都是针对真实网关的验收脚本，例如 `claim-flow.mts`（声明与证据）、`preference-flow.mts`（偏好）、`r1-flow.mts`（标准授权）、`concurrent-commit.mts`（并发提交）、`watch-flow.mts`（回检，需要可用模型）、`purge-flow.mts`（清除）。每个脚本开头的注释写明了前置条件和预期结果。

**文件柜的快速试用**（需要 `vaultEnabled=true`）：

```bash
# 上传一个小文件（内容 "hello" 的 base64 是 aGVsbG8=）
node openclaw.mjs --dev gateway call nexus.vault.upload --params '{"name":"hello.txt","dataBase64":"aGVsbG8="}'

# 从本机路径导入（默认只允许下载、文稿目录，开头的 ~ 会被展开）
node openclaw.mjs --dev gateway call nexus.vault.importPath --params '{"path":"~/Downloads/invoice.pdf"}'

# 列出、看统计
node openclaw.mjs --dev gateway call nexus.vault.list  --params '{}'
node openclaw.mjs --dev gateway call nexus.vault.stats --params '{}'

# 按内容搜索（文本类文件上传后几秒内会自动提取）
node openclaw.mjs --dev gateway call nexus.vault.search --params '{"query":"hello"}'
```

**重置开发环境**：停掉网关，删除 `~/.openclaw-dev` 即可（会清空开发环境里所有 Nexus 数据）。`pnpm gateway:dev:reset` 是宿主自带的重置启动命令，行为见其本身的说明。

### 1.3 配置参数

所有参数都在 `plugins.entries.nexus-agent-core.config.*` 下，完整定义见 `openclaw.plugin.json` 的 `configSchema`。

**功能开关（默认全部关闭）**

| 参数                   | 作用                                                                                         | 前置                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `tasksEnabled`         | 事项模块：`nexus_task_*` 工具、`nexus.task.*` RPC、未完成事项注入提示词、`nexus.sqlite` 存储 | —                                                             |
| `decisionsEnabled`     | 动作、决策、授权、执行：`nexus_action_*`、`nexus_decision_request`                           | `tasksEnabled`                                                |
| `claimsEnabled`        | 声明与证据账本，带完成度闸门                                                                 | `decisionsEnabled`                                            |
| `evidenceBlobsEnabled` | 证据原文（字节）上传和读取                                                                   | `claimsEnabled`，且宿主允许（见第 4 节）                      |
| `preferencesEnabled`   | 偏好库                                                                                       | `tasksEnabled`（确认为“用户明确表达”还需 `decisionsEnabled`） |
| `watchersEnabled`      | 定时回检                                                                                     | `claimsEnabled`                                               |
| `vaultEnabled`         | 个人文件柜                                                                                   | `tasksEnabled`（`nexus_file_attach` 还需要证据原文开启）      |
| `spikesEnabled`        | Stage 0 运行时探针，仅开发用                                                                 | —                                                             |

**模拟提供商**

| 参数                     | 默认   | 说明                                                                                                                                     |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `fakeProviderMode`       | `ok`   | `ok` 成功；`reject` 提供商拒绝；`drop_after_success` 效果已发生但连接断开（执行状态变成未知）；`drop_before_send` 什么都没发生且连接断开 |
| `fakeProviderIdempotent` | `true` | 是否承认幂等键。设 `false` 可演练“不支持幂等、只能对账”的路径                                                                            |

**审批与回检**

| 参数                  | 默认                         | 说明                                                                                       |
| --------------------- | ---------------------------- | ------------------------------------------------------------------------------------------ |
| `coreApprovalEnabled` | `true`                       | 在用户回合里给 `nexus_decision_request` 附一张宿主的审批卡。Nexus 自己的决策页始终是主路径 |
| `approvalTimeoutMs`   | `600000`                     | 审批卡超时。宿主若拒绝超过 2 分钟的值，改成 `120000`                                       |
| `watcherExtraTools`   | `["web_fetch","web_search"]` | 回检回合除 Nexus 工具外可用的只读工具。只接受这两个                                        |

**证据存储**

| 参数                                                 | 默认        | 说明                                                                |
| ---------------------------------------------------- | ----------- | ------------------------------------------------------------------- |
| `evidenceTaskQuotaBytes`                             | 200 MB      | 每个事项的软配额，超出会失败并产生一条通知决策                      |
| `evidenceOwnerQuotaBytes`                            | 400 MB      | 每个 owner 的软配额（按物理对象计）                                 |
| `evidenceMaxUploadBytes`                             | 16 MB       | 单条证据上限；上传走 base64 单帧，要小于网关帧限制                  |
| `evidenceWriterLeaseMs` / `evidenceReservationTtlMs` | 30 s / 60 s | 写入租约、预约存活时间，调试用                                      |
| `evidenceIncarnationGoneEnabled`                     | `false`     | 是否启用“进程已消失”的缺席证明，需要先确认 boot id 来源，见设计文档 |

**文件柜**

| 参数                                 | 默认       | 说明                                                              |
| ------------------------------------ | ---------- | ----------------------------------------------------------------- |
| `vaultOwnerQuotaBytes`               | 5 GB       | 每个 owner 的软配额                                               |
| `vaultMaxFileBytes`                  | 100 MB     | 单个文件上限（RPC 上传另有 16 MB 上限，更大的用路径导入）         |
| `vaultInboxRetentionDays`            | 30         | 收件里未处理的文件几天后自动丢弃                                  |
| `vaultTrashRetentionDays`            | 30         | 回收站里的文件几天后永久清除                                      |
| `vaultImportRoots`                   | 下载、文稿 | 路径导入允许读取的根目录。凭据目录和 Nexus 自己的状态目录永远拒绝 |
| `vaultMinFreeBytes`                  | 1 GB       | 磁盘剩余空间低于此值时拒绝写入                                    |
| `vaultReservationRetentionDays`      | 7          | 已完成的写入预约保留多久用于排查                                  |
| `vaultTombstoneRetentionDays`        | 7          | 已删除对象的墓碑保留多久                                          |
| `vaultPurgeReceiptHashRetentionDays` | 90         | 清除回执里的内容哈希保留多久，之后只留计数和时间                  |
| `vaultExtractEnabled`                | true       | 文本类文件自动提取文字、支持按内容搜索（敏感文件永不提取）        |
| `vaultExtractMaxBytes`               | 5 MB       | 超过此大小的文件不提取，标为“不支持”                              |
| `vaultExtractMaxChars`               | 2,000,000  | 提取出的文字上限，超出部分截断并在控制台标注                      |
| `vaultHttpUploadEnabled`             | true       | 开放可续传的分块上传 HTTP 入口，给大文件和手机使用                |

**其他**

| 参数      | 默认    | 说明                                    |
| --------- | ------- | --------------------------------------- |
| `ownerId` | `local` | MVP 阶段的 owner 占位，**不是安全边界** |

---

## 2. 插件功能与命令

### 2.1 功能模块

| 模块                                | 解决什么问题                                                                                                                                                                                                                            |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **事项（Task）**                    | 把一件要持续几轮对话才能做完的事记下来：目标、状态、进展、备注，并在每次对话开始时把未完成的事项提示给 Agent，避免“聊着聊着忘了”                                                                                                        |
| **动作与决策（Action / Decision）** | Agent 想做有后果的事（发消息、预订、付款）时，先“准备”再“请求授权”，由用户在 Nexus 页面批准；按风险分级（R0–R3），R2 以上要求二次确认；支持针对某个对象的长期授权（standing grant）。批准后才“提交”，提交带幂等键，崩溃或断线后可以对账 |
| **声明与证据（Claim / Evidence）**  | Agent 说“已经订好了”之前，必须把这个结论登记成声明并挂上证据；只有证据链成立，事项才能标记为完成。证据可以是元数据，也可以是文件原文                                                                                                    |
| **偏好（Preference）**              | 记住用户明确说过的偏好（如座位、语言），区分“用户明确表达”和“Agent 观察到的”，后者需要确认才算数                                                                                                                                        |
| **回检（Watcher）**                 | 约定“过一段时间再确认某件事”，到点由后台回合用只读工具重新检查，次数用尽后会生成一条需要用户知悉的决策                                                                                                                                  |
| **个人文件柜（File Vault）**        | 用户的发票、合同等文件：收件、归档、改名、移动、回收站、永久清除并留回执；Agent 只能按文件名找文件、读元数据，也能把文件作为证据挂到声明上                                                                                              |

### 2.2 Agent 工具

全部是可选工具，需要在 `tools.alsoAllow` 里放行。

| 工具                                                                         | 说明                                                                                                                               |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `nexus_task_reserve` / `nexus_task_create`                                   | 先预留一个操作令牌，再创建事项；令牌保证重试不会重复创建，创建前还会自动查重，已有相似的未完成事项时返回候选而不是新建             |
| `nexus_task_get` / `nexus_task_search`                                       | 读取、搜索事项                                                                                                                     |
| `nexus_task_update` / `nexus_task_note`                                      | 更新标题、目标、摘要和状态、追加进展备注。开启声明模块后，事项只有在所有“完成条件”声明都被证据支撑时才能标成完成，光说“做完了”不算 |
| `nexus_action_prepare`                                                       | 登记一个想做的外部动作（联系供应商、预订、付款）。只是记录，不会真的发送或下单；风险等级由服务端按工具名判定                       |
| `nexus_action_authorize`                                                     | 只用于低风险（R1）动作：如果用户已批准覆盖它的长期策略，返回可提交的执行号；本身不执行任何事                                       |
| `nexus_decision_request`                                                     | 请求用户批准某个动作（或低风险动作的长期策略）。问题、事实、选项都由服务端生成；用户拒绝是终局                                     |
| `nexus_action_commit`                                                        | 用批准后得到的执行号提交动作（经提供商、带幂等键）。结果是“未知”或“待确认”时不能重试，也不能说成功                                 |
| `nexus_claim_add`                                                            | 登记一个“我要告诉用户这是真的”的声明。Agent 只能把它标成已断言或未知，不能自己标成已证实                                           |
| `nexus_evidence_add`                                                         | 以引用方式给声明挂证据（执行结果或用户上传的材料）；是否算作支持由存储判断，不由 Agent 说了算                                      |
| `nexus_claim_verify`                                                         | 只读：看某个声明（或整个事项）的证据到底建立了什么，以及完成条件是否满足                                                           |
| `nexus_preference_get` / `nexus_preference_set` / `nexus_preference_confirm` | 读取、记录偏好；`confirm` 是请用户确认某个值为“明确表达的偏好”，用户在决策页批准之前不算数                                         |
| `nexus_watch_create` / `nexus_watch_cancel` / `nexus_watch_report`           | 创建、取消回检；`report` 只能在回检回合里使用，汇报“已满足 / 还没有 / 无法检查”                                                    |
| `nexus_file_search`                                                          | 按文件名、文件夹找文件；`contentContains` 可按内容找，但只返回命中的文件元数据，不返回文字片段，永远不返回敏感文件                 |
| `nexus_file_get`                                                             | 读一个文件的元数据（不含内容，只告诉你“能否按内容搜索”和提取状态）                                                                 |
| `nexus_file_attach`                                                          | 把文件柜里的文件挂到声明上作为证据（需要证据原文已开启）                                                                           |

`nexus_spike_probe` 是 Stage 0 的探针工具，只在 `spikesEnabled` 时存在，不放进 `tools.alsoAllow`。

### 2.3 网关 RPC

控制台和探针脚本通过这些方法读写数据。读操作要求 `operator.read`，写操作 `operator.write`，危险操作（永久清除等）`operator.admin`。

| 命名空间                                                   | 方法                                                                                                                                                                                                                         |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `nexus.task.*`                                             | `list` `get` `abort` `delete` `purge` `purgeStatus` `purgeReceipts`                                                                                                                                                          |
| `nexus.decision.*` / `nexus.execution.*` / `nexus.grant.*` | `decision.list` `get` `resolve`；`execution.list` `resolve` `reconcile`；`grant.list` `revoke`                                                                                                                               |
| `nexus.claim.*`                                            | `list` `get` `retract` `unlinkEvidence` `verifyChain`                                                                                                                                                                        |
| `nexus.evidence.*`                                         | `list` `upload` `link` `handle` `read` `delete` `stats` `maintain` `reconcile`                                                                                                                                               |
| `nexus.preference.*`                                       | `list` `get` `set` `delete` `history` `purge` `purgeReceipts`                                                                                                                                                                |
| `nexus.watch.*`                                            | `list` `get` `cancel`                                                                                                                                                                                                        |
| `nexus.vault.*`                                            | `list` `get` `stats` `read` `upload` `importPath` `keep` `discard` `trash` `restore` `rename` `move` `pin` `setSensitivity` `purge` `purgeStatus` `purgeReceipts` `maintain` `search` `text` `jobs` `extract` `retryExtract` |

变化会以事件广播给控制台（`decision_changed`、`claim_changed`、`evidence_changed`、`preference_changed`、`watch_changed`、`vault_changed`、`task_purged` 等），事件只带 id 和摘要，不带文件名等内容，客户端收到后重新读取。

命令行调用示例：

```bash
node openclaw.mjs --dev gateway call nexus.decision.list --params '{}'
node openclaw.mjs --dev gateway call nexus.task.get --params '{"taskId":"T…"}'
```

### 2.4 控制台页面

Nexus 页面是一个 Control UI 模块（源码在 `browser/`），标签包括：

- **事项**：列表（可按状态、关键字、时间筛选和分页）、详情（决策、执行、声明、证据、回检、步骤日志，时间都有显示）；待决策卡片上可以直接批准或拒绝，R2 以上要二次确认；
- **偏好**：新增、编辑、删除；
- **文件**：仅在 `vaultEnabled` 时出现，见下一节；
- **清除回执**：事项和偏好被永久清除后留下的回执。

页面支持中英文，跟随宿主语言。文件名、事项标题等用户文本一律当纯文本显示，不会变成 HTML。

### 2.5 个人文件柜

插件本身默认关闭，`vaultEnabled=true`（并启用 `tasksEnabled`）后可用；用安装器带预设打包时，文件柜和证据原文**默认已打开**（见 1.1）。

**能做什么**

- 上传（控制台，最大 16 MiB）、从本机路径导入（默认只能读下载、文稿目录，复制进文件柜，不引用原路径）；
- 分成三类：收件（刚进来、等你确认）、文档库（你保留的）、产出（Agent 为你生成的）；
- 保留 / 丢弃、改名、移动、置顶、标为敏感、移入回收站、恢复；
- 永久清除：需要勾选确认并重复文件 id，清除后留一张回执（内容哈希按配置的天数保留）；
- 同样内容只存一份（去重）；崩溃或断电后会自动对账，字节丢失或损坏的文件会标成“已损坏”；
- 磁盘剩余空间、单文件大小、总配额都有上限，超出会拒绝而不是写坏。

**Agent 能做什么**

可以按名称找，也可以按内容找（`nexus_file_search` 的 `contentContains`），但只会得到“哪些文件命中”，**读不到文字本身**（`nexus_file_get` 只返回元数据）；还可以挂为证据（`nexus_file_attach`）。不能新建、改名、移动、删除，看不到敏感文件。

**按内容搜索（F2）**

- 文本类文件（txt、md、csv、json、html、代码等）上传后自动提取文字，不需要联网、不依赖外部程序；常见中文编码（UTF-8、UTF-16、GB18030）能识别。
- 文件列表里有“文字”一列：可搜索 / 处理中 / 提取失败 / 不支持 / 已跳过（敏感）。提取失败可点“重试提取”。
- 点“搜索内容”输入关键词，只在已提取的文件里找；结果会提示“另有 N 个文件暂时不能按内容搜索”，所以“没找到”不等于“没有”。
- 文件被标为敏感：已提取的文字立即删除，之后不再提取；取消敏感后自动重新提取。
- 文字只在控制台里给你自己看，Agent 看不到。

**在对话里引用文件、手机上传（F3）**

- 每个非敏感文件在详情里有一个引用码，形如 `#VF0123456789`。在聊天里写上它，Agent 就知道你指的是哪个文件（只告诉它文件名、类型、大小等元数据；敏感、已删除或不存在的文件一律回复“不可用”）。一条消息最多识别 5 个引用码。
- 大文件和手机可以走网关的分块上传入口 `/plugins/nexus-agent-core/vault-upload`：先建会话，再按偏移分块上传（可断点续传），最后确认；用网关令牌认证，需要 `operator.write` 权限。同时最多 4 个未完成的上传，24 小时内要传完。不涉及账号系统或 Relay。

**目前的限制**

- 只提取文本类文件，没有 PDF、图片、Office 文档的文字提取（计划在后续阶段）；内容搜索是精确子串匹配，不是语义搜索；
- 控制台列表最多 200 项，没有分页和按名称搜索，没有图片 / PDF 预览，文本类文件显示前一段内容；
- 独立 HTTP 页面（`/plugins/nexus-agent-core/ui`）没有“文件”标签；
- 宿主的命令行类工具仍可能读到文件库目录里的原始字节（已实测，`tools.fs.workspaceOnly=true` 也挡不住 shell），所以“敏感文件”只保证不经 `nexus_file_*` 工具提供，**不能**当作对 Agent 完全保密，详见设计文档 13.4；
- 没有手机端界面和账号系统；手机目前只能直接调用分块上传的 HTTP 入口。

设计细节见 `docs/nexus-agent-core-personal-file-vault-design.md`，第 13 节记录 F1 的澄清，第 14 节记录 F2、F3。

---

## 3. 开发、测试与构建

**测试与检查**（在仓库根目录）：

```bash
pnpm exec oxfmt extensions/nexus-agent-core     # 格式化
pnpm format:check
pnpm tsgo:extensions                            # 类型检查
pnpm tsgo:extensions:test                       # 类型检查（含测试文件）
pnpm lint:extensions
pnpm test:extension nexus-agent-core            # 单元测试
```

**构建**：

```bash
node extensions/nexus-agent-core/scripts/build-dist.mjs
```

它会生成 `dist/index.js`、SQLite worker 和 `dist/control-ui/<hash>/`，并把控制台模块的哈希写回 `openclaw.plugin.json` 的 `controlUi.entry`。**改了 `browser/` 下的代码后必须重新构建，并把变化后的 `openclaw.plugin.json` 一起提交**，否则网关加载的还是旧的控制台页面。

**目录结构**

| 目录                                                         | 内容                                                |
| ------------------------------------------------------------ | --------------------------------------------------- |
| `index.ts`、`openclaw.plugin.json`                           | 插件入口、清单（配置 schema、工具声明、控制台模块） |
| `src/store/`                                                 | SQLite 存储内核和迁移，运行在独立 worker 里         |
| `src/tools/`                                                 | Agent 工具                                          |
| `src/decision/`、`src/evidence/`、`src/purge/`、`src/vault/` | 决策、证据、清除、文件柜的服务层                    |
| `src/*-rpc.ts`                                               | 网关 RPC                                            |
| `src/ui-render.ts`、`src/i18n.ts`                            | 页面渲染（HTML 字符串）与中英文文案                 |
| `browser/`                                                   | 控制台模块（DOM 构建、对话框、路由）                |
| `spikes/`                                                    | 针对真实网关的验收脚本                              |
| `docs/`                                                      | 设计和阶段总结                                      |

**约定**

- 工具名一律以 `nexus_` 开头；
- 面向模型的文本（工具描述、提示词、日志）只用英文，文档用中文；`i18n.test.ts` 会检查英文文案里没有中文、中英文占位符一致；
- 新增工具必须同时更新 `openclaw.plugin.json`（`contracts.tools` 与 `toolMetadata`）和 `scripts/mac-nexus-preset.sh` 的 `NEXUS_TOOLS`，`manifest.test.ts` 会校验；
- 只改扩展目录，不改 OpenClaw 主程序（`src/`、`ui/`）。

---

## 4. 不足与注意事项

1. **提供商是模拟的。** 目前只有 fake provider：预订、付款、发消息这类“外部动作”只会在本地记账并返回模拟结果，不会真的联系任何供应商，也不会花一分钱。预设脚本会把 `fakeProviderMode` 固定为 `ok`。接入真实提供商之前，不要把 Nexus 的“已提交”理解成现实世界里已经发生。
2. **证据原文存储只对受信任插件开放。** 宿主只允许内置插件或官方外部插件调用底层 blob 存储。通过 `npm-pack:`、第三方 `npm:` 或 ClawHub 安装的版本，`evidenceBlobsEnabled` 会自动降级（启动时一条 warn），上传 / 读取返回 `nexus_evidence_unavailable`；任务、声明、元数据证据、决策、偏好、回检不受影响。随 Mac 应用内置的版本不受此限制。
3. **第三方安装需要额外放行。** 非内置插件必须设置 `plugins.entries.nexus-agent-core.hooks.allowConversationAccess=true`，“未完成事项注入提示词”才会生效；还需要 `--accept-capabilities` 安装、`gateway.controlUi.experimental.customPlugins=true` 并重启网关。
4. **敏感文件对 Agent 的可见性有边界。** 敏感文件对 `nexus_file_*` 工具不可见，但宿主的通用文件工具在技术上可能读到状态目录里的文件柜目录。在落实宿主侧策略之前，不要对用户承诺“Agent 绝对看不到”。
5. **单机、单用户。** `ownerId` 只是占位，不是安全边界。账号系统和 Relay 就绪之前，不对手机端和 Relay 开放文件柜与 RPC。
6. **备份与同步。** 把状态目录放进云同步或备份后，已永久清除的文件可能残留在备份里；整个目录回滚时，已清除的文件和回执会一起恢复。建议状态目录不进云同步。
7. **回检需要可用的模型**，没有模型时回检不会到点执行，探针脚本里的 `watch-flow.mts` 同理。
8. **预设只在每个版本应用一次**，见 1.1；已安装机器上改开关要手动 `config set` 或升 `NEXUS_PRESET_VERSION`。
9. **文件柜 F1 的限制**见 2.5。真实网关上的端到端验证（打包路径回归、第三方安装、重启对账）仍在进行。

---

## 5. 更多文档

`docs/` 下按主题：

- 设计总纲：`nexus-agent-core-design.md`、`nexus-agent-core-architecture.md`（插件根目录）
- 安装与演示：`docs/nexus-agent-core-install-and-demo.md`（第三方安装的命令与验收）、`docs/nexus-agent-core-delivery-and-ui-demo.md`（面向观众的演示）、`docs/nexus-agent-core-pkg-regression.md`（打包安装回归）
- 阶段总结：`docs/nexus-agent-core-stage0-1-summary.md`、`stage2`、`stage3-*`、`stage4`
- 个人文件柜：`docs/nexus-agent-core-personal-file-vault-design.md`
- 目标与规划：`docs/nexus-agent-core-goals-design.md`、`docs/nexus-agent-core-plugin-status-and-remaining-work.md`
