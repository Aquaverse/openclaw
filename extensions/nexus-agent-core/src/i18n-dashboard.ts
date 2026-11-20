// Page text of the Dashboard, the rail's first destination (zh first, en second). Merged into the catalog in i18n.ts.
// The dashboard only observes: every number here is read from the Work, Decision, Goal and Counterpart APIs, and each one
// links to the page that acts on it. Nothing is written from this page.
export const DASHBOARD_MESSAGES = {
  // The rail entry and the page title.
  "nav.rail.dashboard": ["仪表盘", "Dashboard"],
  "title.dashboard": ["仪表盘", "Dashboard"],
  "dash.unavailable": ["这个网关没有开启工作功能。", "Work is not enabled on this gateway."],
  // The greeting is the page's heading; the hour of the clock picks it.
  "dash.greet.morning": ["早上好", "Good morning"],
  "dash.greet.noon": ["中午好", "Good day"],
  "dash.greet.afternoon": ["下午好", "Good afternoon"],
  "dash.greet.evening": ["晚上好", "Good evening"],
  "dash.sum.decisions": ["{n} 项待你决策", "{n} waiting for your decision"],
  "dash.sum.active": ["{n} 项进行中", "{n} in progress"],
  "dash.sum.overdue": ["{n} 项已逾期", "{n} overdue"],
  "dash.openWorkbench": ["打开工作台", "Open the workbench"],
  // The six numbers. The last one has no tone: it is the whole account, not something to act on.
  "dash.kpi.decisions": ["待我决策", "Decisions"],
  "dash.kpi.needs": ["待你处理", "Needs you"],
  "dash.kpi.blocked": ["受阻", "Blocked"],
  "dash.kpi.active": ["进行中", "In progress"],
  "dash.kpi.done": ["已完成", "Done"],
  "dash.kpi.total": ["全部工作", "All work"],
  // Sections.
  "dash.decisions.title": ["待你决策", "Waiting for your decision"],
  "dash.decisions.empty": ["现在没有需要你决定的事。", "Nothing needs your decision right now."],
  "dash.decisions.more": ["还有 {n} 项，去工作台处理", "{n} more in the workbench"],
  "dash.attention.title": ["需要关注", "Needs attention"],
  "dash.attention.empty": ["没有受阻或逾期的工作。", "Nothing is blocked or overdue."],
  "dash.recent.title": ["最近更新", "Recently updated"],
  "dash.recent.empty": [
    "还没有工作。告诉助理要做什么，它会建起第一条。",
    "No work yet. Tell the assistant what to do and it will start the first one.",
  ],
  "dash.aside.goals": ["目标", "Goals"],
  "dash.aside.goals.empty": ["还没有目标。", "No goals yet."],
  "dash.aside.goals.links": ["{n} 项工作", "{n} work items"],
  "dash.aside.people": ["协作提醒", "Collaborators to check"],
  "dash.aside.people.empty": [
    "和你共事的人没有待处理的事。",
    "Nobody you work with has anything waiting.",
  ],
  "dash.aside.people.confirm": ["{n} 项待确认", "{n} to confirm"],
  "dash.aside.people.overdue": ["{n} 项逾期", "{n} overdue"],
  "dash.all": ["查看全部", "See all"],
  // A decision card: the deadline and the risk tier, when the record carries them.
  "dash.decision.due": ["截止 {when}", "Due {when}"],
  "dash.decision.risk": ["风险 {tier}", "Risk {tier}"],
  "dash.risk.low": ["低", "low"],
  "dash.risk.medium": ["中", "medium"],
  "dash.risk.high": ["高", "high"],
} as const satisfies Record<string, readonly [string, string]>;
