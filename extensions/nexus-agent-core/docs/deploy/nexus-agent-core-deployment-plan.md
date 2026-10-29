# Nexus 多用户部署方案（Linux + Docker，对外域名 a.b.com）

> 状态：设计草案 v0.1（2026-10-29），**尚未在真实服务器上验证**。文中凡标 **【待验证 Vn】** 的地方，是依据 OpenClaw 官方文档推断、没有实机确认的点，统一列在第 16 章，第一轮 spike 要逐条过。
>
> 范围：只讲"怎么部署、怎么开通、怎么连接"。产品需求以 `docs/prd/NEXUS_AI_PRD.md`（v1.86）为准；PRD 明确不含实施阶段、人力、定价、模型路由，这些不在本文裁决范围内，涉及处只给假设。
>
> 配套文档：普通用户怎么用见 [nexus-agent-core-user-guide.md](./nexus-agent-core-user-guide.md)。

---

## 0. 一页纸摘要

| 项         | 决定                                                                                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 租户模型   | **1 个用户 = 1 个租户 = 1 个完整 OpenClaw Gateway 容器**（上游文档的多租户口径：多用户模式不是隔离边界，隔离边界是"每个信任边界一个 Gateway"）                           |
| 宿主       | 1 台 Linux（Ubuntu 24.04 LTS 起步），Docker Engine；单机满了再加机器（第 14 章）                                                                                         |
| 对外入口   | 只有 `https://a.b.com`，一个域名、一张证书，nginx 终结 TLS，只做转发和限流                                                                                               |
| 路由       | `a.b.com/` 与 `/api/` → 前置服务 **nexus-portal**；`a.b.com/t/<id>/` → 该用户容器（WebSocket 透传）。每个租户配置 `gateway.controlUi.basePath=/t/<id>`                   |
| 认证       | **每实例一个 token**。Mac App 和网页控制台都用"地址 + token"登录；token 由 portal 签发、可轮换。反代不做认证，不使用 Cloudflare Access / trusted-proxy                   |
| 注册       | 邀请码注册（邮箱 + 密码 + 邀请码）。portal 记录用户、分配租户 id/端口/资源档位、创建并启动容器                                                                           |
| 三种连接   | ① 远程访问（Mac App / 网页控制台连 `https://a.b.com/t/<id>/`）；② Telegram（每租户自己的 bot，portal 引导绑定）；③ WhatsApp（每租户自己的"关联设备"，portal 转发二维码） |
| 模型       | 先假设**平台提供默认模型**：租户拿到的是平台模型网关发的**限额虚拟 key**，不是真实供应商 key；用户可在 portal 或控制台改成自己的 key（BYOK）                             |
| 不用什么   | 不用 `openclaw fleet`（上游已在 main 移除，PR #165825，随 2026.10.10 发布）；不用 Cloudflare；不开放原生移动 App / Relay（PRD 暂缓）                                     |
| 要自己写的 | ① portal（用户、邀请码、开通流程、API）；② provisioner（本机特权小进程，只会"建/起/停/升/删/备份租户容器"）；③ 镜像构建脚本；④ nginx 路由同步；⑤ 备份与监控脚本          |

---

## 1. 目标、边界与 PRD 的对应

### 1.1 PRD 要求落到部署上

| PRD 条款                                                                     | 部署上怎么满足                                                                                                                                              |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BR-01 浏览器与 Agent 主机是专用机器，不是用户个人电脑                        | 每个租户容器内置 Chromium（镜像用 `OPENCLAW_INSTALL_BROWSER=1`）；容器跑在服务器上                                                                          |
| BR-02 登录/MFA/验证码要能让用户在受保护的 Agent 浏览器会话里接手             | 用户在控制台 **Browser 面板**里操作 Gateway 控制的浏览器（可键入、粘贴）。要求这个控制台连接是 `operator.admin` 且声明 `browser.request`。**【待验证 V6】** |
| BR-03/04 用户离开不会停止 Agent 主机；主机失败与通道失败分开看               | 容器 `--restart unless-stopped`、**不做闲置休眠**；portal 健康检查区分"容器/网关状态"与"通道状态"                                                           |
| CH-01 Telegram、WhatsApp 是 P0，其余通道"兼容但未验收"                       | portal 只提供这两个通道的引导；其他通道不开放入口                                                                                                           |
| CH-02 配对把平台主体绑定到 owner                                             | Telegram 用 `dmPolicy=pairing` + 配对码；WhatsApp 用 `pairing` 或 `allowlist`（第 10 章）                                                                   |
| CH-03 内联按钮仅在载荷绑定安全时可提交审批，否则回落到"需登录的网页决策链接" | 回落链接 = `https://a.b.com/t/<id>/` 控制台里的决策页；token 登录后可见                                                                                     |
| CH-04 外发有 Outbox，通道故障独立于主机故障                                  | Nexus 插件自带；portal 只展示通道状态，不接管                                                                                                               |
| §4.3 IM 是命令/交付入口，不是执行主机                                        | 一致：执行永远在租户容器里                                                                                                                                  |

### 1.2 本方案**不**解决的

- **容器 ≠ PRD 字面的"专用物理机/云虚拟机"**。Docker 共享宿主内核，是工程折中；要更强隔离见 §12.3（gVisor/Kata/每用户一台 VM 的升级路径）。这一点要让产品方知道并认可，不要在对外话术里写成"独享物理机"。
- 计费、套餐定价、发票。
- 原生移动 App、Relay、推送（插件状态文档里仍是"未建"）。
- 多主机调度（第 14 章只给扩展路线）。

---

## 2. 总体架构

```
                         Internet
                            │ 443 / 80（仅这两个端口对外）
                            ▼
                ┌───────────────────────────┐
                │ nginx  (a.b.com, TLS)       │  限流 / WebSocket 透传 / 屏蔽 admin RPC 路径
                └───┬───────────────┬───────┘
      "/", "/api/"  │               │  "/t/<id>/"（按 map 文件查端口）
                    ▼               ▼
        ┌────────────────┐   ┌───────────────────────────┐
        │ nexus-portal    │   │ oc-<id>  容器 × N            │
        │ 127.0.0.1:8080  │   │ 127.0.0.1:<port> → :18789   │
        │ 无特权           │   │ Gateway + Chromium + Nexus   │
        └───┬───────┬────┘   └───────────────────────────┘
            │       │                     ▲        ▲
  Unix socket│       │ loopback HTTP       │        │ 出站：模型网关 / Telegram / WhatsApp / 网页
            ▼       └─ admin RPC ─────────┘        │
 ┌─────────────────────┐                           ▼
 │ nexus-provisioner    │  Docker Engine      平台模型网关（LiteLLM 类，发限额虚拟 key）
 │ root，仅本机 socket    │  XFS 配额 / 备份
 └─────────────────────┘
   Postgres（portal 数据；试点可用 SQLite）
```

要点：

1. **portal 与 provisioner 分成两个进程。** portal 面向公网，要被当成最容易出问题的组件，所以它**不碰 docker.sock**；需要建/停容器时，通过本机 Unix socket 调 provisioner，provisioner 只暴露固定的几个动词（create / start / stop / restart / upgrade / backup / delete / logs / exec-whitelist），参数全部校验（租户 id 正则 `^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$`、档位白名单）。这样 portal 被攻破也拿不到任意容器或宿主 root。
2. **租户容器只发布到宿主 `127.0.0.1`。** 公网只能通过 nginx 到达；nginx 之外没有任何租户端口暴露。
3. **admin RPC 只走回环。** portal 通过 `127.0.0.1:<port>` 调租户的 admin-http-rpc（见 §8、§12），nginx 对 `/t/<id>/api/v1/admin/` 直接返回 404，用户即使拿着 token 也不能通过公网调这个口。
4. **不使用 Cloudflare / trusted-proxy。** nginx 对租户路径只转发，不注入身份头；网关自己校验 token。这也意味着源站 IP 直接暴露，DDoS 防护靠云厂商自带能力和 nginx 限流（§12.5）。

---

## 3. 宿主机准备（Linux）

### 3.1 规格与操作系统

- Ubuntu 24.04 LTS（或同级 LTS），内核 ≥ 5.15；Docker Engine ≥ 25，使用 `overlay2`。
- 试点机器建议 **16 vCPU / 64 GB 内存 / 1 TB NVMe**。容量按"每租户 4 GB 内存上限、平均实际占用远低于上限"估算，**约 20–30 个活跃租户**；这是估算，容量数字要由 spike 的实测（V4）修正，不要拿它对外承诺。
- 开 2–4 GB swap 作为宿主缓冲，但**容器自身关 swap**（`--memory-swap` 等于 `--memory`），避免某个租户的 Chromium 把宿主拖进抖动。

### 3.2 磁盘与配额

租户状态目录放在独立 XFS 分区，开启项目配额（`prjquota`），每个租户一个 project id，用 `xfs_quota` 限制硬上限（见 §5.3 档位表）。ext4 也能用 `quota`，但 XFS project quota 对"一个目录树一个额度"最直接。

```bash
# /etc/fstab（示例）
/dev/nvme1n1p1  /srv/nexus  xfs  defaults,prjquota  0 2

# 给某租户设 20 GB 硬上限（provisioner 在 create 时执行）
xfs_quota -x -c "project -s -p /srv/nexus/cells/u7k2m9q4xp 1042" /srv/nexus
xfs_quota -x -c "limit -p bhard=20g 1042" /srv/nexus
```

### 3.3 目录布局

```
/srv/nexus/
  cells/<id>/              租户状态目录 → 容器内 /home/node/.openclaw（属主 uid 1000）
    openclaw.json            网关配置（由 portal/provisioner 渲染 + 之后 config.patch 改动）
    workspace/               Agent 工作区
    plugins/nexus-agent-core/nexus.sqlite   Nexus 数据库
    plugins/nexus-agent-core/vault/         个人文件柜
    …(WhatsApp 登录态、会话、日志等)
  env/<id>.env             租户环境变量文件（0600 root）：含网关 token
  backups/<id>/<时间>.tar.zst
  portal/                  portal 的数据库与密钥（0700 portal 用户）
/etc/nexus/
  master.key               portal 加密数据库里敏感字段用的主密钥（0400）
  portal.env               portal 配置（域名、DB 连接串、LiteLLM 管理 key…）
/etc/nginx/nexus/
  tenants.map              由 portal 生成：租户 id → 端口
```

### 3.4 防火墙与出站隔离

对外只开 22（限源 IP 或走堡垒机）、80、443。

租户容器有浏览器，**SSRF 与内网探测是首要风险**：Agent 被提示注入后，可能被诱导去访问云厂商元数据服务（`169.254.169.254`）、宿主上的服务或别的租户。因此给租户网段加出站过滤：

```json
// /etc/docker/daemon.json
{
  "default-address-pools": [{ "base": "172.30.0.0/12", "size": 28 }],
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" },
  "live-restore": true
}
```

```bash
# 租户网桥地址池：172.30.0.0/12（每租户一个 /28，见 daemon.json）
T=172.30.0.0/12
# 1) 容器不能访问宿主本机服务（portal、ssh 等），只放行已建立连接
iptables -I INPUT -s $T -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT -s $T -j DROP
# 2) 容器不能访问任何私网段、链路本地（含云元数据）、也不能互访
for NET in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 169.254.0.0/16 100.64.0.0/10; do
  iptables -I DOCKER-USER -s $T -d $NET -j DROP
done
# 3) 例外：到平台模型网关（若在内网）的单点放行，放在上面 DROP 之前
iptables -I DOCKER-USER -s $T -d <模型网关内网IP> -p tcp --dport 4000 -j ACCEPT
```

> 规则顺序很关键：放行例外要插在 DROP 前面。规则落地用 `iptables-persistent` 或 nftables 等价配置；改完要在宿主上用一个测试容器验证：能访问公网、不能访问 `169.254.169.254`、不能访问宿主 `:8080`、两个租户之间 ping 不通。

出站目的地**不做域名白名单**：Agent 要浏览任意网站，白名单做不了；只挡内网和元数据。

---

## 4. 镜像

### 4.1 构建

镜像基于私有 fork 的仓库根目录 `Dockerfile`（上游提供的构建参数）：

| 构建参数                      | 取值                                                              | 作用                                                                                                                                                                                |
| ----------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `OPENCLAW_INSTALL_BROWSER`    | `1`                                                               | 安装 Chromium + Xvfb（上游发布的 browser 变体就是这个）                                                                                                                             |
| `OPENCLAW_EXTENSIONS`         | `nexus-agent-core telegram whatsapp`（空格分隔）**【待验证 V1】** | 选择打进镜像的扩展。需确认：这个参数是否按目录名选择、是否允许同时带上私有 fork 的 `extensions/nexus-agent-core`、Telegram 与 WhatsApp 是否本来就随镜像（若本来就带，则只需 Nexus） |
| `OPENCLAW_IMAGE_APT_PACKAGES` | 按需，如 `fonts-noto-cjk`（中文页面渲染）、`ffmpeg`               | 额外系统包                                                                                                                                                                          |

```bash
# 在 fork 仓库根目录，tag 里同时带上 OpenClaw 基线版本和 Nexus 版本
OC_VER=$(node -p "require('./package.json').version")
NX_VER=$(node -p "require('./extensions/nexus-agent-core/package.json').version")
docker build \
  --build-arg OPENCLAW_INSTALL_BROWSER=1 \
  --build-arg OPENCLAW_EXTENSIONS="nexus-agent-core telegram whatsapp" \
  --build-arg OPENCLAW_IMAGE_APT_PACKAGES="fonts-noto-cjk" \
  -t nexus-openclaw:${OC_VER}-nx${NX_VER} .
docker tag nexus-openclaw:${OC_VER}-nx${NX_VER} nexus-openclaw:stable   # 发布通道指针
```

单机阶段不需要镜像仓库；多机时放到私有 registry。

### 4.2 把 Nexus 打进镜像（而不是运行时 `plugins install`）的理由

- Nexus 随镜像成为**内置（trusted）插件**：不再需要 `gateway.controlUi.experimental.customPlugins=true` 才能在左侧看到 Nexus 页面，也能使用只对内置/官方安装开放的 `evidenceBlobsEnabled`（证据原文，第三方安装会被降级，见安装演示文档 §2.2）。
- 升级就是换镜像 tag，回滚就是换回旧 tag；不会出现"容器重建后插件配置被重置"（卸载/重装会把插件配置重置，见交付文档）。

### 4.3 镜像验收（每次构建都跑）

```bash
IMG=nexus-openclaw:${OC_VER}-nx${NX_VER}
docker run --rm $IMG node dist/index.js --version
docker run --rm $IMG node dist/index.js plugins list | grep -Ei 'nexus|telegram|whatsapp'
docker run --rm $IMG sh -c 'command -v chromium || command -v chromium-browser'
```

再起一个临时租户跑 §16 的冒烟清单后，才允许打 `stable` 标签。

---

## 5. 租户容器规格

### 5.1 `docker run`（由 provisioner 生成，等价于上游 fleet 的安全轮廓 + 我们的资源与浏览器调整）

```bash
docker network create nexus-net-<id>

docker run -d --name oc-<id> --hostname oc-<id> \
  --restart unless-stopped --init \
  --network nexus-net-<id> \
  -p 127.0.0.1:<port>:18789 \
  --cap-drop ALL --security-opt no-new-privileges \
  --pids-limit 1024 \
  --memory <mem> --memory-swap <mem> --cpus <cpus> \
  --shm-size 512m \
  --env-file /srv/nexus/env/<id>.env \
  -v /srv/nexus/cells/<id>:/home/node/.openclaw \
  --label nexus.tenant=<id> --label nexus.plan=<plan> \
  nexus-openclaw:<tag> \
  node dist/index.js gateway --bind lan --port 18789
```

逐项说明：

- `--bind lan --port 18789`：容器内监听所有接口，但宿主只发布到 `127.0.0.1:<port>`，所以对公网不可达。
- `--cap-drop ALL`、`no-new-privileges`、`--init`：上游 fleet 的默认轮廓。**不挂 docker.sock、不用 `--privileged`、不用 host 网络。**
- `--pids-limit 1024`：上游默认 512；Chromium 多进程，翻倍。
- `--memory/--cpus`：上游默认 2g/2 核，**带 Chromium 偏小**，按 §5.3 档位。
- `--shm-size 512m`：Docker 默认 `/dev/shm` 只有 64 MB，Chromium 渲染大页面会崩；这是常见坑。
- **Chromium 沙箱**：`--cap-drop ALL` + 默认 seccomp 下 Chromium 自带沙箱起不来，需在租户配置里设置 `browser.noSandbox: true`（由容器本身充当沙箱）**【待验证 V4/V8】**。这条是用安全换可用，所以出站隔离（§3.4）和无特权（本节）不能省。
- 每租户一个桥接网络：租户之间二层不通。
- 重启策略 `unless-stopped`：宿主重启后租户自动恢复；用户主动"停止"是 portal 调 `docker stop`，宿主重启后**不会**被拉起（符合"停止"的语义）。

### 5.2 环境变量文件 `/srv/nexus/env/<id>.env`（0600，root）

```
HOME=/home/node
OPENCLAW_HOME=/home/node
OPENCLAW_STATE_DIR=/home/node/.openclaw
OPENCLAW_CONFIG_PATH=/home/node/.openclaw/openclaw.json
OPENCLAW_WORKSPACE_DIR=/home/node/.openclaw/workspace
XDG_CACHE_HOME=/home/node/.openclaw/.cache
OPENCLAW_GATEWAY_TOKEN=<48 位随机十六进制>
```

token 必须放在 env 文件里，**不要**写进 `docker run` 命令行（会出现在 `docker inspect` 和进程列表里）。轮换 token = 改 env 文件 + 重建容器（见 §11.3）。

### 5.3 资源档位（假设值，待 spike 校准）

| 档位               | 内存 | CPU | 磁盘硬上限 | 说明                                     |
| ------------------ | ---- | --- | ---------- | ---------------------------------------- |
| `lite`             | 3 GB | 1   | 5 GB       | 试用：浏览器能开，但同时开多个标签易 OOM |
| `standard`（默认） | 4 GB | 2   | 20 GB      | 日常                                     |
| `pro`              | 6 GB | 3   | 50 GB      | 文件柜大、长任务多                       |

- 档位表放在 portal 配置里，邀请码可以绑定档位（见 §6 `invite_codes.plan`）。
- 宿主总量按 **内存超卖不超过 1.5–2 倍** 估计；portal 创建租户前检查宿主剩余额度（已分配上限之和 ≤ 宿主内存 × 超卖系数），不够就拒绝并提示"当前名额已满"（等同候补）。
- 内存是硬限制：超限时 Linux 杀的是容器内进程（通常是 Chromium），网关一般还在；portal 要把 `docker events` 里的 `oom` 事件记入审计并在用户侧显示"浏览器因内存不足被重启"。

---

## 6. 前置服务的数据模型

Postgres（试点可用 SQLite 单文件，表结构不变）。敏感字段（token、BYOK key、Telegram bot token）用主密钥做 AES-256-GCM 加密后存，列名带 `_enc`。

```sql
CREATE TABLE users (
  id            uuid PRIMARY KEY,
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,                 -- argon2id
  status        text NOT NULL DEFAULT 'active',-- active | suspended | deleted
  invite_id     uuid REFERENCES invite_codes(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE invite_codes (
  id          uuid PRIMARY KEY,
  code_hash   text UNIQUE NOT NULL,            -- 只存哈希；明文只在创建时展示一次
  label       text,                            -- 谁/哪批
  plan        text NOT NULL DEFAULT 'standard',
  max_uses    int  NOT NULL DEFAULT 1,
  used_count  int  NOT NULL DEFAULT 0,
  expires_at  timestamptz,
  disabled_at timestamptz,
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenants (
  id            text PRIMARY KEY,              -- 如 u7k2m9q4xp，符合 ^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$
  user_id       uuid UNIQUE NOT NULL REFERENCES users(id),
  plan          text NOT NULL,
  state         text NOT NULL,                 -- 见 6.1
  host_id       text NOT NULL DEFAULT 'h1',    -- 多机时用
  port          int  UNIQUE NOT NULL,          -- 宿主回环端口，池 20000–29999
  image_tag     text NOT NULL,
  token_enc     bytea NOT NULL,                -- 网关 token（加密）
  token_version int  NOT NULL DEFAULT 1,
  config_rev    int  NOT NULL DEFAULT 1,       -- 租户配置迁移版本（§11.1）
  project_id    int  UNIQUE NOT NULL,          -- XFS 配额 project id
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_health_at timestamptz,
  last_error    text
);

CREATE TABLE model_configs (
  tenant_id     text PRIMARY KEY REFERENCES tenants(id),
  mode          text NOT NULL DEFAULT 'platform', -- platform | byok
  provider      text,                              -- byok：供应商标识
  base_url      text,                              -- byok：自定义地址
  key_enc       bytea,                             -- byok：用户 key
  llm_key_id    text,                              -- platform：模型网关里的虚拟 key id
  monthly_budget_usd numeric                       -- platform：月预算（上限）
);

CREATE TABLE channel_bindings (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  channel     text NOT NULL,                  -- telegram | whatsapp
  state       text NOT NULL,                  -- unbound | awaiting_token | awaiting_pairing | awaiting_scan | bound | error
  display     text,                           -- @bot 用户名 / 脱敏手机号
  secret_enc  bytea,                          -- Telegram bot token（加密）
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, channel)
);

CREATE TABLE usage_daily (
  tenant_id text, day date, tokens_in bigint, tokens_out bigint, cost_usd numeric,
  PRIMARY KEY (tenant_id, day)
);

CREATE TABLE jobs (                              -- 开通/升级/备份等异步任务，可重试、可恢复
  id uuid PRIMARY KEY, tenant_id text, type text, state text,
  attempts int DEFAULT 0, error text, payload jsonb,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);

CREATE TABLE sessions (id text PRIMARY KEY, user_id uuid, expires_at timestamptz, ip inet, ua text);
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY, ts timestamptz DEFAULT now(),
  actor text, action text, tenant_id text, ip inet, detail jsonb
);
```

### 6.1 租户状态机

```
(无) ──注册──► provisioning ──健康检查通过──► running ◄──────────┐
                  │                              │ stop           │ start
                  │ 失败(可重试)                  ▼                │
                  ▼                           stopped ───────────┘
               failed                            │
                                running ─upgrade─► upgrading ─成功─► running
                                                      │失败
                                                      └─自动回滚─► running（旧 tag）+ last_error
              running/stopped ─delete─► deleting ─清理完成─► deleted（保留审计，状态目录按保留期清除）
```

provisioning 与 upgrading 都由 `jobs` 驱动，portal 重启后能从未完成的 job 继续；每一步幂等（容器已存在就跳过、配置已渲染就复用）。

---

## 7. nginx：路由与限流

### 7.1 路由规则

- `https://a.b.com/` 与 `/api/` → portal（`127.0.0.1:8080`）。
- `https://a.b.com/t/<id>/…` → 租户容器 `127.0.0.1:<port>`，**不改写路径**（容器里的 Gateway 自己挂在 `basePath=/t/<id>` 下）**【待验证 V2：控制台静态资源、WebSocket、`/healthz` 是否都在 basePath 之下，且网关不要求代理去掉前缀】**。
- `/t/<id>/api/v1/admin/` 一律 404（admin RPC 只给 portal 走回环）。
- 端口表由 portal 生成、provisioner 校验后写入 `tenants.map` 并 `nginx -s reload`（reload 是平滑的，已建立的 WebSocket 不断）。

### 7.2 配置

```nginx
# /etc/nginx/conf.d/nexus.conf
map $uri $tenant_id   { ~^/t/(?<t>[a-z0-9-]+)(/|$) $t;  default ""; }
map $tenant_id $tenant_port { include /etc/nginx/nexus/tenants.map; default 0; }
# tenants.map 每行形如：  u7k2m9q4xp 20042;

map $http_upgrade $connection_upgrade { default upgrade; '' close; }

limit_req_zone  $binary_remote_addr zone=auth:10m    rate=6r/m;    # 登录/注册
limit_req_zone  $binary_remote_addr zone=api:10m     rate=120r/m;  # 其他 portal API
limit_req_zone  $binary_remote_addr zone=tenant:10m  rate=20r/s;   # 租户路径新建请求（WS 握手也算）
limit_conn_zone $binary_remote_addr zone=perip:10m;

server {
  listen 80;  server_name a.b.com;
  return 301 https://$host$request_uri;
}

server {
  listen 443 ssl http2;  server_name a.b.com;
  ssl_certificate     /etc/letsencrypt/live/a.b.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/a.b.com/privkey.pem;
  add_header Strict-Transport-Security "max-age=31536000" always;
  add_header X-Content-Type-Options nosniff always;
  limit_conn perip 50;

  # ---- portal ----
  location = /api/v1/auth/login    { limit_req zone=auth burst=5 nodelay; include nexus/proxy_portal.conf; }
  location = /api/v1/auth/register { limit_req zone=auth burst=5 nodelay; include nexus/proxy_portal.conf; }
  location /api/                   { limit_req zone=api  burst=40 nodelay; include nexus/proxy_portal.conf; }
  location /                       { include nexus/proxy_portal.conf; }   # 门户前端

  # ---- 租户：先屏蔽 admin RPC（正则 location 按出现顺序匹配，必须放在通用租户规则之前）----
  location ~ ^/t/[a-z0-9-]+/api/v1/admin/ { return 404; }

  # /t/<id> → /t/<id>/
  location ~ ^/t/[a-z0-9-]+$ { return 301 $uri/; }

  location ~ ^/t/[a-z0-9-]+/ {
    if ($tenant_port = 0) { return 404; }
    limit_req zone=tenant burst=60 nodelay;
    client_max_body_size 64m;                     # 文件柜上传（分块上传时单块更小）
    proxy_pass http://127.0.0.1:$tenant_port;     # 带变量且不写 URI：原样转发完整路径
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_set_header X-Forwarded-For $remote_addr;   # 覆盖而不是追加，防伪造
    proxy_set_header X-Forwarded-Proto https;
    proxy_read_timeout 3600s;  proxy_send_timeout 3600s;
    proxy_buffering off;
  }
}
```

```nginx
# /etc/nginx/nexus/proxy_portal.conf
proxy_pass http://127.0.0.1:8080;
proxy_set_header Host $host;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
```

注意：

- 容器经 `docker-proxy` 收到的连接，源地址是网桥网关而不是真实客户端；网关侧若依赖客户端 IP（限速、审计），需配置 `gateway.trustedProxies` 指向该网关地址 **【待验证 V8】**。
- 单一证书用 certbot 的 HTTP-01 或 DNS-01 即可，不涉及通配符。

---

## 8. 租户初始配置

### 8.1 两步法：先写文件，再用 admin RPC 校验

1. **首次启动前**，provisioner 把渲染好的 `openclaw.json` 直接写进 `cells/<id>/`（属主 1000:1000）。这样容器第一次启动就是目标配置，不依赖"先启动再改"的竞态。
2. **启动后**，portal 通过回环调用租户的 admin RPC（`POST http://127.0.0.1:<port>/…/api/v1/admin/rpc`，`Authorization: Bearer <网关 token>`，请求体 `{"id","method","params"}`，上限 1 MB）做 `health`、`status`、`config.get` 校验；之后的运行期操作（改通道配置、扫码登录、设备批准）也走它。

> admin-http-rpc 插件**默认关闭**，且是完整 operator 面：只放回环，绝不暴露公网。它允许的方法包括 `health`、`status`、`config.get/set/patch/apply`、`channels.status/start/stop/logout`、`web.login.start/wait`、`device.pair.list/approve/reject/remove`、`agents.*`、`cron.*`、`models.list`、`usage.status/cost`、`gateway.restart.request`。启用方式（配置键）与它在 basePath 下的实际路径 **【待验证 V3】**。

### 8.2 `openclaw.json` 模板（节选；字段名以 `openclaw config schema` 为准 **【待验证 V8】**）

```jsonc
{
  "gateway": {
    "auth": { "mode": "token" }, // token 本体来自环境变量 OPENCLAW_GATEWAY_TOKEN，不落盘到 json
    "controlUi": {
      "basePath": "/t/<id>",
      "allowedOrigins": ["https://a.b.com"],
    },
    "trustedProxies": ["<该租户网桥的网关地址>"],
  },

  "browser": { "noSandbox": true }, // 容器 cap-drop ALL 下 Chromium 自带沙箱不可用，见 §5.1

  "plugins": {
    "entries": {
      "admin-http-rpc": { "enabled": true }, // 仅回环使用；启用键待 V3 确认
      "nexus-agent-core": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true }, // 不开则 Agent 看不到 Nexus 协议说明和进行中事项
        "config": {
          "tasksEnabled": true,
          "decisionsEnabled": true,
          "claimsEnabled": true,
          "preferencesEnabled": true,
          "watchersEnabled": true,
          "vaultEnabled": true,
          "evidenceBlobsEnabled": true, // 内置（trusted）安装才生效，见 §4.2
          "goalsEnabled": true,
          "fakeProviderMode": "ok", // 真实 Provider 还没做：保持模拟，不产生外部效果
          "fakeProviderIdempotent": true,
        },
      },
    },
  },

  // 整体替换而非追加：这里是 Nexus 的全部 29 个工具
  "tools": {
    "alsoAllow": [
      "nexus_task_reserve",
      "nexus_task_create",
      "nexus_task_get",
      "nexus_task_update",
      "nexus_task_note",
      "nexus_task_search",
      "nexus_action_prepare",
      "nexus_action_authorize",
      "nexus_decision_request",
      "nexus_action_commit",
      "nexus_claim_add",
      "nexus_evidence_add",
      "nexus_claim_verify",
      "nexus_preference_get",
      "nexus_preference_set",
      "nexus_preference_confirm",
      "nexus_watch_create",
      "nexus_watch_cancel",
      "nexus_watch_report",
      "nexus_file_search",
      "nexus_file_get",
      "nexus_file_attach",
      "nexus_goal_search",
      "nexus_goal_get",
      "nexus_goal_create",
      "nexus_goal_propose",
      "nexus_goal_entry_add",
      "nexus_goal_link",
      "nexus_goal_review",
    ],
  },

  // models / channels 两块见 §8.3 与 §10
}
```

说明：

- 以上等价于 Mac 安装器的 "Nexus 预设"（启用插件 + 打开开关 + 固定模拟 Provider + 追加工具白名单）。**Docker 里没有"每个预设版本只应用一次"的标记文件机制**：provisioner 在创建租户时一次性渲染；之后升级镜像**不会**自动改已有租户的开关，需要新开关时由 portal 发 `config.patch`（升级流程见 §11.1）。
- 如果以后 Nexus 开关默认值或工具清单变化，渲染模板和 `tools.alsoAllow` 清单要同步更新，并建一个脚本从插件 `openclaw.plugin.json` 生成清单，避免手写漏项。
- `evidenceBlobsEnabled` 随内置安装生效；若 V1 验证发现 Nexus 没能作为内置扩展打进镜像，就要回到 `customPlugins=true` + 第三方安装路径，并关掉 `evidenceBlobsEnabled`。

### 8.3 模型接入：平台默认 + 用户自带

**默认（`mode=platform`）**：平台在内网放一个 OpenAI 兼容的模型网关（LiteLLM 一类），真实供应商 key 只在网关里。开通时：

1. portal 调网关管理接口为该租户生成**虚拟 key**，带月预算、RPM/TPM 限制和可用模型清单（LiteLLM 的 `POST /key/generate`，字段 `max_budget`、`budget_duration`、`models`、`rpm_limit`、`tpm_limit`）；
2. 把 `base_url=https://llm.internal/v1` 与这把虚拟 key 渲染进租户 `openclaw.json` 的模型配置块（结构按 schema 填）；
3. portal 每日拉取用量写 `usage_daily`；预算用完网关会拒绝请求，portal 在用户页显示"本月额度已用完"，并允许管理员加额度或用户切 BYOK。

**为什么发虚拟 key 而不是真实 key**：2026.10.10 起上游**不再在模型上下文、会话转录、界面里遮盖 secrets**——租户里的 Agent、转录和备份都可能看到配置里的 key。虚拟 key 泄露的最坏后果是被限额和可撤销；真实 key 泄露就是整个平台。

**自带（`mode=byok`）**：用户在 portal 填 `provider / baseUrl / apiKey`，portal 先用它做一次最小调用验证，再 `config.patch` 写进租户配置；key 在 portal 里加密留底（便于重建容器时恢复）。切回平台默认只需再 `PUT` 一次。

两点要对用户说清楚：BYOK 的 key 对**他自己的 Agent 是可见的**；用户也可以直接在控制台里改模型，portal 的记录只是"最后一次经过 portal 的设置"，**以租户里的 `config.get` 为准**。

---

## 9. 开通流程

### 9.1 角色与前提

- 运营在管理端生成邀请码（`POST /api/v1/admin/invites`），发给用户。邀请码只存哈希，明文仅创建时返回一次，可设次数、有效期、绑定档位。
- 邀请码阶段**不做邮箱验证**（邀请码本身就是准入凭证）；开放注册前再加邮箱验证和人机校验。

### 9.2 端到端时序

```
用户浏览器                    nginx            portal                 provisioner / Docker           租户 oc-<id>
   │ 打开 https://a.b.com/      │                 │                          │                          │
   │ 填 邮箱+密码+邀请码         │                 │                          │                          │
   ├──POST /api/v1/auth/register────────────────►│                          │                          │
   │                            │                 │ ① 事务：校验邀请码(哈希、未过期、次数)           │
   │                            │                 │    建 users、tenants(provisioning)、jobs         │
   │                            │                 │    used_count+1；分配 id / 端口 / project_id     │
   │◄─────────201 + 会话 cookie + tenant{state:provisioning}                                          │
   │                            │                 │ ② job 开始（异步）                               │
   │                            │                 ├─create(id,plan,tag)────►│ 建目录+XFS 配额         │
   │                            │                 │                          │ 写 env(token)、openclaw.json
   │                            │                 ├─模型网关：生成虚拟 key（platform 模式）            │
   │                            │                 │                          │ 建网桥、docker run ──────►│ 启动
   │                            │                 │ ③ 轮询 /healthz（≤120s）──────────────────────────►│
   │                            │                 │ ④ admin RPC：health / status / config.get 校验 ───►│
   │                            │                 ├─sync-routes(map)───────►│ 写 tenants.map，nginx reload
   │                            │                 │ ⑤ tenants.state=running                          │
   │ GET /api/v1/me/instance（每 2s 轮询）──────────►│                          │                          │
   │◄──────────{state:running, url:"https://a.b.com/t/<id>/"}                                           │
   │ 进入"连接"页：地址 + token + 三种连接方式                                                          │
```

首次开通预计 **30–90 秒**（容器创建 + 网关冷启动 + 浏览器组件就绪；估计值，spike 实测后写进 UI 文案）。

### 9.3 provisioning 任务的步骤清单（每步幂等、可重试、失败可回收）

| #   | 步骤                                                                                             | 失败时                                                                       |
| --- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| 1   | 分配 `id`（随机 10 位 `[a-z2-7]`，加 `u` 前缀）、端口（池 20000–29999 取最小空闲）、`project_id` | 事务回滚，邀请码次数不扣                                                     |
| 2   | 创建 `cells/<id>`，属主 1000:1000，设 XFS 配额                                                   | 删目录，重试                                                                 |
| 3   | 生成 token（`openssl rand -hex 24`），写 `env/<id>.env`（0600）                                  | 覆盖重写                                                                     |
| 4   | 虚拟 key（platform 模式）                                                                        | 模型网关不可用时：租户先以"无模型"状态起来，后台重试，用户页提示"模型未就绪" |
| 5   | 渲染 `openclaw.json`                                                                             | 覆盖重写                                                                     |
| 6   | 建网桥、`docker run`                                                                             | 已存在就 `start`；起不来则回收容器与网桥，重试 ≤3 次                         |
| 7   | 等 `/healthz`                                                                                    | 超时则抓 `docker logs --tail 200` 存入 `last_error`，状态 `failed`           |
| 8   | admin RPC 校验（`health`；`config.get` 确认 Nexus 插件启用）                                     | 同上                                                                         |
| 9   | 同步路由并 reload                                                                                | 路由未生效则不置 `running`                                                   |
| 10  | 置 `running`，写审计                                                                             | —                                                                            |

`failed` 的租户不自动删除：运营可在管理端点"重试"或"回收"；回收时释放端口、停止并删除容器与网桥，状态目录按保留期清理。

### 9.4 用户第一次进入后

"连接"页展示三块（对应第 10 章）：

1. **远程访问**：地址 `https://a.b.com/t/<id>/`、token（默认遮盖，点"显示"需再次输入登录密码）、"打开网页控制台"、Mac App 连接说明；
2. **Telegram**：状态 + "开始绑定"向导；
3. **WhatsApp**：状态 + "开始绑定"向导。

三者彼此独立：只用网页控制台、不绑 Telegram/WhatsApp 也完全可以。

---

## 10. 三种连接方式

### 10.1 远程访问（Mac App / 网页控制台）

**网页控制台**

- 地址：`https://a.b.com/t/<id>/`，首次打开粘贴 token。portal 的"打开网页控制台"按钮可以把 token 放在 URL 的 `#` 片段里一次性带过去（片段不会发给服务器、不进 nginx 日志）**【待验证 V6：控制台支持的免输入登录形式；不支持就只展示"复制 token"】**。
- 要用 BR-02 的接手功能（用户在 Agent 浏览器里完成登录/MFA/验证码）：控制台的 **Browser 面板**渲染的就是 Gateway 控制的浏览器，用户可以键入和粘贴；需要 `operator.admin` 连接并声明 `browser.request`。token 登录是否满足这个范围 **【待验证 V6】**。

**Mac App**

1. 首次启动选 "Connect to an existing Gateway"（已装过的用户：连接 → Gateways → Add Gateway）。
2. 地址填 `https://a.b.com/t/<id>/`（App 接受带完整 base path 的地址）；认证方式选 **Token**，粘贴 portal 里的 token。"浏览器登录"只支持 Cloudflare Access，**本方案不用**。
3. 原生 operator 设备首次连接可能需要一次性批准（取决于网关的自动设备批准策略）。为避免用户卡在这一步，portal 提供"待批准设备"列表和一键批准（`device.pair.list/approve`，见 §13 的 `/me/devices`）。**【待验证 V6】**
4. 需要 macOS 15+（2026.10.4 起）。

**需要新开发：Mac App 的"纯客户端"构建**。现在的安装器会带本地 launchd 网关和 Nexus 预设；远程模式应当：不安装本地网关、首次启动直达"连接已有网关"、不再烘焙 Nexus 预设（预设已在服务端渲染）。这是客户端任务，不在 Docker 部署范围内，但没有它"Mac App 连服务器"的体验会是"装了本地网关再改去连远程"。

**设备与 token 的关系**：token 是该实例的共享口令；设备首次连接后网关会为设备建立各自的配对身份，可以用 `device.pair.remove` 单独撤销某台设备（portal 的 `DELETE /me/devices/{id}`）。**token 轮换会让所有已连接客户端断开重登**（§11.3）。

### 10.2 Telegram

**设计前提**：每个租户一个**自己的 bot**。OpenClaw 没有跨租户共享 bot 或入口路由；而且同一个 bot token 不能同时被两个长轮询方使用（会互相踢掉）。所以 bot 必须 per-tenant，由用户在 Telegram 的 `@BotFather` 里创建——**这一步无法自动化**，只能做引导。

**传输方式**：默认长轮询——只需要容器**出站**访问 `api.telegram.org`，不需要入站端口，也就不需要给每个租户配 webhook 路由。本方案不用 webhook。

**绑定向导**（portal 页面，对应 API 见 §13）：

| 步骤         | 用户做什么                                                                                | portal 做什么                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 创建 bot   | Telegram 里找 `@BotFather` → `/newbot` → 取名字和以 `bot` 结尾的用户名 → 复制它给的 token | 页面给出图文引导（可选：提醒用 `/setjoingroups` 关掉拉群，减少暴露面）                                                                                                                                                                                    |
| 2 提交 token | 粘贴到 portal                                                                             | `getMe` 验证 token 有效并取得 `@用户名`；加密保存；通过 admin RPC `config.patch` 写入 `channels.telegram`（`enabled=true`、`botToken`、`dmPolicy="pairing"`），然后 `channels.status` 轮询到"运行中"。状态 → `awaiting_pairing` **【待验证 V8：字段名】** |
| 3 配对       | 在 Telegram 里打开自己的 bot，发 `/start` 或任意消息；bot 回复一个**配对码**              | 页面提示配对码；用户把码填回 portal                                                                                                                                                                                                                       |
| 4 批准       | 把配对码填到 portal（或在控制台 Settings → Channels → DM access requests 里批准）         | provisioner 白名单动词在容器内执行 `pairing approve telegram <CODE>`（码按 `^[A-Z0-9]{4,12}$` 校验后才传入）。成功 → 状态 `bound`，`display=@用户名` **【待验证 V9】**                                                                                    |
| 5 验证       | 在 Telegram 里发一句话                                                                    | 页面显示最近一次收发时间；Agent 正常回复即成功                                                                                                                                                                                                            |

要点：

- **配对就是 CH-02 的"把平台主体绑定到 owner"**：批准之后，这个 Telegram 账号才算该租户的 owner；其他人给 bot 发消息只会得到配对码、不会被执行。
- **CH-03（内联按钮审批）**：是否允许在 Telegram 里直接点按钮批准，由 Nexus 的载荷绑定规则决定，部署层不再加开关；不满足条件时回落到"需登录的网页决策链接"，即第 10.1 节的控制台地址。
- **出站网络**：服务器所在区域必须能访问 `api.telegram.org`。若服务器在无法访问 Telegram 的网络环境，需要另配出站代理，不在本方案范围内。
- **解绑**：portal `DELETE /me/channels/telegram` → `config.patch` 关闭并清除 token，同时提示用户去 `@BotFather` 里 `/revoke` 旧 token。
- **bot token 的安全**：存在 portal 数据库（加密）和租户配置里；它能代表 bot 发消息，泄露的后果是 bot 被冒用，用户可以随时 `/revoke`。

### 10.3 WhatsApp

**设计前提**：OpenClaw 的 WhatsApp 通道走 Baileys（WhatsApp Web **关联设备**协议），**没有**官方 Business API 或 Twilio 通道；登录只能扫二维码。每个租户一个关联设备。

**强烈建议用户使用专用号码**（副号或 eSIM），不要用主号：这是非官方协议，号码有被限制的风险（见 §16）。

**绑定向导**：

| 步骤           | 用户做什么                                                                     | portal 做什么                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 同意风险提示 | 勾选"我理解 WhatsApp 关联设备属于非官方接入，号码可能被限制，建议使用专用号码" | 记录审计                                                                                                                                                                            |
| 2 请求二维码   | 点"生成二维码"                                                                 | admin RPC `web.login.start`（通道 whatsapp）取得二维码，转成图片/字符串返回前端；状态 → `awaiting_scan` **【待验证 V5】**                                                           |
| 3 扫码         | 手机 WhatsApp → 设置 → **已关联设备** → **关联设备** → 扫页面二维码            | 前端每 2–3 秒轮询；portal 用 `web.login.wait`（短超时）取状态：`waiting_scan` / `scanned` / `connected` / `expired` / `error`。二维码会周期性刷新，前端自动换图；过期则提示重新生成 |
| 4 配对         | 用**自己的个人号码**给这个专用号码发一条消息，收到配对码                       | 页面提示填码；`pairing approve whatsapp <CODE>`（同样走 provisioner 白名单动词）。配对请求 **1 小时过期**，每个账号**最多 3 个待处理**                                              |
| 5 验证         | 再发一句话                                                                     | 状态 `bound`，`display` 为脱敏手机号（如 `+86 138****0000`）                                                                                                                        |

要点：

- **登录态很重要**：WhatsApp 的认证目录在租户状态目录里。丢了就必须重新扫码，所以备份要包含它（§11.2）；备份里有会话密钥，**备份文件必须加密**。
- **如果最新版不再通过 `web.login.*` 暴露二维码**（本地 2026.9.4 文档说控制台 Channels 页面支持扫码登录，最新版文档摘要没有确认），退路是：portal 只显示说明，并把用户引到控制台的 Channels 页面 `…/t/<id>/` 扫码；portal 仅负责读状态。**【待验证 V5】**
- **掉线处理**：`channels.status` 显示被登出（例如在手机上手动"退出关联设备"）→ portal 置 `error`，在连接页显示"需要重新扫码"。不要自动反复重连。
- **解绑**：`DELETE /me/channels/whatsapp` → `channels.logout`，并清理认证目录。
- **DM 策略**：默认 `pairing`（满足 CH-02）；也可以在向导里提供"只允许我的号码"（`allowlist` + 用户填写的 E.164 号码）作为更简单的选项。
- **风险提示要写进产品**：数据中心 IP、批量/陌生人发送、短时间大量消息都会提高被限制的概率；Nexus 不应在 WhatsApp 上做主动群发。

---

## 11. 生命周期运维

### 11.1 升级与回滚

升级的单位是**镜像 tag**（OpenClaw 基线版本 + Nexus 版本，见 §4.1）。上游已移除 `openclaw fleet`，"带 `/healthz` 门禁的回滚"这个思路要自己实现：

```
upgrade(id, newTag):
  1. 读取 oldTag；若 backup=true，先停机备份（§11.2）
  2. docker stop -t 60 oc-<id>               # 给网关优雅退出时间
  3. docker rm oc-<id>                       # 状态目录与 env 不动
  4. docker run … nexus-openclaw:<newTag>    # 参数与原来完全一致（§5.1）
  5. 轮询 /healthz，≤90s；admin RPC health + config.get 确认 Nexus 插件已启用
  6. 失败 → docker rm；docker run … <oldTag>；tenants.state=running，last_error 记原因，审计 upgrade_rolled_back
     成功 → tenants.image_tag=newTag；按需执行"配置迁移脚本"（见下）
```

- **分批发布**：先 1 个内部租户（金丝雀）→ 约 10% → 全部；每批并发数受限（例如同时最多 3 个），每批之间看健康检查和错误率。管理端 `POST /admin/rollout`。
- **配置迁移**：新版本如果新增了配置键或 Nexus 增加了开关，租户已有的 `openclaw.json` 不会自动改。做法：在 `tenants` 表里记 `config_rev`，portal 内置"rev N → N+1"的迁移脚本（用 admin RPC `config.patch` 执行），升级成功后按序执行。
- **数据库向前迁移与回滚**：Nexus 的 `nexus.sqlite` 在新版本启动时可能被迁移到新 schema，旧镜像不一定能读新库。所以"升级前备份"是回滚的真正保障：回滚到旧 tag 若发现库不兼容，要连同备份一起恢复。Nexus 每次改 schema 都应在发布说明里标明"是否可回退"。
- **每次升级前**必须先过 §16.2 的冒烟清单（在一个临时租户上）。

### 11.2 备份与恢复

上游口径：**备份要在租户停止时做**（SQLite、WhatsApp 登录态等需要一致性）。对"Agent 常驻、用户离开也不应停止"（BR-03）的产品，这意味着有短暂维护窗口：

- 每个租户每天一次，错峰排期（默认当地时间 03:00–05:00，按租户错开）；执行前通过 `status` 检查是否有进行中的运行，有则顺延，最多顺延到窗口结束然后跳过并告警。
- 流程：`docker stop -t 60` → `tar --zstd` 状态目录（排除 `.cache`；**保留**浏览器登录态目录，因为 BR-02 的登录接手成果在里面）→ `age` 公钥加密 → `docker start` → 等 `/healthz`。停机时长通常是秒到一分钟量级（估计，spike 实测）。
- 保留：7 个日备 + 4 个周备；加一份**异地**拷贝（S3 兼容存储）。加密私钥离线保管，不放在宿主上。
- **恢复**：停租户 → 当前目录改名留存 → 解密解压到 `cells/<id>` → 校正属主与 XFS 配额 → 启动 → 健康检查 → 通道状态核对（WhatsApp 登录态可能因手机侧变化失效，需要重扫）。**每月做一次恢复演练**，否则备份等于没有。
- 备份里包含转录和会话中的明文 secrets（2026.10.10 起不再遮盖）、WhatsApp 会话密钥、Agent 浏览器登录态——是整个系统最敏感的数据，访问需要审计，且不得放在任何用户可达的位置。
- 后续优化：把 `cells` 放到支持快照的文件系统（ZFS / btrfs / LVM thin）做崩溃一致快照，避免停机；这与上游"停机备份"的口径不同，需要先验证 SQLite WAL 与 WhatsApp 凭据在快照点上的可恢复性再启用。

### 11.3 token 轮换与找回

- **轮换**：`POST /me/instance/token/rotate`（需重新输入密码）。流程：生成新 token → 写 `env/<id>.env` → **重建容器**（`docker restart` 不会重读 env 文件）→ `token_version++`。旧 token 立即失效，所有已连接的 Mac App / 网页控制台需要重新登录；Telegram / WhatsApp 的连接状态在状态目录里，重建后会自动恢复。停机约 10–30 秒（估计）。
- **找回**：用户忘了 token 不需要找回，登录 portal → "显示 token"（需再输密码，审计记录）。
- 怀疑泄露 → 立刻轮换；管理员也可以对任意租户强制轮换。

### 11.4 停止 / 重启 / 重置 / 删除

| 操作        | 实现                               | 说明                                                                                                             |
| ----------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 停止        | `docker stop`，`state=stopped`     | 用户主动停止期间，Agent、定时器、回检都不运行（与 BR-03 不冲突：这是用户的明确动作）。宿主重启后**不会**自动拉起 |
| 启动 / 重启 | `docker start` / `docker restart`  | `restart` 不换环境变量；换 token/档位用"重建"                                                                    |
| 变更档位    | 管理员 `PATCH /admin/tenants/{id}` | 更新内存/CPU/磁盘配额并重建容器                                                                                  |
| 重置实例    | `POST /me/instance/reset`          | 停止 → 备份 → 清空状态目录 → 重渲染配置 → 启动；通道需重新绑定                                                   |
| 删除账号    | `DELETE /me`                       | 见下                                                                                                             |

**删除的顺序**：确认（密码 + 输入 `DELETE`）→ 若已绑定 WhatsApp 先 `channels.logout`（解除手机上的关联设备）→ 停止 → 最后一次备份（保留 30 天，用户选"立即彻底清除"则不留）→ 删容器与网桥 → 吊销平台虚拟 key → 从 `tenants.map` 移除并 reload → 释放端口 → 状态目录与备份按保留期清理（`purge`）→ 审计保留。同时提示用户去 `@BotFather` 吊销 bot token。

停止后访问 `/t/<id>/` 会得到 502，nginx 用 `error_page 502 504 = @tenant_down;` 转到 portal 的一个静态页"实例已停止/正在启动"，而不是浏览器报错。

### 11.5 监控、日志与审计

- **portal 健康循环**：每 30 秒对每个租户做 `docker inspect`（容器状态、重启次数、OOM 标记）+ `GET /healthz`；每 2 分钟用 admin RPC `channels.status` 读通道状态；结果写 `tenants.last_health_at` 与 `channel_bindings.state`。**网关状态与通道状态分开记录**（CH-04：通道故障独立于主机故障）。
- **docker events**：`die` / `oom` / `restart` 写审计；同一租户 10 分钟内重启 ≥3 次 → 告警并暂停自动重启（避免崩溃循环吃满宿主）。
- **指标**：node_exporter + cAdvisor（按容器标签 `nexus.tenant`）→ Prometheus → Alertmanager。告警项：宿主内存 >85%、磁盘 >80%、已分配内存超卖比 >阈值、租户 healthz 连续失败 >3 分钟、备份失败、证书 <14 天到期、模型网关不可达、Telegram/WhatsApp 通道 `error` 持续 >1 小时。
- **日志**：容器日志 `json-file` 轮转（20 MB × 5）；用户在 portal 看到的是 `docker logs --tail` 经**脱敏过滤**（token、`sk-` 之类密钥形态、Bearer）后的文本，不直接转发原始日志。
- **审计**：`audit_log` 记录注册、登录、token 显示/轮换、通道绑定/解绑、模型切换、设备批准、管理员对租户的任何操作；保留 180 天。运营对租户状态目录的任何读取视为"紧急破玻璃"操作，必须有工单与审计。

---

## 12. 安全

### 12.1 威胁与对策

| 威胁                                          | 对策                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 在公网上猜租户 token                          | token 24 字节随机（192 位）；nginx 对租户路径限速（§7）；租户 id 不是秘密，不依赖"路径不可猜"                                                                                                                                                                                        |
| 租户之间互相访问                              | 每租户独立网桥；`DOCKER-USER` 丢弃私网段；无共享卷；状态目录分开（§3.4）                                                                                                                                                                                                             |
| Agent 被提示注入后访问内网 / 云元数据（SSRF） | 出站过滤（§3.4）；容器无 docker.sock、无特权                                                                                                                                                                                                                                         |
| 容器逃逸                                      | `cap-drop ALL`、`no-new-privileges`、默认 seccomp；残余风险是共享内核 → §12.3 升级路径                                                                                                                                                                                               |
| portal 被攻破                                 | portal 不碰 docker.sock，只能调 provisioner 的窄动词；portal 以专用低权用户运行并加 systemd 加固（`NoNewPrivileges`、`ProtectSystem=strict`、`PrivateTmp`）。**残余风险**：portal 需要解密 token 才能调租户 admin RPC，所以 portal 被攻破等于各租户 token 暴露——这是该方案的已知取舍 |
| admin RPC 被公网访问                          | 租户端 nginx 404；容器只发布回环；永不对外映射                                                                                                                                                                                                                                       |
| 邀请码泄露                                    | 次数 / 有效期 / 档位限制；可随时禁用；只存哈希                                                                                                                                                                                                                                       |
| 账号被撞库                                    | argon2id；登录限速；后续加 TOTP                                                                                                                                                                                                                                                      |
| 会话劫持 / CSRF                               | cookie `HttpOnly; Secure; SameSite=Lax`；所有非 GET 带 `X-CSRF-Token`                                                                                                                                                                                                                |
| 备份泄露                                      | `age` 加密、异地拷贝单独密钥、访问审计                                                                                                                                                                                                                                               |
| 转录里的明文 secret                           | 不把真实供应商 key 放进租户（§8.3）；BYOK 对用户提示；日志脱敏；备份加密                                                                                                                                                                                                             |
| WhatsApp 号码被限制                           | 专用号码、风险同意、低频；不做群发（§10.3）                                                                                                                                                                                                                                          |

### 12.2 Secrets 清单

| Secret              | 存放                                                 | 谁能读                                                           |
| ------------------- | ---------------------------------------------------- | ---------------------------------------------------------------- |
| 网关 token          | `env/<id>.env`（0600 root）+ `tenants.token_enc`     | provisioner（root）、portal（解密）、用户（portal 显示，需密码） |
| Telegram bot token  | `channel_bindings.secret_enc` + 租户 `openclaw.json` | portal、租户 Agent（配置可读）                                   |
| 模型虚拟 key        | 模型网关 + 租户 `openclaw.json`                      | 租户 Agent；可限额、可吊销                                       |
| BYOK key            | `model_configs.key_enc` + 租户配置                   | 用户自己、其 Agent                                               |
| 主密钥 `master.key` | `/etc/nexus/master.key`（0400，portal 用户）         | portal                                                           |
| 备份加密私钥        | 离线                                                 | 运维（恢复时）                                                   |

### 12.3 隔离强度的升级路径

PRD 的 BR-01 字面要求是"专用物理机/云虚拟机"。容器方案是**成本/密度优先**的折中，要按下面阶梯评估是否升级：

| 档              | 实现                                         | 隔离                   | 代价 / 待验证                                                                    |
| --------------- | -------------------------------------------- | ---------------------- | -------------------------------------------------------------------------------- |
| 0（本方案起步） | runc + 无特权 + 出站过滤                     | 共享内核               | 最便宜、密度最高                                                                 |
| 1               | gVisor（`--runtime=runsc`）                  | 用户态内核拦截系统调用 | Chromium 在 gVisor 下的兼容性与性能 **【待验证 V10】**                           |
| 2               | Kata / Firecracker microVM（每租户独立内核） | 硬件虚拟化边界         | 需要裸金属或嵌套虚拟化；AWS 有 Firecracker 池化的示例，但官方标注"不用于生产"    |
| 3               | 每个付费用户一台云 VM（运行同一个镜像）      | 与 PRD 字面一致        | 成本最高；provisioner 抽象成 `Backend` 接口（Docker / Kata / VM）即可共用 portal |

建议：内测用 0；对外扩大前至少评估到 1；有合规或高价值客户时走 3。

### 12.4 admin RPC 使用规则

1. 只由 portal 从回环调用；调用点集中在一个封装模块里，方法白名单（`health`、`status`、`config.get`、`config.patch`、`channels.status/start/stop/logout`、`web.login.start/wait`、`device.pair.*`、`usage.*`）。
2. 不用 `config.set/apply`、`agents.*`、`cron.*`、`gateway.restart.request`，除非有明确的运维需求并加审计。
3. 请求体 ≤1 MB；超时 10 秒（`web.login.wait` 除外，最长 25 秒）。
4. 任何失败不得把 token 写进日志。

### 12.5 限流与滥用

- 入口：§7 的 nginx 限流；`limit_conn` 每 IP 50。
- 账号：同一邀请码最多 N 次、同一 IP 注册频率、同邮箱唯一。
- 资源：容器 CPU/内存/PID/磁盘硬限制；出站带宽可用 `tc` 在宿主 veth 上做每租户限速（可选，视滥用情况再上）。
- 滥用响应：管理端可 `suspend` 用户 → 立即 `docker stop` 并从路由中摘除；保留证据备份；准备好服务条款和投诉渠道（法务内容不在本文范围）。

---

## 13. 前置服务（nexus-portal）API

### 13.1 约定

- 基地址 `https://a.b.com/api/v1`；请求/响应均为 JSON（日志接口除外），时间为 ISO 8601 UTC。
- 用户态认证：会话 cookie `nx_session`（`HttpOnly; Secure; SameSite=Lax`）+ 非 GET 请求带 `X-CSRF-Token`（由 `GET /me` 或登录响应下发）。
- 管理态认证：`Authorization: Bearer <admin token>`（只存哈希），并在 nginx 层限制来源 IP（`location /api/v1/admin/ { allow <办公出口>; deny all; … }`）。
- 创建异步任务的接口返回 `202` + `{ "job": { "id", "type", "state" } }`，用 `GET /me/jobs/{id}` 轮询；可带 `Idempotency-Key`。
- 错误统一为 `{ "error": { "code": "invite_invalid", "message": "…", "retryAfter": 30 } }`；常用状态码 400/401/403/404/409/422/429/502/503。

### 13.2 用户 API

**账号与会话**

| 方法   | 路径                    | 说明                                                                                                                                                                                                                                                                          |
| ------ | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/auth/register`        | `{email, password, inviteCode}` → `201 {user, tenant:{id,state:"provisioning",url}}`，同时下发会话。错误：`invite_invalid` / `invite_expired` / `invite_exhausted`（403），`email_taken`（409），`weak_password`（422），`capacity_full`（503，宿主名额已满，不扣邀请码次数） |
| POST   | `/auth/login`           | `{email, password}` → `200 {user, csrfToken}`；`invalid_credentials`（401）；`account_suspended`（403）                                                                                                                                                                       |
| POST   | `/auth/logout`          | 清会话                                                                                                                                                                                                                                                                        |
| POST   | `/auth/password/change` | `{oldPassword, newPassword}`                                                                                                                                                                                                                                                  |
| GET    | `/me`                   | `{user, tenant:{id,plan,state,url,imageTag}, model:{mode,…}, channels:{telegram:{state,display}, whatsapp:{state,display}}, quota:{…}, csrfToken}`                                                                                                                            |
| DELETE | `/me`                   | `{password, confirm:"DELETE", purge:boolean}` → `202 {job}`（§11.4）                                                                                                                                                                                                          |

> 邀请码阶段没有"忘记密码"邮件流程：由管理员 `POST /admin/users/{id}/password-reset` 生成一次性重置链接发给用户。开放注册前补邮件流程。

**实例（远程访问）**

| 方法 | 路径                                    | 说明                                                                                                                                          |
| ---- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/me/instance`                          | `{state, url, health:{gateway:"ok"\|"down", checkedAt}, plan, resources:{memoryLimit, cpus, diskUsedBytes, diskLimitBytes}, lastError, job?}` |
| POST | `/me/instance/start` `/stop` `/restart` | → `202 {job}`                                                                                                                                 |
| GET  | `/me/instance/logs?tail=200`            | `text/plain`，脱敏后的最近日志                                                                                                                |
| POST | `/me/instance/token/reveal`             | `{password}` → `{token}`（审计）                                                                                                              |
| POST | `/me/instance/token/rotate`             | `{password}` → `202 {job}`（§11.3）                                                                                                           |
| POST | `/me/instance/reset`                    | `{password, confirm:"RESET"}` → `202 {job}`                                                                                                   |
| GET  | `/me/jobs/{id}`                         | `{id,type,state:"queued"\|"running"\|"succeeded"\|"failed", step, error?}`                                                                    |
| GET  | `/me/connect`                           | `{consoleUrl:"https://a.b.com/t/<id>/", macApp:{address, authMode:"token"}, notes}`——连接页所需的静态信息（不含 token）                       |

**设备（对应控制台里的设备配对）**

| 方法   | 路径                                 | 说明                                                                                           |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| GET    | `/me/devices`                        | admin RPC `device.pair.list` → `[{id, name, platform, state:"pending"\|"paired", lastSeenAt}]` |
| POST   | `/me/devices/{id}/approve` `/reject` | 批准 / 拒绝待批准设备                                                                          |
| DELETE | `/me/devices/{id}`                   | `device.pair.remove`，撤销某台设备                                                             |

**Telegram**

| 方法   | 路径                            | 说明                                                                                                                                                                               |
| ------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/me/channels`                  | 两个通道的汇总状态                                                                                                                                                                 |
| GET    | `/me/channels/telegram`         | `{state:"unbound"\|"awaiting_pairing"\|"bound"\|"error", bot:{username}, lastInboundAt, lastError}`                                                                                |
| POST   | `/me/channels/telegram/token`   | `{botToken}` → `200 {state:"awaiting_pairing", bot:{username}}`。错误：`token_invalid`（422，`getMe` 失败）、`token_in_use`（409，已被其他租户使用）、`gateway_unavailable`（502） |
| POST   | `/me/channels/telegram/pairing` | `{code}` → `200 {state:"bound"}`；`code_invalid`（422）、`code_not_found_or_expired`（404）                                                                                        |
| DELETE | `/me/channels/telegram`         | 解绑（§10.2）                                                                                                                                                                      |

**WhatsApp**

| 方法   | 路径                            | 说明                                                                                                                                                                     |
| ------ | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/me/channels/whatsapp`         | `{state:"unbound"\|"awaiting_scan"\|"awaiting_pairing"\|"bound"\|"error", display, lastError}`                                                                           |
| POST   | `/me/channels/whatsapp/login`   | `{acceptRisk:true, force?:boolean}` → `200 {state:"awaiting_scan", qr:{format:"png-data-url"\|"text", data}, expiresInSec}`；未勾选风险同意 → `risk_not_accepted`（422） |
| GET    | `/me/channels/whatsapp/login`   | 轮询：`{state:"waiting_scan"\|"scanned"\|"connected"\|"expired"\|"error", qr?}`（二维码刷新时携带新值）                                                                  |
| PUT    | `/me/channels/whatsapp/policy`  | `{dmPolicy:"pairing"\|"allowlist", allowFrom?:["+8613…"]}`                                                                                                               |
| POST   | `/me/channels/whatsapp/pairing` | `{code}` → `{state:"bound"}`                                                                                                                                             |
| DELETE | `/me/channels/whatsapp`         | `channels.logout` + 清理（§10.3）                                                                                                                                        |

**模型与用量**

| 方法 | 路径                  | 说明                                                                                                                    |
| ---- | --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| GET  | `/me/model`           | `{mode:"platform"\|"byok", provider, baseUrl, keyHint:"sk-…abcd", platform:{budgetUsd, usedUsd, resetAt}}`              |
| PUT  | `/me/model`           | `{mode:"platform"}` 或 `{mode:"byok", provider, baseUrl, apiKey}`；BYOK 先做一次最小调用验证，失败 `key_invalid`（422） |
| GET  | `/me/usage?from=&to=` | `[{day, tokensIn, tokensOut, costUsd}]`                                                                                 |

### 13.3 管理 API（`/admin/*`）

| 方法  | 路径                                                               | 说明                                                                                           |
| ----- | ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| POST  | `/admin/invites`                                                   | `{label, plan, maxUses, expiresAt, count?}` → `201 [{id, code}]`，**明文 code 仅此一次返回**   |
| GET   | `/admin/invites`                                                   | 列表（含 `usedCount`、状态）                                                                   |
| PATCH | `/admin/invites/{id}`                                              | `{disabled:true\|false, maxUses?, expiresAt?}`                                                 |
| GET   | `/admin/tenants?state=&q=`                                         | 租户列表（含档位、镜像 tag、端口、最近健康时间）                                               |
| GET   | `/admin/tenants/{id}`                                              | 详情（含最近 job、通道状态、资源用量）                                                         |
| POST  | `/admin/tenants/{id}/start` `/stop` `/restart` `/retry` `/reclaim` | 运维动作；`retry` 重试失败的开通，`reclaim` 回收失败租户                                       |
| PATCH | `/admin/tenants/{id}`                                              | `{plan}`：改档位并重建                                                                         |
| POST  | `/admin/tenants/{id}/upgrade`                                      | `{imageTag, backup:true}` → `202 {job}`（§11.1）                                               |
| POST  | `/admin/tenants/{id}/backup`                                       | 立即备份                                                                                       |
| GET   | `/admin/tenants/{id}/backups`                                      | 备份列表                                                                                       |
| POST  | `/admin/tenants/{id}/restore`                                      | `{backupId}`                                                                                   |
| POST  | `/admin/tenants/{id}/token/rotate`                                 | 强制轮换                                                                                       |
| POST  | `/admin/users/{id}/suspend` `/unsuspend`                           | 停用 / 恢复                                                                                    |
| POST  | `/admin/users/{id}/password-reset`                                 | 生成一次性重置链接                                                                             |
| POST  | `/admin/rollout`                                                   | `{imageTag, wave:{percent\|tenantIds}, concurrency, backup}`；`GET /admin/rollout/{id}` 看进度 |
| GET   | `/admin/capacity`                                                  | `{hosts:[{id, memAllocated, memLimit, diskUsed, tenantsByState}]}`                             |
| GET   | `/admin/audit?tenant=&actor=&from=`                                | 审计查询                                                                                       |

### 13.4 内部接口（不出本机）

**portal → provisioner**（Unix socket `/run/nexus/provisioner.sock`，属主 `root:nexus-portal`，权限 0660）。只有下面这些动词，所有参数先校验再使用，用 SDK 或 argv 数组调用 Docker，**不拼 shell 字符串**：

| 动词                                                         | 说明                                                                    |
| ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `create {id, plan, tag, port, projectId, token, configJson}` | 建目录、配额、env、网桥、`docker run`                                   |
| `start` / `stop` / `restart {id}`                            | —                                                                       |
| `recreate {id, tag?, plan?}`                                 | 换镜像 / 换档位 / 换 token（读取新的 env 文件）                         |
| `upgrade {id, tag}`                                          | 含回滚（§11.1）                                                         |
| `backup {id}` / `restore {id, backupId}`                     | §11.2                                                                   |
| `delete {id}` / `purge {id}`                                 | §11.4                                                                   |
| `logs {id, tail}`                                            | 返回原始日志，脱敏在 portal 侧                                          |
| `pairing-approve {id, channel, code}`                        | 在容器内执行配对批准，`channel ∈ {telegram, whatsapp}`，`code` 正则校验 |
| `sync-routes {entries:[{id,port}]}`                          | 校验后写 `tenants.map`，`nginx -t && nginx -s reload`                   |
| `inspect {id}`                                               | 容器状态、重启次数、OOM 标记                                            |

**portal → 租户**（回环 HTTP）：只用于 admin RPC，见 §12.4。

**探活**：portal 自身 `GET /healthz`（给监控）；对租户的探活由 portal 主动做。

---

## 14. 容量与扩展

### 14.1 单机

- 容量按"已分配内存上限之和 ≤ 宿主内存 × 超卖系数（1.5–2）"控制，portal 开通前检查，超出则返回 `capacity_full`。
- 容量瓶颈首先是**内存（Chromium）**，其次是磁盘（文件柜、转录、备份）、最后才是 CPU。64 GB 宿主在 4 GB 档位下约 20–30 个活跃租户的数字是估算（§3.1），上线前用 spike 的实测数据修正，并决定每个档位的真实内存上限。
- 单机是单点：宿主故障 = 全部租户中断。内测阶段可接受，但要做到"恢复只需要备份 + 重建"（§11.2），并公开告知。

### 14.2 扩到多机（后续）

不引入编排系统，先走"多宿主 + 单入口"：

1. `tenants.host_id` 已存在；每台宿主跑一个 provisioner（通过 mTLS 暴露给 portal，而不是本机 socket），租户端口发布在**内网地址**而非 `127.0.0.1`，宿主防火墙只放行入口 nginx。
2. 入口 nginx 的 `tenants.map` 从 `id → port` 变成 `id → host:port`。
3. 开通时 portal 选剩余额度最多的宿主；租户**不会自动迁移**——跨机迁移 = 备份 → 在目标机恢复 → 改 `host_id` 和路由。
4. 入口 nginx 做双节点 + keepalived 或云负载均衡，避免入口单点。

AWS 的两份参考架构（EKS + ArgoCD + 每租户 Helm、Firecracker microVM 池）都标注"不用于生产"，只借鉴思路：路径路由 `/t/<tenant>/`、按需缩容（KEDA）、可选 gVisor。**不借鉴"闲置缩零"**——BR-03 要求用户离开后 Agent 主机继续运行。

---

## 15. 落地阶段（以退出条件而不是工期划分）

PRD 不含实施阶段，这里只是部署侧的建议顺序。

### 阶段 0：spike（1 台机器、2 个手工租户、不写 portal）

用脚本 + 手写 nginx 配置完成 §16.1 的 V1–V10，产出：镜像构建配方、容器参数、配置模板、资源实测数据。

**退出条件**：

- 两个租户在 `https://<测试域名>/t/<id>/` 上都能用 token 登录网页控制台，WebSocket 稳定保持 ≥1 小时；
- Mac App（官方版即可）能用"地址 + token"连上其中一个租户；
- 一个租户完成 Telegram 绑定并收发消息；
- 一个租户完成 WhatsApp 扫码并收发消息（或确认二维码走控制台页面的退路）；
- Browser 面板能让人工接手一个登录页；
- 升级 + 回滚、停机备份 + 恢复各演练成功一次；
- 容器内无法访问 `169.254.169.254`、宿主服务和另一个租户。

### 阶段 1：内测（≤10 个邀请用户）

portal MVP（注册 / 登录 / 开通 / 连接页 / token 显示与轮换 / 启停 / 日志）、provisioner、nginx 同步、备份、基础监控和告警、Telegram 向导、WhatsApp 向导（可功能开关）、Mac App 纯客户端构建、平台模型网关与虚拟 key。

**退出条件**：连续两周无需人工介入的开通；一次真实恢复演练通过；内存实测数据已修正档位表。

### 阶段 2：扩大

分批升级与金丝雀、用量统计与预算告警、邮箱验证与密码找回、TOTP、gVisor 评估、第二台宿主、入口双节点。

### 阶段 3：按需

每用户一台 VM 档（§12.3）、Relay / 设备配对 / 推送（依赖插件侧工作）、计费。

---

## 16. 待验证清单、冒烟清单与风险

### 16.1 待验证（spike 要逐条过）

| #   | 要确认什么                                                                                                                                                        | 怎么验证                                            | 不成立时的退路                                                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| V1  | `OPENCLAW_EXTENSIONS` 能否把 `nexus-agent-core`（私有 fork）、`telegram`、`whatsapp` 一起打进带浏览器的镜像，并作为内置插件加载                                   | 构建后跑 §4.3；`plugins list` 看来源                | 改为运行时 `plugins install npm-pack:…` + `customPlugins=true`，关闭 `evidenceBlobsEnabled`，并把"重装会重置插件配置"写入升级流程 |
| V2  | `basePath=/t/<id>` 下：静态资源、WebSocket、`/healthz` 的实际路径；网关是否要求代理不剥离前缀                                                                     | 手工 `curl` + 浏览器 DevTools；nginx 不改写路径转发 | 若网关要求被剥离前缀，nginx 改为 `proxy_pass http://127.0.0.1:$port/;` 并相应调整 basePath                                        |
| V3  | admin-http-rpc 的启用键、监听位置、basePath 下的实际 URL                                                                                                          | 读 `openclaw config schema`，实测 `health` 调用     | 退路：provisioner 用 `docker exec … node dist/index.js gateway call <method>` 代替 HTTP RPC                                       |
| V4  | Chromium 在 `cap-drop ALL` + 默认 seccomp + `noSandbox` 下的稳定性；4 GB 档位下多标签的内存曲线；`--shm-size` 是否够                                              | 跑一组真实浏览任务并记录 RSS / OOM                  | 调高内存档位；必要时给 Chromium 专用 seccomp 配置，而不是放开整个容器                                                             |
| V5  | WhatsApp 二维码是否能通过 `web.login.start/wait` 取到并在 portal 渲染；最新版控制台 Channels 页面是否仍支持扫码                                                   | 实际扫一次码                                        | portal 改为仅引导 + 读状态，用户在控制台页面扫码                                                                                  |
| V6  | Mac App 用 token 连接远程网关：是否需要设备批准、`#token=` 之类免输入登录是否存在、token 登录是否具备 BR-02 所需的 `operator.admin` + `browser.request`           | 用官方 Mac App 实连                                 | 设备批准走 portal 的 `/me/devices`；免输入登录改为"复制 token"；范围不足则需要调整网关认证配置                                    |
| V7  | Nexus 插件在目标 OpenClaw 版本（本地仓库是 2026.9.4，上游已到 2026.10.x）的兼容性                                                                                 | 在新基线上跑 Nexus 现有回归 + 探针脚本              | 钉死到可用的 OpenClaw 版本；同步 fork 时先过回归再打 `stable`                                                                     |
| V8  | 本文中所有配置字段名：`gateway.controlUi.allowedOrigins`、`gateway.trustedProxies`、`browser.noSandbox`、`channels.telegram.*`、`channels.whatsapp.*`、模型配置块 | `openclaw config schema` + 实测 `config.patch`      | 以 schema 为准改模板                                                                                                              |
| V9  | 渠道配对批准：容器内执行 `pairing approve <channel> <CODE>` 是否与运行中网关一致；是否有可用 RPC                                                                  | 实测                                                | 引导用户在控制台 Settings → Channels 里批准                                                                                       |
| V10 | Chromium 在 gVisor 下是否可用、性能代价                                                                                                                           | 在测试机上用 `--runtime=runsc` 跑同一组浏览任务     | 保持 runc，改用 microVM / 每用户 VM                                                                                               |

### 16.2 冒烟清单（每次打 `stable` 标签前，在临时租户上过一遍）

1. 容器起来，`/healthz` 通过，admin RPC `health` 通过。
2. 用 token 登录网页控制台；左侧能看到 Nexus；日志里有 `nexus-agent-core register: mode=full … tasksEnabled=true decisionsEnabled=true claimsEnabled=true`，没有 `before_prompt_build blocked`。
3. 创建一个 Nexus 事项并读回；上传一个文件到文件柜并搜索到。
4. 浏览器：打开一个网页并截图；在 Browser 面板里手工输入一个字符串。
5. 重启容器后：Nexus 数据仍在、Telegram 仍在线、WhatsApp 登录态仍在。
6. 停机备份 → 删状态 → 恢复 → 以上第 5 项重做。
7. 容器内：`curl -m 3 http://169.254.169.254/` 失败；访问宿主 `:8080` 失败；访问另一个租户容器失败；访问公网成功。
8. 公网侧：`/t/<id>/api/v1/admin/rpc` 返回 404；用错误 token 无法建立 WebSocket。

### 16.3 风险登记

| 风险                                                          | 影响                            | 应对                                                                                             |
| ------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------ |
| 容器不是 PRD 字面的"专用 VM"                                  | 合规 / 对外话术                 | §12.3 升级路径；对外不写"独享物理机"；让产品方确认                                               |
| Chromium 内存吃紧                                             | 浏览器反复被杀，体验差          | 内存硬限、OOM 事件展示、档位调整、实测校准                                                       |
| WhatsApp 非官方协议，号码可能被限制，数据中心 IP 更易触发     | 通道不可用，用户号码受损        | 专用号码 + 风险同意 + 低频；可作为"可选通道"而非承诺 SLA；评估住宅出口代理（不在本方案范围）     |
| Telegram 需要用户自建 bot                                     | 开通摩擦                        | 图文向导；后续评估平台代建 bot 的可行性（需要上游支持共享 bot 或入口路由，目前没有）             |
| 上游变动快（`fleet` 刚被移除）                                | 方案依赖的行为变化              | 钉版本；基线升级走 V7 回归；订阅发布说明；provisioner 只依赖文档化的容器轮廓                     |
| 备份需停机                                                    | 与"常驻"冲突                    | 错峰窗口 + 忙时顺延；后续评估快照备份                                                            |
| 单宿主                                                        | 整体中断                        | 内测可接受；14.2 路线；恢复演练                                                                  |
| 转录 / 配置里的 secrets 不再遮盖（2026.10.10 起）             | 备份、日志、BYOK key 泄露面变大 | 虚拟 key、日志脱敏、备份加密、破玻璃审计                                                         |
| portal 持有全部租户 token                                     | portal 被攻破的影响面           | 无 docker.sock、窄 provisioner、systemd 加固、审计；后续评估把 token 换成"portal 签发的短期凭据" |
| Mac App 目前绑定本地网关                                      | 远程体验不顺                    | 纯客户端构建（§10.1）                                                                            |
| 模型网关单点                                                  | 所有 platform 模式租户无模型    | 双实例 + 健康检查；BYOK 作为逃生口                                                               |
| Nexus 真实 Provider 尚未实现                                  | 部署后动作类工具仍是模拟        | 保持 `fakeProviderMode="ok"`，对用户如实说明；上线真实 Provider 前不改此项                       |
| 自动批准额度（每 Work 10 次、每账号每日 20 次）与部署配额无关 | 容易混淆                        | 文档与 UI 中分开命名：前者叫"自动批准额度"，后者叫"资源档位 / 模型预算"                          |

---

## 17. 附录

### 17.1 运维命令速查（均由 provisioner 代为执行，这里便于排障）

```bash
docker ps --filter label=nexus.tenant --format '{{.Names}}\t{{.Status}}'
docker logs --tail 200 oc-<id>
docker inspect oc-<id> --format '{{.State.OOMKilled}} {{.RestartCount}} {{.Config.Image}}'
docker stats --no-stream $(docker ps -q --filter label=nexus.tenant)
curl -fsS http://127.0.0.1:<port>/healthz                       # basePath 下的路径以 V2 为准
nginx -t && nginx -s reload
xfs_quota -x -c 'report -p -h' /srv/nexus
```

### 17.2 与上游的关系

- 上游文档的多租户口径：每个信任边界一个 Gateway；"多用户模式"不是隔离边界——本方案采用前者。
- 上游曾有 `openclaw fleet`（每租户一个加固容器），**已在 main 移除**（PR #165825，2026-10-08 合并，随 2026.10.10 发布），且没有给出替代品，由运营方自己负责生命周期、镜像更新、备份和清理。本方案的 provisioner 复制它**已有文档的容器轮廓**（`gateway --bind lan --port 18789`、仅发布 `127.0.0.1:<port>:18789`、`cap-drop ALL`、`no-new-privileges`、`--init`、`pids-limit`、`restart unless-stopped`、每租户一个网桥、状态目录挂载到 `/home/node/.openclaw`、env 文件传 secrets、不挂 docker.sock、租户 id 正则、带 `/healthz` 门禁的升级回滚、停机备份、删除即清理），并按 Chromium 的需要调高了内存、PID 和共享内存。
- 本方案不依赖任何尚未发布或未文档化的上游行为；凡依赖的都已列入 V1–V10。

### 17.3 文件与变量清单

| 路径 / 变量                                      | 作用                                                   |
| ------------------------------------------------ | ------------------------------------------------------ |
| `/srv/nexus/cells/<id>/`                         | 租户状态目录，挂载到容器 `/home/node/.openclaw`        |
| `/srv/nexus/env/<id>.env`                        | 租户环境变量（含 `OPENCLAW_GATEWAY_TOKEN`），0600 root |
| `/srv/nexus/backups/<id>/`                       | 加密备份                                               |
| `/etc/nexus/portal.env`、`/etc/nexus/master.key` | portal 配置与主密钥                                    |
| `/etc/nginx/nexus/tenants.map`                   | 租户路由表（provisioner 写入）                         |
| `/run/nexus/provisioner.sock`                    | portal → provisioner 通道                              |
| 端口池 `127.0.0.1:20000–29999`                   | 租户网关的宿主回环端口                                 |
| 网段 `172.30.0.0/12`（每租户 /28）               | 租户网桥地址池                                         |
| 容器标签 `nexus.tenant` / `nexus.plan`           | 监控与运维筛选                                         |
