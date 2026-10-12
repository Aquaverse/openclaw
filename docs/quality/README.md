# 质量台账文档

Quality Ledger 在 CI 完成后生成质量证据 PR，长期文件按以下路径保存：

```text
docs/quality/
├── reports/PR-<pr-number>.md
└── bugs/BUG-<issue-number>.md
```

## Reports

`reports/PR-<n>.md` 是 QA 和内容独立 Review 的可搜索摘要，至少包含关联 Issue、PR、提交 SHA、运行链接、AC 结果、测试执行记录、回归和审查结论。Review 不读取或沿用 QA 结论，但当前 CI 调度在 QA 成功后才运行 Review。原始日志、截图、coverage 和结构化 JSON 保存在 Actions artifact，不复制到该摘要中。

## Bugs

`bugs/BUG-<n>.md` 是 QA 发现的可复现缺陷快照。文件使用流程规定的 front matter：`issue`、`status`、`severity`、`source_pr`、`affected_paths`、`reproduced_by_codex` 和 `fix_pr`；正文固定包含 `Symptom`、`Expected`、`Reproduction`、`Evidence`、`Root-cause hypothesis`、`Fix verification`。

Bug 文档由台账发布流程镜像，修复 PR 负责更新状态、受影响路径、fix PR 和验证结果。环境阻塞只记录为 `[AI-BLOCKED]`，不创建产品 Bug。

质量台账 PR 需要 Human Supervisor 验收合并；它不自动合并产品 PR，也不绕过分支保护。
