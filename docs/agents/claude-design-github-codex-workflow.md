# Claude Design 集成 GitHub + Codex 流程

日期：2026-10-10
状态：按 [a2a_dev_process.md](../../a2a_dev_process.md) 执行

本文定义 Claude Design 如何接入本仓库已经建立的 GitHub Issue Forms、PR Template、Codex QA 和 Codex Review。它不创建新的 Issue 或 PR 格式，也不把 Claude Design 链接当作研发权威来源。

## 核心原则

仓库遵循 GitHub 唯一权威中心模型：

| 对象          | 职责                                                                 |
| ------------- | -------------------------------------------------------------------- |
| Claude Design | 探索用户流程、视觉方案、原型和设计系统应用                           |
| `docs/` Files | 保存已经确认、可审查、可版本化的 PRD、设计规格、状态、素材和 handoff |
| GitHub Issue  | 定义问题、用户结果、范围、AC、依赖、风险和 AI Ready 状态             |
| GitHub PR     | 记录实现、测试、视觉证据、AI Review、回滚风险和合并决策              |
| Comments      | 使用正式协议记录 AI 与人类的决定、问题和证据                         |

Claude Design 中的内容只有在同步到 GitHub 文件、Issue 或 PR 后，才进入研发流程。Slack、Claude 对话和 Codex 对话不能替代这些记录。

## 目录和 handoff 约定

`a2a_dev_process.md` 规定设计交接使用以下路径：

```text
docs/
├── product/                  # 长期产品背景
├── specs/                    # 复杂功能规格
└── design/
    └── <issue-number>/
        ├── design-spec.md    # 设计意图、结构、交互和设计 Token
        ├── states.md          # loading / empty / error / permission 等状态
        ├── assets/            # 设计素材
        └── handoff/           # Claude Design 导出的 handoff bundle、截图和原型说明
```

不要使用上一版建议中的 `docs/features/<feature>/` 作为本流程的默认路径。文件夹以 Issue 编号命名，确保设计、实现和验收可以直接关联。

### Claude Design 的输入

设计师在 Claude Design 中使用以下输入：

- GitHub Design Issue 的完整内容和全部评论
- 产品背景、已有 PRD、相关 API 或 ADR
- 项目设计系统、组件约束和可访问性要求
- 目标平台、断点、设备或最低 OS 约束

Issue 未达到 `AI Ready=Yes` 时，Claude Design 可以探索方案，但不能把探索结果视为工程交接。

### Claude Design 的输出

设计完成后，将可实施结果写入 `docs/design/<issue-number>/`，至少包括：

- 主用户流程和分支流程
- 页面结构、组件和设计 Token 引用
- Web/mobile 或响应式差异
- loading、empty、error、permission 等适用状态
- 文案、交互和键盘/无障碍要求
- 关键状态截图、视口尺寸和测试数据说明
- 原型或 Claude Design 源链接
- 版本、负责人和对应 Issue

`handoff/` 中的内容是工程输入；Claude Design 中仍在探索的画板、备选方案和讨论不放入已批准 handoff，除非明确标注为背景资料。

建议在 `design-spec.md` 顶部记录：

```md
Design status: draft | ready | superseded
Spec version: 1.0
Source: <Claude Design 链接>
Issue: #<issue-number>
Owner: @<github-user>
Last synced: 2026-10-10
```

完成交接后，在 Design Issue 留下 `[AI-RESULT] design-ready`，并链接 `design-spec.md`、`states.md`、`assets/` 和 `handoff/`。这是 `design.yml` 模板要求的完成信号。

## 两类 Issue 的协作顺序

本仓库已经建立 `feature.yml`、`design.yml`、`bug.yml` 和 `tech-debt.yml`。Claude Design 集成只需要使用它们，不应另写一套表单。

### 新功能：Feature Issue + Design Issue

当需求和设计都需要推进时，使用两个相互关联的 Issue：

1. 用 `Feature` 模板记录 Problem、User Outcome、Scope、Non-goals、产品 AC、Dependencies、Risk、Owner 和 `AI Ready`。
2. 用 `Design` 模板记录 User Flow、Target Platforms、Component Constraints、UI States 和 Design Handoff。
3. Feature Issue 的 `References` 链接 Design Issue 和 `docs/design/<design-issue-number>/`。
4. 设计完成后，Design Issue 评论 `[AI-RESULT] design-ready`；确认设计文件已提交到仓库。
5. 产品负责人确认 Feature Issue 的 AC、设计引用和依赖，才将 Feature Issue 标为 `AI Ready=Yes`。
6. Codex 从 Feature Issue 开始实现，同时读取关联 Design Issue、设计 handoff、适用 `AGENTS.md`、API 和 ADR。

小型变更可以只使用 Feature Issue，但 Feature Issue 的 `References` 必须链接已有设计规格，或明确说明为什么不适用。只有设计交接本身（没有立即实现任务）时，才单独使用 Design Issue。

### 设计变更：不要静默覆盖

已 `design-ready` 的设计发生行为变化时：

1. 在原 Design Issue 或关联 Feature Issue 留下 `[HUMAN-DECISION]` 或 `[AI-QUESTION]`。
2. 更新 `docs/design/<issue-number>/`，增加版本并在 diff 中说明变化。
3. 更新受影响的 Feature AC、Dependencies 或 Risk。
4. 若实现已开始，等待 Codex 评估影响；不得只替换图片而不更新规格。
5. 若已交付功能受影响，创建新的 Feature、Bug 或 Design Issue，而不是改写历史验收依据。

## Issue 到 Codex 的统一输入

仓库规定 Agent 先读取 Issue 和全部评论，再读取 `AGENTS.md`、Issue 明确链接的文件、代码和测试。建议使用以下任务提示：

```text
Execute GitHub Issue #<feature-issue-number>.

Authoritative context:
1. Issue #<feature-issue-number> and every GitHub comment
2. Linked Design Issue #<design-issue-number> and every comment
3. Repository and module AGENTS.md
4. docs/design/<design-issue-number>/design-spec.md
5. docs/design/<design-issue-number>/states.md and handoff/
6. Linked PRD / API / ADR, then existing code and tests

Rules:
- Do not implement while AI Ready is No.
- Do not infer unresolved product or design requirements.
- If blocked, comment [AI-QUESTION] on the relevant Issue.
- Implement the smallest change satisfying every AC.
- Preserve the approved design version and existing API contracts.
- Add or update meaningful automated tests.
- Validate the UI states, target platforms, accessibility and responsive behavior in the handoff.
- Use the existing PR template and link Closes #<feature-issue-number>.
- Record real commands, results, screenshots and remaining risks.
```

需要持续迭代的实现可以使用 Goal，但完成条件必须引用 Feature Issue 的 AC、测试和视觉证据。普通小改动使用普通 Codex 任务即可。

## PR 与设计验收

实现 PR 必须使用现有 [pull_request_template.md](../../.github/pull_request_template.md)，不新增 Claude Design 专用 PR 模板。PR 的 `Spec / Design References` 至少包含：

- `Closes #<feature-issue-number>`
- Design Issue 链接
- `docs/design/<issue-number>/design-spec.md`
- `states.md`、`handoff/` 或相关 API/ADR

PR 的 `Acceptance Criteria` 必须逐项复制 Feature Issue 的 AC，不能重新改写为无法对照的描述。 `Test Evidence` 中：

- `Screenshots / browser / device matrix` 填写真实视口、设备、状态和提交证据。
- `Design differences` 填写与 handoff 的差异、原因和后续 Issue；没有差异填写 `None`。
- 交互、键盘和异常状态不能只用静态截图证明，应提供测试、操作记录或浏览器验证。

合并前继续执行既定门槛：

```text
Build → Lint → Type Check → Unit → Integration → E2E
→ Codex QA → Codex Review → Human Supervisor → Merge
```

Codex QA 按 Feature Issue 的 AC 验收，也要检查 Design handoff 中的异常状态。QA 报告和截图作为工作流 artifact 保存。Codex Review 是额外审查，不能替代测试、分支保护或 Human Supervisor。

## 正式评论协议

所有设计和实现决策使用仓库既有前缀：

```text
[AI-PLAN]       执行计划
[AI-QUESTION]   缺失信息或行为冲突
[AI-EVIDENCE]   测试、截图、日志或代码证据
[AI-BLOCKED]    无法继续及解除条件
[HUMAN-DECISION] 人类正式决策
[AI-RESULT]     完成摘要；设计交接使用 design-ready
```

设计师不应只在 Claude Design 或私聊中反馈“这里要改”。反馈应写入 PR comment，并指向具体截图、状态或 `design-spec.md` 段落；Codex 才能基于同一份上下文修正。

## 推荐的最小落地流程

1. 产品负责人创建 Feature Issue；设计师创建关联 Design Issue。
2. 产品和设计在 Issue 中完成 Problem、Outcome、Scope、Non-goals、AC、平台和状态定义。
3. Claude Design 生成和评审方案；设计师把批准结果写入 `docs/design/<design-issue-number>/`。
4. Design Issue 留下 `[AI-RESULT] design-ready`；Feature Issue 补齐引用并设置 `AI Ready=Yes`。
5. Codex 读取 Feature Issue、Design Issue、handoff、`AGENTS.md` 和代码，实现最小切片。
6. PR 使用现有模板，逐项提供 AC、测试、截图、设备矩阵、设计差异和风险回滚。
7. CI、Codex QA、Codex Review 和 Human Supervisor 完成既定门槛后合并。
8. 设计变化回到 Issue 和版本化文件；质量证据保存在 PR 和工作流 artifact 中。

第一阶段保持 Claude Design 到 GitHub 的人工 handoff，优先验证文件结构、Issue 链接和证据完整性。只有在格式稳定、权限和导出能力明确后，才考虑自动同步；自动化不能绕过 Issue、PR、Review 或人工验收。
