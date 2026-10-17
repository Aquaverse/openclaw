# Nexus Agent Core Plugin: 切片③之后的小缺口收尾（2026-10-14）

位置：`extensions/nexus-agent-core/`，nexus-agent-core-design.md「切片③之后的小缺口收尾」有逐项说明。无新开关，`src/` 零改动。状态：**VM、Mac 静态检查、dev 网关验收通过，已 commit；pkg 安装版 9b0ac3f 回归通过（2026-10-14）**。

## 三件事

1. **`nexus.evidence.handle` + `nexus.evidence.read`**（`operator.read`）：UI 看证据原文用。`handle {taskId, evidenceId}` 返回句柄（不带字节），60 秒有效、只存在于进程内存、绑定 owner + Task + evidence；`read {handleId, offset?, length?}` 每次最多 1 MiB，返回 base64。**每次读都整体取回并重算 sha256、核对大小**，对不上返回 `evidence_integrity_error:<reason>`；单条删除或 purge 后句柄作废（`evidence_gone`）；无字节的证据不能开句柄。模型仍然读不到字节（工具白名单不变）。
2. **人工终结的步骤日志**：`nexus.execution.resolve` 的步骤标题改为「人工终结为成功/失败（executionId）」，`detail` 带 `resolvedBy`（固定 `operator:nexus-console`）与 `note`。
3. **`nexus.task.get`（RPC）** 补 `pendingDecisions` / `readyExecutions`，与 Agent 工具一致；已批准待提交的 execution 不改变 Task 状态，控制台需要这两个列表。

## 验证结果

- Linux VM：evidence-flow 35（+4 读句柄）、decision-flow 38（+1 `task.get`，resolve 测试补步骤日志断言），其余不变；回归 219/219；`tsc --noEmit --noUnusedParameters --noUnusedLocals` 干净。
- Mac：`oxfmt --check`、`pnpm tsgo:extensions` 通过；`pnpm test:extension nexus-agent-core` 15 文件 / 257 条通过。
- dev 网关：`spikes/blob-flow.mts` 全部通过（含新增的 handle / read / 越界 / 未知句柄 / `task.get` 两个数组）。第一次跑在 `nexus.evidence.handle` 处报 `missing scope: operator.admin`，原因是 dev 网关还是旧进程——网关对未注册的方法默认要求 admin 权限；重启后通过。
- 安装版 9b0ac3f（= HEAD）：`grep -c "nexus.evidence.handle" index.js` = 2；claim-flow、blob-flow、purge-flow 全部通过。

## `incarnation_gone` 清单观测（dev 网关，2026-10-14）

开 `evidenceIncarnationGoneEnabled=true` → 重启 → `kill -9` → 再启动 → `purge-flow.mts --phase incarnation`：全部通过。

- ① 当前进程 boot id 可读（`15420:1791949032`，非 `unavailable`）。
- ③ 没有误标：9 行 `superseded_under_gateway_lock` 的 boot id 全部不同于当前进程。
- ⑤ 真实 crash-restart：被 kill 的旧行标为 `superseded_under_gateway_lock`；此前历史上未干净关闭的旧行也在开关打开后的第一次 start 里被一并 supersede。结束时仅剩 1 个未终止的 incarnation。
- ② 一个 state 目录只允许一个网关：仍由操作员承诺，探针无法验证。
- 观察完开关已关回 `false`，dev 网关已重启。**默认值保持 off**，是否在生产启用取决于操作员对 ② 的承诺。

## 缺口

- 读句柄每块都整体取回并重算 hash（16 MB 上限内可接受）；句柄进程内存，重启即失效。
- 操作者字符串固定为 `operator:nexus-console`，RPC 上下文里没有可信操作者身份（同 purge 回执的局限）。
- 安装版尚未做：卡片流程（注入、迟到 Deny）、kill -9 恢复 K1–K3、blob crash-a / crash-b。
