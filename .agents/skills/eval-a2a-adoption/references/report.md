# 报告与计算输入（v4）

## 报告内容

`report.md` 独立说明仓库、采集起止时间、时区、标准 SHA/本地 diff、观察窗口、已证实等级和待评估的升级条件。必须区分：

1. **Issue 格式**：最新 50 个样本的编号/创建时间/选样依据、逐项格式检查与证据、pass/fail/unknown 数，40/50 判定。无 PR 或 CI 证据不影响此项。
2. **周产出**：四周每周 Feature/Bug、Estimate、TBD=0 的编号、其他未知点数、纳入/排除原因及首次有效验收关闭。合格不要求产出；良好不要求 CI/QA 工作流通过，但仍需明确业务验收证据。每周三项 AND、四周 AND。
3. **优秀级文件/流程**：文件引用图、缺失/未知/五项可选排除；最新 10 PR 与关联 Issue 的过程证据及最终 head/实际合并 SHA。缺失、违规、unknown 单列，只限制优秀。无需执行的阶段标未评估，不填零冒充已采集。
4. **限制与改进**：不足样本、权限/分页/artifact 缺口、采集期间变化、本地未发布规则、删除/转移不可还原记录、窗口早于采用时间。等级不代表业务价值或整个历史的认证。

报告链接 `assessment.json`、`rating.json`、逐项检查及原始数据。每条判定含规则来源、事实、证据和适用性，指标可从明细重算。

## assessment.json

使用 schema_version=4；v2 的样本 result 混合格式与流程，v3 使用 20/18 门槛且不把数量不足判失败，均须重新选样和判定，不能只改版本号迁移。以下为合法的未完成采集输入示例，不代表真实项目结论：

```json
{
  "schema_version": 4,
  "repository": "OWNER/REPO",
  "evaluated_at": "2026-10-16T02:00:00Z",
  "timezone": "Asia/Shanghai",
  "file_integrity": {
    "result": "unknown",
    "complete": false,
    "files": [
      {
        "path": "a2a_dev_process.md",
        "status": "unknown",
        "chain": ["a2a_dev_process.md"],
        "reason": "尚未读取",
        "evidence": []
      }
    ]
  },
  "collection": {
    "issue_selection_complete": false,
    "pr_selection_complete": false,
    "excellence_complete": false,
    "metrics_complete": false
  },
  "samples": { "issues": [], "prs": [] },
  "excellence": { "result": "unknown", "reason": "尚未核查优秀级流程", "evidence": [] },
  "deliveries": [],
  "limitations": ["未完成采集，不能将空数组解释为实际零产出"]
}
```

### 字段约定

- `evaluated_at` 为冻结选样的采集开始时刻，带 UTC offset；报告另记结束时间。
- `file_integrity` 按 file-integrity.md 保存完整清单及引用边；根文件必须在清单。每个目标唯一，status=pass/missing/unknown/na，chain 从根至目标，evidence 保存 source:line 与版本核验。unknown/na 须有 reason。任一 missing → fail；否则有 unknown/递归未完 → unknown；否则 pass。此字段只参与优秀级，不提前判不合格。
- `collection.issue_selection_complete` 表示已确认最新 50 个非 PR Issue 的准确归属；若不足 50 个，只有完整分页至耗尽、确认仓库总数确实不足并保留证据时才能为 true，此时脚本判不合格。分页/权限失败或调用方自行截取较少数据时须为 false。
- `samples.issues` 最多 50 个，按 created_at/number 降序，每条包含 number、created_at、result、evidence。**result 仅表示格式**，不含 CI、实施顺序或验收。对象内任一适用格式项 fail 则对象 fail；无 fail 但有 unknown 则 unknown。
- `samples.prs` 最多 10 个，同排序与基本字段，result 表示优秀级 PR 过程检查；未执行可为空。Issue 与 PR 编号不得重叠。关联支撑对象存另表，不扩展样本。
- `collection.pr_selection_complete`、`excellence_complete` 分别表示最新 PR 归属与优秀级必要证据完整；`excellence.result=pass` 须两者 true、满 10 PR 且全 pass；语义检查明细另存。归属未确认的候选违规不能确证优秀级 fail。文件缺失可独立阻止优秀。
- `excellence` 为优秀级过程结论 result=pass/fail/unknown、reason、evidence；已确认最新 PR 有 fail 时必须为 fail。文件结果另外由脚本组合为 `excellent_gate`。
- `collection.metrics_complete` 仅在四周候选、事件及必要验收证据完整时 true；未查不能用空数组证明零产出。
- `deliveries` 保存全部候选的人工判定，含 number、type、eligible 和 evidence。`eligible=false` 须 reason；`eligible=null` 表示资格未知，阻止确认更高产出等级。首次符合条件的有效关闭只保留一次；取消/父子重复/返工有排除依据。
- `eligible=true` 须 Type=Feature/Bug、accepted_closed_at、estimate、estimate_confirmed 布尔值和验收/关闭证据。**estimate="TBD" 按 0**，不受 estimate_confirmed=false 影响；具体合法点数仅在 estimate_confirmed=true 时累计。其他缺失/非法/具体点数未确认记 unknown，不能按 0。
- 相同编号的相同交付记录仅去重；冲突记录拒绝。不回填历史 Estimate、不把 TBD 当作已确认具体点数或已获实施许可。

## rating.json 与完整性

脚本计算 `issue_format`（固定 50 样本、40 pass）、`excellent_gate`、周边界/指标/差距、`tbd_zero_estimates`、`unknown_estimates`、`sample_counts`、`metrics_complete`、`rating` 和 `status`。

- Issue 选样已确认且满 50：pass≥40 → 合格条件成立；fail≥11 → 不合格；其他情况未知。完整分页确认总数不足 50 时 `rating=不合格, status=complete`；选样/总数未确认时 rating=null。
- 格式通过：先判断优秀周指标 + excellent_gate=pass，再判断良好周指标，否则保留合格。CI/文件 fail 不使合格或良好失效。
- 周统计未知时，`rating=合格, status=incomplete` 是已证实下限，仍待确认能否升级。已达到良好而优秀指标也达到、但流程 unknown 时，`rating=良好, status=incomplete`。
- 完整周统计不达更高门槛，或更高门槛已确证 fail 时，可 `status=complete`，即使未执行无关优秀级检查。40 pass 后另外 10 个格式 unknown 也不影响已满足的门槛。
- 未完整采集时 weeks 中的 0 仅代表可见明细的已确认值，报告必须显示未评估/下限，不声称真实零产出。TBD 的 0 则是明确统计规则。
