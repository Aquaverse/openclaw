# GitHub 研发流程

本目录为 `codex-ci` 验证分支增加 Issue Contract、Codex QA 和 Codex Review。研发流程见
[`a2a_dev_process.md`](../a2a_dev_process.md)，术语见 [`GLOSSARY.md`](../GLOSSARY.md)。

## 启用

1. 在 `Settings -> Secrets and variables -> Actions` 中配置：
   - Secret `OPENAI_API_KEY`；
   - Variable `OPENAI_RESPONSES_API_ENDPOINT`，值为完整 Responses endpoint，例如
     `https://api.example.com/v1/responses`。
2. 确保 [`docs/agents/triage-labels.md`](../docs/agents/triage-labels.md) 定义的五个标签存在。
3. 创建一个以 `codex-ci` 为 base 的同仓库、非草稿 PR，并使用 `Closes #<number>` 关联一个
   `AI Ready=Yes`、Acceptance Criteria 编号唯一的主 Issue。

## 执行与证据

测试分支上的新增检查只有：

```text
Codex QA -> Codex Review
```

[`workflows/codex-checks.yml`](workflows/codex-checks.yml) 只监听 base 为 `codex-ci` 的 PR。
为避免验证阶段启动 OpenClaw 的大量原有检查，[`workflows/ci.yml`](workflows/ci.yml) 对该 base
分支使用 `branches-ignore`。这不会改变以 `main` 为 base 的 OpenClaw CI。

QA 按主 Issue 的 AC 执行适用测试并输出结构化报告；Review 在 QA 成功后独立审查 diff、规格和
安全边界。两者均无仓库写权限，原始证据作为 artifact 保留 30 天。密钥或 endpoint 缺失时检查
会明确失败。

修改关联 Issue、Issue 评论或 PR 描述后，需要在 Actions 或 PR checks 中重新运行工作流，以读取
最新上下文。

## 正式评论协议

- `[AI-PLAN]`：执行计划。
- `[AI-QUESTION]`：缺失信息及需要回答的问题。
- `[AI-EVIDENCE]`：测试、日志和代码证据。
- `[AI-BLOCKED]`：阻塞原因与解除条件。
- `[HUMAN-DECISION]`：人类正式决策及例外批准。
- `[AI-RESULT]`：完成摘要及结果链接。
