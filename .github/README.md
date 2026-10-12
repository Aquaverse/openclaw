# GitHub 研发流程

本目录在 OpenClaw 现有 CI 之上增加 Issue Contract、Codex QA、Codex Review、Merge gate
和 Quality Ledger。研发流程见 [`a2a_dev_process.md`](../a2a_dev_process.md)，术语见
[`GLOSSARY.md`](../GLOSSARY.md)。现有构建、检查和测试仍由 [`ci.yml`](workflows/ci.yml)
及仓库脚本负责；本流程不另建一套通用测试命令。

## 启用

1. 在 `Settings -> Secrets and variables -> Actions` 中配置：
   - Secret `OPENAI_API_KEY`；
   - Variable `OPENAI_RESPONSES_API_ENDPOINT`，值为完整 Responses endpoint，例如
     `https://api.example.com/v1/responses`。
     Codex 使用官方 [GitHub Action](https://developers.openai.com/codex/github-action/)，
     调用会消耗 API 额度。密钥或 endpoint 缺失时检查失败，不会伪装通过。
2. 确保 [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md) 定义的五个标签存在。
   Type 是 Issue Form 字段，不另建分类标签。Owner 必须填写真实监督者。
3. 将工作流合入默认分支。`quality-ledger.yml` 只有位于默认分支后才能可靠响应
   `workflow_run`。
4. 在 `Settings -> Actions -> General -> Workflow permissions` 中选择读写权限，并允许
   GitHub Actions 创建 Pull Request。Quality Ledger 需要写入 Issue、PR 和台账分支。
5. 完成一次同仓库、非草稿 PR 的全链路验证后，在默认分支 Ruleset 中保留
   `openclaw/ci-gate` 并增加 `Merge gate` 必需检查；同时要求人工审批、解决全部讨论、
   新提交使旧审批失效，并要求分支保持最新。YAML 不能代替这些仓库设置。

当前流程没有 `merge_group` 适配，启用 Merge Queue 前必须补齐并验证该事件。

## 执行与证据

OpenClaw 原有 CI 先执行选中的构建、静态检查和测试 lanes，并由 `openclaw/ci-gate`
聚合结果。同仓库、非草稿 PR 继续执行：

```text
openclaw/ci-gate -> Codex QA -> Codex Review -> Merge gate
```

推送 `main` 或手动运行时只执行原有 OpenClaw CI；Codex QA、Codex Review 和 Merge gate
都是 PR-only。草稿 PR 不执行这三个新增门禁。修改关联 Issue、Issue 评论或 PR 描述后，
应手动重新运行 PR 的 CI，以读取最新规格。

正常 PR 用 `Closes #123` 关联一个主 Issue，其他依赖使用 `Refs #456`。Issue 必须包含统一
Contract 字段、`AI Ready=Yes` 和唯一的 `AC-1`、`AC-2` 验收编号。执行前读取 Issue 全部
评论及 PR 讨论。线上 Incident 使用 Bug Type 并加 `incident` 标签。

QA 在临时工作区验收 AC、执行适用测试并输出结构化 JSON；测试补丁和原始日志保存在
artifact，不会自动修改产品分支。Review 在独立作业中只读审查实现和安全边界。缺失证据、
失败报告和跳过的必要作业都会阻断 Merge gate。

`quality-ledger.yml` 在 CI 完成后处理同仓库 PR：发布 `[AI-EVIDENCE]` 或
`[AI-BLOCKED]` 评论，为可复现 QA 缺陷创建带 `needs-triage` 的 Bug Issue，并通过
`quality-ledger/pr-<n>` 分支提交质量记录 PR。它不自动合并产品 PR，也不属于 Merge gate。

由 `GITHUB_TOKEN` 创建的质量记录 PR 不会再次触发普通 PR 工作流。团队需为纯证据 PR
配置明确的人工例外，或使用经批准的 GitHub App 触发检查；该例外不得用于产品代码 PR。

发布作业只执行默认分支中的脚本，把 artifact 当作受大小限制且经过 Schema 校验的数据。
过期 commit 的报告不发布。AI 作业无仓库写权限，checkout 不保留 Git 凭据。原始证据默认
保留 30 天，长期摘要须合并台账 PR 后才进入主分支。

## 正式评论协议

- `[AI-PLAN]`：执行计划。
- `[AI-QUESTION]`：缺失信息及需要回答的问题。
- `[AI-EVIDENCE]`：测试、日志和代码证据。
- `[AI-BLOCKED]`：阻塞原因与解除条件。
- `[HUMAN-DECISION]`：人类正式决策及例外批准。
- `[AI-RESULT]`：完成摘要及结果链接。

长期规则保存到 Files，任务状态保存到 Issues，变更和验收保存到 PR。Slack 只用于
urgent、incident、security 提醒并附 GitHub 链接。
