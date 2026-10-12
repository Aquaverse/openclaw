# Issue 分诊标签

Issue Form 默认使用 `needs-triage`。以下五个标签是仓库的分诊分类集合；Issue 的 `Type` 字段仍是表单数据，不重复创建同名分类标签。

| 标签           | 用途                                 | 使用规则                                                                    |
| -------------- | ------------------------------------ | --------------------------------------------------------------------------- |
| `needs-triage` | 新 Issue 尚未完成分诊                | Issue Form 默认添加；监督者完成分类、Owner 和 AI Ready 判断后移除。         |
| `urgent`       | 需要尽快响应的高优先级事项           | 只用于确有时效要求的工作，并在 Issue 中写明截止时间和影响。                 |
| `incident`     | 已发生或正在发生的线上事件           | 记录影响范围、时间线、恢复动作和后续修复 Issue；Slack 只转发提醒和链接。    |
| `security`     | 安全风险、漏洞或安全审查事项         | 避免在公开评论泄露敏感细节；关联受限证据和负责的安全审查人。                |
| `blocked`      | 因外部依赖或明确决策未完成而无法推进 | 在 Issue 或评论中写明阻塞依赖、解除条件和负责人；环境阻塞不等同于产品 Bug。 |

## 生命周期

1. Issue Form 创建时由 GitHub 添加 `needs-triage`。
2. 监督者确认 Type、Owner、Risk、Dependencies 和 `AI Ready`，按需添加 `urgent`、`incident`、`security` 或 `blocked`。
3. 依赖解除且可以执行时移除 `blocked`；完成分诊并确认执行责任后移除 `needs-triage`。
4. `urgent`、`incident` 和 `security` 只用于 Slack 提醒入口，正式状态、决策和证据必须回写 GitHub Issue/PR。

标签不能替代 Issue Contract，也不能把 `AI Ready=No` 的 Issue 直接交给实现 Agent。
