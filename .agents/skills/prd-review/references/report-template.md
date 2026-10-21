# Report Template

Use this compact default; adapt to the user format and scope. Omit empty sections. Expand only where useful.

```markdown
# 需求业务评审报告

## 总体结论

- 对象、版本、范围及当前阶段：
- 已读取来源、未读取资料与评审限制：
- 设计准备度：Ready / Ready with conditions / Blocked / Not assessed，依据及条件
- 开发准备度：同上
- 验收标准可定义程度：同上（不代表实际 QA 通过）
- 最高风险与优先处理项：引用 Finding ID

## 业务理解

简述目标、角色、对象、流程和状态；区分 Stated、Inferred、Missing、Question、Unknown，引用来源。

## 统一问题清单

| ID  | 类别 | 严重程度 | 决策状态 | 模块 | 来源及位置 | 场景与问题 | 具体影响 | 建议 |
| --- | ---- | -------- | -------- | ---- | ---------- | ---------- | -------- | ---- |

## 待产品确认

| Finding ID | 问题 | 可选方案与取舍 | 影响范围/阶段 | 解除条件 |
| ---------- | ---- | -------------- | ------------- | -------- |

## 关键测试场景

| Finding ID/来源 | 场景 | 前置条件与操作 | 预期结果 | 已确认规则 / 候选待确认 |
| --------------- | ---- | -------------- | -------- | ----------------------- |
```

## Optional Expansion

For complex documents add object relationships, module responsibilities, cross-module analysis, or clarity summaries. Reference canonical finding IDs rather than duplicating findings. Summarize low-risk modules and focus on high-risk flows.

For valuable wording changes provide source location, finding ID, and proposed text. Preserve confirmed rules. Mark unconfirmed choices as “建议，待确认” and use placeholders or alternatives rather than inventing thresholds, permissions, or policies. Derived tests remain candidates until decisions are confirmed.

Keep blockers near the top and specify the stage/scope blocked. Do not force this structure onto small proposals or imply reviewer approval grants implementation authorization.
