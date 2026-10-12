---
status: Accepted
date: 2026-10-09
deciders: []
issue: null
---

# GitHub 作为研发协作唯一权威中心

## Context

需求、讨论、代码变更和测试证据如果分散在聊天、个人文档和 CI 日志中，Agent 无法稳定复现决策上下文，也无法可靠追踪验收结果。

## Decision

GitHub Files 保存长期规则、规格、设计、测试策略、报告和 ADR；Issue 保存需求、任务、Bug 和决策入口；PR 保存实现、验证、Review 和合并证据。影响研发决策的讨论必须通过 Issue 或 PR comment 回写。Slack 仅用于 `urgent`、`incident`、`security` 提醒并附 GitHub 链接。

## Consequences

- Agent 可以用同一份 Issue、文件和 PR 上下文执行计划、实现、QA 和修复。
- 质量报告和 Bug 镜像可以被搜索、审计并交给后续 Agent。
- 需要维护 Issue Contract、PR Contract、评论协议和 Quality Ledger；未回写 GitHub 的决定不作为长期约束。

## Alternatives

不采用把聊天记录、Slack 或个人文档作为隐性权威来源的方式，因为其不可稳定发现、审计和复用。
