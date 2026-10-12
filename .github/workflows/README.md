# Codex 检查说明

本验证配置只增加两个 PR 检查，不接入 OpenClaw 的 `openclaw/ci-gate`，也不创建额外 Merge gate
或 Quality Ledger：

```text
Codex QA -> Codex Review
```

| 文件                                   | 职责                                   | 触发方式                               |
| -------------------------------------- | -------------------------------------- | -------------------------------------- |
| [`codex-checks.yml`](codex-checks.yml) | 轻量调度两个 Codex 检查                | base 为 `codex-ci` 的同仓库、非草稿 PR |
| [`codex-qa.yml`](codex-qa.yml)         | 按主 Issue 的 Acceptance Criteria 验收 | 由轻量调度工作流调用                   |
| [`codex-review.yml`](codex-review.yml) | 独立检查 diff、规格和安全问题          | QA 成功后调用                          |

## 调度边界

[`ci.yml`](ci.yml) 保留 OpenClaw 原有行为，但通过 `branches-ignore: [codex-ci]` 跳过以测试分支
为 base 的 PR。`main` push、以 `main` 为 base 的 PR 和手动调度不受影响。

`codex-checks.yml` 仅响应 `opened`、`reopened`、`synchronize` 和 `ready_for_review`，并拒绝草稿
或 fork PR。编辑 PR 标题、正文、Issue 或 Issue 评论不会自动触发；需要手动重新运行或推送新
提交。

## Codex QA

QA 要求 Secret `OPENAI_API_KEY` 和 Variable `OPENAI_RESPONSES_API_ENDPOINT` 非空。它检出准确
的 PR head SHA，使用 OpenClaw 的 `setup-node-env` action 配置 Node 24、pnpm 和冻结锁文件依赖，
再由 [`context.cjs`](../scripts/context.cjs) 加载主 Issue、Issue 评论和 PR 讨论。

主 Issue 必须通过 `Closes #123`、`Fixes #123` 等形式唯一关联，具备完整 Contract、
`AI Ready=Yes` 和唯一 AC 编号。QA 使用 `workspace-write` 沙箱执行适用测试，输出
`evidence/qa.json`，并由 [`report.cjs`](../scripts/report.cjs) 校验。

## Codex Review

Review 在 QA 成功后重新检出同一 PR head SHA并重新加载上下文。它不读取 QA 结论，使用
`read-only` 沙箱检查正确性、回归、安全、兼容性、测试覆盖和规格一致性，输出
`evidence/review.json`。

两个工作流都通过 `responses-api-endpoint` 使用仓库变量指定的完整 Responses endpoint，并将
证据 artifact 保留 30 天。

## 本地验证

```bash
node --test .github/scripts/automation.test.cjs
git diff --check
```

完整验证必须使用一个以 `codex-ci` 为 base、来自同仓库且非草稿的 PR。
