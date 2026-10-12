# Architecture Decision Records

本目录保存影响多个任务或模块的架构决策。每份 ADR 使用 `NNNN-kebab-case.md` 命名，状态和决策必须能被 Issue、PR 或后续 Agent 直接引用。

## 状态

- **Proposed**：已提出，尚未批准。
- **Accepted**：已批准并作为当前约束。
- **Superseded**：被后续 ADR 替代，保留原文和替代链接。
- **Deprecated**：不再适用，但仍保留历史记录。

## 最小结构

```markdown
---
status: Proposed
date: YYYY-MM-DD
deciders: []
issue: null
---

# 标题

## Context

## Decision

## Consequences

## Alternatives
```

涉及 breaking change、数据迁移、API 版本策略或跨平台约束时，Issue 和 PR 必须引用对应 ADR。流程级决策见 [`0001-github-as-source-of-truth.md`](0001-github-as-source-of-truth.md)。
