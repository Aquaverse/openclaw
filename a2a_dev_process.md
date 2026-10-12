# 以 GitHub 为核心的 AI-to-AI 软件研发提效落地方案

## 摘要

本方案把 **GitHub 定义为公司研发唯一权威协作中心（Single Source of Truth）**：文件保存长期上下文，Issue 保存任务/需求/Bug 状态，PR 保存代码变更、AI 审查和验收证据；任何影响研发决策的讨论必须最终写入 GitHub Issue/PR comments。GitHub 原生支持结构化 Issue Forms、PR Template、Required Checks/Reviews、Conversation Resolution 和 Merge Queue，适合将流程本身机器化。Codex 负责代码实现、测试生成与执行、PR Review、安全检查、测试报告和 Bug 初步分析，团队成员的主要职责转变为**定义约束、监督 Agent、审批例外与最终业务验收**；Codex 已支持基于仓库的 `AGENTS.md`、CI 自动运行、结构化 JSON 输出及 GitHub PR Review。设计工作逐步从 Figma 转向 Claude Design，但最终设计意图和 handoff 仍必须沉淀到 GitHub，使 Codex 不依赖设计人员口头解释即可完成实现。

## 全公司统一运行模型

### GitHub 中三类对象的唯一职责

强制采用以下模型，而不是让 Slack、Claude/Codex 对话历史或个人文档成为隐性知识库。

| 对象         | 唯一职责                                                                  | 禁止事项                               |
| ------------ | ------------------------------------------------------------------------- | -------------------------------------- |
| **Files**    | 产品规则、技术规范、设计、AI 指令、测试策略、测试报告、架构决策、运行手册 | 不把长期有效信息只留在聊天记录         |
| **Issue**    | 需求、任务、Bug、决策入口；定义“为什么做、做到什么程度”                   | Issue 未清楚前不得直接 Coding          |
| **PR**       | 实现、验证、AI Review、测试证据和合并决策；定义“实际上改了什么”           | 不允许无 Issue 的正常功能 PR           |
| **Comments** | AI↔AI、Human↔AI、Human↔Human 的正式沟通记录                               | 不允许 Slack/会议中的决定不回写        |
| **Slack**    | `urgent / incident / security` 等紧急事件提醒，并附 GitHub 链接           | 不讨论需求、不审批方案、不形成最终决策 |

GitHub 的 Issue Forms 可以设置必填字段、默认 labels 和 assignees；PR Template 可以强制提供上下文；PR 可以用 `Closes #123` 与 Issue 关联并在合并后自动关闭；Slack 的 GitHub 集成支持 Issue、PR、Workflow 通知以及基于 label 的过滤，Slack 只订阅 `urgent`、`incident`、`security` 等异常类 label，而不订阅正常研发对话。

### 所有产品仓库统一目录

```text
/
├── AGENTS.md
├── .github/
│   ├── ISSUE_TEMPLATE/
│   │   ├── feature.yml
│   │   ├── bug.yml
│   │   ├── design.yml
│   │   └── tech-debt.yml
│   ├── pull_request_template.md
│   └── workflows/
│       ├── ci.yml
│       ├── codex-review.yml
│       ├── codex-qa.yml
│       └── quality-ledger.yml
├── .agents/
│   └── skills/
├── docs/
│   ├── product/
│   ├── specs/
│   ├── design/
│   ├── adr/
│   ├── api/
│   ├── quality/
│   │   ├── test-plans/
│   │   ├── reports/
│   │   └── bugs/
│   ├── runbooks/
│   └── AI_WORKFLOW.md
├── web/
│   └── AGENTS.md
├── backend/
│   └── AGENTS.md
├── ios/
│   └── AGENTS.md
└── android/
    └── AGENTS.md
```

Codex 会读取仓库中的 `AGENTS.md`，且目录越深的指令可以为特定模块提供更具体的上下文；OpenAI 也在实际项目中使用 `AGENTS.md + .agents/skills + GitHub Actions` 将重复工程任务转为可复现的 Agent 工作流。

### 全公司统一 Issue Contract

所有研发 Issue 至少必须包含：

| 字段                  | 要求                                    |
| --------------------- | --------------------------------------- |
| `Type`                | Feature / Bug / Design / Tech Debt      |
| `Problem`             | 当前问题，不描述解决方案                |
| `User Outcome`        | 用户完成后获得什么                      |
| `Scope`               | 本次包含内容                            |
| `Non-goals`           | 明确不做什么                            |
| `Acceptance Criteria` | 可机器验证的完成条件                    |
| `References`          | PRD / Design / API / ADR 等 GitHub 文件 |
| `Dependencies`        | 其他 Issue/API/服务                     |
| `Risk`                | low / medium / high                     |
| `Owner`               | 最终负责监督 AI 的人                    |
| `AI Ready`            | Yes/No；No 时 Codex 不允许实现          |

**Comment 协议：**

```text
[AI-PLAN]       AI准备如何执行
[AI-QUESTION]   AI发现信息不足
[AI-EVIDENCE]   测试/日志/代码证据
[AI-BLOCKED]    无法继续及原因
[HUMAN-DECISION] 人类做出的正式决策
[AI-RESULT]     AI任务完成摘要
```

原则是：**人尽量不要解释给另一个人，再让第二个人解释给 AI。** 人修改 Issue/File，Codex/Claude 等 Agent 直接读取同一份 GitHub 上下文。

### 全公司统一 PR Contract

```markdown
## Linked Issue

Closes #____

## What Changed

## Spec / Design References

## Acceptance Criteria

- [ ] ...

## Test Evidence

- Unit:
- Integration:
- E2E:
- Codex QA report:

## AI Review

- [ ] Codex review passed
- [ ] Security review passed / N/A

## Risk & Rollback

## Documentation

- [ ] Updated / N/A

## Human Supervisor

@____
```

默认 Merge Gate：

`Build → Lint → Type Check → Unit → Integration → E2E → Codex QA → Codex Review → Merge`

GitHub 可以把 status checks、PR review、conversation resolution 等配置为不可绕过的 merge 条件，并可对高并发仓库使用 Merge Queue。Codex GitHub Review 可以自动审查 PR，也可以在 PR 中使用 `@codex review` 要求专项检查。

## 需求与设计角色指南

### 角色操作表

| 角色                  | 必须维护的 Files                                                                                                 | Issue 操作                                                                                                                                          | PR 操作                                                                              | AI 工具交互                                                                                                                               | 每日例行                                                       | 验收标准                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| **产品经理 / 需求方** | `docs/product/*.md`：长期产品背景；`docs/specs/<issue>.md`：复杂功能规格                                         | 创建 Feature Issue；必填 Problem、Outcome、Scope、Non-goals、Acceptance Criteria；在 `AI Ready=Yes` 前消除 TBD；所有需求变更以 comment+文件修改完成 | 只审核“是否满足业务 Acceptance Criteria”；不审核代码实现细节                         | 先让 AI 将自然语言需求反向提问、找矛盾、生成边界案例；确认后写入 Issue；让 Codex 根据 Issue 自动拆任务                                    | 清理 `AI Ready=No`；回答 `[AI-QUESTION]`；检查需求变更是否回写 | 开发启动时 Acceptance Criteria 完整率 100%；实现阶段不得存在影响行为的 TBD；需求变化均可追溯到 comment |
| **设计师**            | `docs/design/<issue>/design-spec.md`：设计意图；`assets/`；`states.md`：页面状态；`handoff/`：Claude Design 输出 | Design Issue 必填用户流、目标平台、组件约束、loading/empty/error/permission 状态；完成后评论 `[AI-RESULT] design-ready`                             | 审核视觉/交互结果截图，不直接要求工程师口头修改；问题直接写 PR comment，让 Codex修正 | **Claude Design 为默认新设计工具**；输入 Issue + Design System，生成 prototype；最终输出 handoff bundle/截图/规格到 GitHub；Codex据此实现 | Review AI 生成设计；处理设计异常；保证所有设计变化落盘 GitHub  | 每个功能具有主流程+异常状态；Web/mobile 差异明确；PR 截图可与设计基准核查                              |

### Figma 向 Claude Design 的迁移

Anthropic 在 2026 年推出 Claude Design，其官方工作流支持根据文本、图片、文档、代码库和设计文件构建设计，可读取团队设计系统、制作交互 Prototype、组织内共享并生成给 Claude Code 的 handoff bundle。

## 研发角色指南

| 角色                          | 必须维护的 Files                                                                     | Issue 操作                                                                                          | PR 操作                                                                             | AI 工具交互                                                                                              | 每日例行                                                    | 验收标准                                                                                  |
| ----------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| **后端工程师**                | `backend/AGENTS.md`；`docs/api/openapi.`*；相关 ADR；测试目录                        | 只接受 `AI Ready` Issue；检查 API/Data/Security Acceptance；把缺失信息以 `[AI-QUESTION]` 留在 Issue | PR 必须更新 API contract、迁移说明、测试证据；Codex Review 无 blocker 才可合并      | 把 Issue URL/编号作为 Codex 主输入，不重新口述需求；让 Codex“先读取 Issue→spec→AGENTS→实现→测试→提交 PR” | 审查 Agent PR；处理 blocked；维护 backend AGENTS 中真实命令 | API contract 与实现一致；新增行为有自动测试；breaking change 必须 ADR/版本策略            |
| **前端工程师**                | `web/AGENTS.md`；组件约定；必要时 `docs/design/...` 实现备注                         | 检查设计引用、API contract、响应式与状态要求；信息不足不自行猜测                                    | 必填 screenshots、浏览器/E2E 结果、设计差异；视觉问题直接让 Codex根据 PR comment 修 | Codex读取 Claude Design handoff、截图和现有 component system；让 Codex自行视觉对照并修复                 | Review Codex UI diff；关注可访问性/异常状态/设计偏差        | 关键流程 E2E 通过；loading/empty/error 均实现；设计差异均显式说明                         |
| **移动端工程师**              | `ios/AGENTS.md`、`android/AGENTS.md`；`docs/mobile/platform-matrix.md`               | Issue 必填 iOS/Android 差异、最低 OS、权限/离线/生命周期要求                                        | PR 必填平台、设备/模拟器矩阵、截图、E2E/UI-test 结果                                | Codex分别读取平台 AGENTS；不要用通用 Prompt 隐含平台约束；让 Agent 自动生成平台特定测试                  | Review crash/权限/升级问题；监督 App 特定 Agent PR          | 指定 OS/device matrix 通过；关键流程自动测试；权限/恢复/网络异常有验证                    |
| **AI 工程师 / Prompt 工程师** | 根 `AGENTS.md`；`.agents/skills/*/SKILL.md`；`evals/`；Prompt/schema；Agent contract | Issue 必填目标行为、eval dataset、success metric、failure examples；Prompt 修改必须 Issue 化        | PR 必填 before/after eval、模型/配置变化、成本/延迟影响、failure analysis           | 用 Codex 编写/运行 eval；重复工作固化为 Skill，不把长期规则埋在个人 Prompt；输出尽量 JSON Schema 化      | 查看 agent failure；将重复人工纠正转成 eval 或 Skill        | eval 不退化；关键 Agent 行为具有 deterministic/rubric checks；失败案例进入 regression set |

repo 使用规则写入 `AGENTS.md`，所有工程 Issue 给 Codex 使用统一输入：

```text
Execute GitHub Issue #123.

Authoritative context:
1. Issue #123 and every GitHub comment
2. Repository AGENTS.md
3. Files explicitly linked by Issue #123
4. Existing code/tests

Rules:
- Do not infer unresolved product requirements.
- If blocked, comment [AI-QUESTION] on the Issue.
- Implement the smallest change satisfying acceptance criteria.
- Add/update automated tests.
- Update required documentation.
- Open a PR using repository template.
- Include test evidence and link Closes #123.
```

让**任务信息存在 GitHub，由不同 Agent 重复消费**，避免不断膨胀 `AGENTS.md`，只保留跨任务真正稳定的指令。

## 产品经理负责质量管理的指南

### 去掉传统的测试角色，由产品经理使用Codex 取代传统 QA 的标准流水线

每次 PR 自动触发：

```text
PR merged / build completed
       │
       ▼
Codex QA Agent
       │
       ├──读取 Issue Acceptance Criteria
       ├──读取代码 diff
       ├──识别缺失测试
       ├──执行/补充测试
       ├──检查异常路径
       ├──检查 API/UI/Agent behavior
       └──生成结构化 QA result
       │
       ▼
Codex PR Review（审查内容独立于 QA，当前调度在 QA 成功后串行执行）
       │
       ▼
Security Review
       │
       ├── PASS → Human Supervisor → Merge
       │
       └── FAIL
              │
              ├── PR comment
              ├── 创建 Bug Issue
              └── 写入 Quality Ledger
```

`Codex QA` 输出 schema：

```json
{
  "result": "pass|fail",
  "issue": 123,
  "pr": 456,
  "commit": "...",
  "acceptance_criteria": [
    {
      "id": "AC-1",
      "result": "pass|fail",
      "evidence": "..."
    }
  ],
  "tests_added": [],
  "tests_executed": [],
  "regressions": [],
  "bugs": [
    {
      "severity": "S1|S2|S3|S4",
      "title": "...",
      "reproduction": "...",
      "evidence": "..."
    }
  ]
}
```

Codex 非交互运行支持 JSONL 事件以及 JSON Schema 约束输出，因此这种方式比让 QA Agent 输出自由文本更容易自动检查、比较和归档。

### 测试报告与 Bug 必须成为 Codex 可访问知识

Issue / PR双层存储：

```text
GitHub Issue / PR
      │
      ├──操作状态、comments、负责人
      │
      └──链接到
           ↓
Repository files
docs/quality/
├── reports/
│   └── PR-456.md
└── bugs/
    └── BUG-789.md
```

其中：

**PR comment** 保存本次 QA Summary；**Actions Artifact** 保存大量日志、截图、coverage 等原始证据；`docs/quality/reports/PR-456.md` 保存长期可搜索摘要；**Bug Issue** 负责 workflow 状态；`docs/quality/bugs/BUG-789.md` 由自动化镜像关键上下文，供后续 Codex 读取。

GitHub Actions 原生支持将测试输出上传为 artifacts，也支持把 Markdown 测试摘要直接写到 workflow run summary。

Bug 文档采用机器友好的 front matter：

```yaml
---
issue: 789
status: open
severity: S2
source_pr: 456
affected_paths:
  - backend/auth/
reproduced_by_codex: true
fix_pr:
---
```

然后正文固定为：

```markdown
# Symptom

# Expected

# Reproduction

# Evidence

# Root-cause hypothesis

# Fix verification
```

这样修复 Agent 的输入可以极简为：

> Fix #789. Read the Issue, all comments and `docs/quality/bugs/BUG-789.md`. Reproduce first, then fix, add regression test, update bug document and open PR.

这实现真正的：

**Codex-QA → GitHub Bug → Codex-Fix → PR → Codex-Review**
