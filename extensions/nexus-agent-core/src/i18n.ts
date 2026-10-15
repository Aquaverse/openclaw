// Page text for the Nexus console, in the user's language. Two catalogs (Chinese, English); a locale this file does not
// know falls back to English, and "no locale at all" to Chinese (the plugin's home language). Identifiers the system
// itself defines (task statuses, risk tiers, RPC names, ids) are never translated: they are what the model and the logs
// say. Plain functions, no node or DOM imports, so the HTTP page and the browser module share it.
export type Lang = "zh" | "en";
export const DEFAULT_LANG: Lang = "zh";

/** `{name}` placeholders are filled from `vars`; the zh text is first, the en text second. */
const CATALOG = {
  // Navigation and page chrome
  "nav.tasks": ["事项", "Tasks"],
  "nav.preferences": ["偏好", "Preferences"],
  "nav.receipts": ["清除回执", "Purge receipts"],
  "nav.refresh": ["刷新", "Refresh"],
  "page.connecting": ["正在连接网关…", "Connecting to the gateway…"],
  "page.loadFailed": ["Nexus 读取失败：{message}", "Nexus could not load: {message}"],
  "title.tasks": ["事项", "Tasks"],
  "title.task": ["事项 {id}", "Task {id}"],
  "title.preferences": ["偏好", "Preferences"],
  "title.receipts": ["清除回执", "Purge receipts"],
  "title.httpTasks": ["Nexus 事项", "Nexus tasks"],
  "title.httpTask": ["Nexus 事项 {id}", "Nexus task {id}"],
  "title.httpPreferences": ["Nexus 偏好", "Nexus preferences"],
  "title.httpReceipts": ["Nexus 清除回执", "Nexus purge receipts"],

  // Task list
  "list.empty": ["还没有事项。", "No tasks yet."],
  "list.noMatch": ["没有符合条件的事项。", "No tasks match."],
  "list.clear": ["清除筛选", "Clear filters"],
  "list.pending": ["{n} 待决策", "{n} pending"],
  "col.created": ["创建（{zone}）", "Created ({zone})"],
  "col.updated": ["更新（{zone}）", "Updated ({zone})"],
  "pager.summary": [
    "共 {total} 条，第 {first}–{last} 条（第 {page} / {pages} 页）",
    "{total} in total, showing {first}–{last} (page {page} of {pages})",
  ],
  "pager.first": ["« 首页", "« First"],
  "pager.prev": ["‹ 上一页", "‹ Previous"],
  "pager.next": ["下一页 ›", "Next ›"],
  "pager.last": ["末页 »", "Last »"],

  // Filter bar
  "f.id": ["编号", "ID"],
  "f.title": ["标题", "Title"],
  "f.keyword": ["关键字", "Keyword"],
  "f.status": ["状态", "Status"],
  "f.from": ["创建自", "Created from"],
  "f.to": ["至", "to"],
  "f.size": ["每页", "Per page"],
  "f.id.ph": ["如 T89A", "e.g. T89A"],
  "f.title.ph": ["标题包含", "title contains"],
  "f.keyword.ph": [
    "标题 / 目标 / 摘要 / 要素，空格分隔",
    "title / goal / summary / entities, space-separated",
  ],
  "f.date.ph": ["YYYY-MM-DD HH:mm", "YYYY-MM-DD HH:mm"],
  "f.timeFormat": [
    "时间格式应为 YYYY-MM-DD 或 YYYY-MM-DD HH:mm（本地时间）。",
    "Time must look like YYYY-MM-DD or YYYY-MM-DD HH:mm (local time).",
  ],
  "f.sizeOption": ["{n} 条", "{n}"],
  "f.apply": ["筛选", "Filter"],
  "f.reset": ["重置", "Reset"],
  "f.presets": ["创建时间（{zone} 本地时间）：", "Created ({zone} local time): "],
  "preset.today": ["今天", "Today"],
  "preset.7d": ["近 7 天", "Last 7 days"],
  "preset.30d": ["近 30 天", "Last 30 days"],

  // Task detail
  "detail.back": ["← 事项", "← Tasks"],
  "detail.meta": [
    "{kind} · 版本 {revision} · 风险上限 {risk} · 更新 {updated}",
    "{kind} · revision {revision} · risk ceiling {risk} · updated {updated}",
  ],
  "sec.goal": ["目标", "Goal"],
  "sec.entities": ["要素", "Entities"],
  "sec.pending": ["待决策", "Pending decisions"],
  "sec.resolved": ["已处理的决策", "Resolved decisions"],
  "sec.executions": ["执行", "Executions"],
  "sec.claims": ["声明（claim）", "Claims"],
  "sec.watches": ["回检（watch）", "Watches"],
  "sec.evidence": ["证据", "Evidence"],
  "sec.steps": ["步骤日志", "Step log"],
  "sec.tasks": ["事项", "Tasks"],
  "sec.preferences": ["偏好", "Preferences"],
  "hint.decisionReadOnly": [
    "在这里只能查看。批准或拒绝请在控制台调用 {code}（需要 operator.write）。",
    "View only here. To approve or deny, call {code} from the console (needs operator.write).",
  ],
  "hint.evidence": [
    "这里不显示证据内容；读取原文需要经 {handle} / {read}。",
    "Evidence content is not shown here; reading the original goes through {handle} / {read}.",
  ],
  "table.empty": ["没有记录。", "No records."],
  "col.id": ["编号", "ID"],
  "col.question": ["问题", "Question"],
  "col.type": ["类型", "Type"],
  "col.risk": ["风险", "Risk"],
  "col.deadline": ["截止", "Deadline"],
  "col.actions": ["操作", "Actions"],
  "col.result": ["结果", "Result"],
  "col.source": ["来源", "Source"],
  "col.time": ["时间", "Time"],
  "col.action": ["动作", "Action"],
  "col.status": ["状态", "Status"],
  "col.attempts": ["尝试", "Attempts"],
  "col.subject": ["对象", "Subject"],
  "col.predicate": ["谓词", "Predicate"],
  "col.required": ["完成条件", "Required for completion"],
  "col.condition": ["条件", "Condition"],
  "col.checked": ["已查/上限", "Checked / max"],
  "col.nextCheck": ["下次检查", "Next check"],
  "col.claim": ["声明", "Claim"],
  "col.size": ["大小", "Size"],
  "col.classification": ["密级", "Classification"],
  "col.sourceGroup": ["来源组", "Source group"],
  "col.bytes": ["字节", "Bytes"],
  "col.linked": ["挂到", "Linked to"],
  "col.kind": ["类型", "Type"],
  "col.seq": ["#", "#"],
  "col.updatedAt": ["更新", "Updated"],
  "col.title": ["标题", "Title"],
  "col.detail": ["说明", "Detail"],
  "bytes.stored": ["在库", "stored"],
  "bytes.none": ["无", "none"],
  "btn.reviewDecide": ["查看并决定", "Review and decide"],
  "btn.cancel": ["取消", "Cancel"],
  "btn.newPreference": ["新增偏好", "New preference"],
  "btn.edit": ["编辑", "Edit"],
  "btn.delete": ["删除", "Delete"],

  // Preferences and receipts
  "pref.hintActions": [
    "偏好只改变默认选项，不构成授权。在这里新增或修改的偏好会记为你亲自声明（stated）。",
    "A preference only changes the defaults and grants nothing. Preferences you add or edit here are recorded as stated by you.",
  ],
  "pref.hintReadOnly": [
    "偏好只改变默认选项，不构成授权。修改或删除请调用 {set} / {del}。",
    "A preference only changes the defaults and grants nothing. To change or delete one, call {set} / {del}.",
  ],
  "col.scope": ["范围", "Scope"],
  "col.key": ["键", "Key"],
  "col.value": ["值", "Value"],
  "col.confidence": ["置信度", "Confidence"],
  "col.revision": ["版本", "Revision"],
  "receipts.note": [
    "这里只记录你主动执行过的彻底清除（nexus.task.purge / nexus.preference.purge）。回执证明清除确实发生过，但只保留哈希和数量，不保留内容；被清除的内容无法恢复。没有执行过彻底清除时这里是空的。",
    "This lists only the hard purges you ran yourself (nexus.task.purge / nexus.preference.purge). A receipt proves a purge happened but keeps only hashes and counts, never the content, and purged content cannot be recovered. It stays empty until you run a hard purge.",
  ],
  "col.receipt": ["回执", "Receipt"],
  "col.task": ["事项", "Task"],
  "col.claimEvents": ["声明事件", "Claim events"],
  "col.evidenceCount": ["证据", "Evidence"],
  "col.ledgerHead": ["链尾摘要", "Ledger head digest"],
  "col.keyHash": ["键哈希", "Key hash"],
  "col.revisionCount": ["历史条数", "Revisions"],

  // Dialogs: shared
  "dlg.approve": ["批准", "Approve"],
  "dlg.deny": ["拒绝", "Deny"],
  "dlg.save": ["保存", "Save"],
  "dlg.task": ["事项", "Task"],
  "dlg.question": ["问题", "Question"],
  "dlg.type": ["类型", "Type"],
  "dlg.risk": ["风险", "Risk"],
  "dlg.deadline": ["截止", "Deadline"],
  "dlg.facts": ["事实", "Facts"],
  "dlg.options": ["选项", "Options"],
  "dlg.scope": ["范围", "Scope"],
  "dlg.key": ["键", "Key"],
  "dlg.value": ["值", "Value"],
  "dlg.source": ["来源", "Source"],
  "dlg.condition": ["条件", "Condition"],
  "dlg.status": ["状态", "Status"],

  // Decision dialog
  "decision.title": ["处理待决策 {id}", "Resolve decision {id}"],
  "decision.gone": [
    "{id} 已不在待决策列表里，已刷新。",
    "{id} is no longer pending; the page was refreshed.",
  ],
  "decision.which": ["批准哪个动作", "Action to approve"],
  "decision.choose": ["请选择…", "Choose…"],
  "decision.ack": [
    "这是 {risk} 决策：我已核对上面的动作和影响，同意授权。",
    "This is an {risk} decision: I have checked the action and its effects above and I authorize it.",
  ],
  "decision.warn": [
    "批准会产生真实授权；拒绝是终局，Agent 不会再就同一件事重复询问。",
    "Approving grants real authority. Denying is final: the agent will not ask again about the same thing.",
  ],
  "resolve.approved": ["已批准 {id}。", "Approved {id}."],
  "resolve.approvedReady": [
    "已批准 {id}（执行 {exec} 已就绪，等 Agent 提交）。",
    "Approved {id} (execution {exec} is ready; waiting for the agent to commit it).",
  ],
  "resolve.denied": ["已拒绝 {id}。", "Denied {id}."],
  "resolve.already": [
    "{id} 已经被处理过，没有再次改变。",
    "{id} was already resolved; nothing changed.",
  ],
  "resolve.superseded": [
    "{id} 已失效：{reason}。请看最新的待决策。",
    "{id} is no longer valid: {reason}. See the latest pending decisions.",
  ],
  "resolve.supersededReason": ["事项已变化", "the task changed"],
  "resolve.expired": ["{id} 已过期。", "{id} has expired."],
  "resolve.unsupported": [
    "当前配置不支持这类决策的效果，未批准。",
    "This configuration does not support the effect of this decision; it was not approved.",
  ],
  "resolve.applyFailed": [
    "批准没有生效：{message}。",
    "The approval did not take effect: {message}.",
  ],
  "resolve.applyFailedMessage": ["效果应用失败", "the effect could not be applied"],
  "resolve.unexpected": ["意外的返回：{outcome}。", "Unexpected reply: {outcome}."],
  "resolve.none": ["无", "none"],

  // Watch dialog
  "watch.gone": [
    "{id} 已不在回检列表里，已刷新。",
    "{id} is no longer in the watch list; the page was refreshed.",
  ],
  "watch.title": ["取消回检 {id}", "Cancel watch {id}"],
  "watch.cancel": ["取消回检", "Cancel watch"],
  "watch.cancelled": ["已取消回检 {id}。", "Cancelled watch {id}."],
  "watch.state": ["{status}（已查 {attempts}/{max}）", "{status} (checked {attempts}/{max})"],
  "watch.note": [
    "取消后不再回检，对应的定时任务会被删除。",
    "Once cancelled it is no longer checked, and its scheduled job is removed.",
  ],

  // Preference dialogs
  "pref.gone": [
    "{id} 已不在偏好列表里，已刷新。",
    "{id} is no longer in the preference list; the page was refreshed.",
  ],
  "pref.deleteTitle": ["删除偏好", "Delete preference"],
  "pref.deleted": ["已删除偏好 {scope} / {key}。", "Deleted preference {scope} / {key}."],
  "pref.deleteNote": [
    "删除后这条偏好不再生效，历史修订保留；要彻底清除请用 nexus.preference.purge（operator.admin）。",
    "Once deleted the preference no longer applies, but its revision history is kept. To purge it completely use nexus.preference.purge (operator.admin).",
  ],
  "pref.editTitle": ["编辑偏好", "Edit preference"],
  "pref.newTitle": ["新增偏好", "New preference"],
  "pref.valueJson": ["值（JSON）", "Value (JSON)"],
  "pref.placeholder": ['例如 "简体中文" 或 {"seat":"aisle"}', 'e.g. "English" or {"seat":"aisle"}'],
  "pref.statedNote": [
    "保存后这条偏好的来源记为 stated（你亲自声明）。偏好只改变默认选项，不构成授权。",
    "Once saved, this preference is recorded as stated (declared by you). A preference only changes the defaults and grants nothing.",
  ],
  "pref.unchanged": ["值没有变化。", "The value did not change."],
  "pref.saved": [
    "已保存偏好 {scope} / {key}（{outcome}）。",
    "Saved preference {scope} / {key} ({outcome}).",
  ],
  "pref.onlyStated": [
    "只有你亲自声明（stated）的偏好可以在这里编辑，已刷新。",
    "Only preferences you declared yourself (stated) can be edited here; the page was refreshed.",
  ],
  "pref.badScope": [
    "范围只能是 global 或 domain:名称（小写字母、数字、._-）。",
    "Scope must be global or domain:name (lowercase letters, digits, ._-).",
  ],
  "pref.badKey": [
    "键需以小写字母或数字开头，只含小写字母、数字、._-，最长 64。",
    "Key must start with a lowercase letter or digit and use only lowercase letters, digits and ._-, up to 64 characters.",
  ],
  "pref.badJson": [
    "值必须是合法的 JSON（字符串要带引号）。",
    "The value must be valid JSON (strings need quotes).",
  ],
  "pref.tooLong": [
    "值太长（{bytes} 字节，上限 {max}）。",
    "The value is too long ({bytes} bytes, limit {max}).",
  ],
} as const satisfies Record<string, readonly [string, string]>;

export type MsgKey = keyof typeof CATALOG;

/** Locale tag (`zh-CN`, `en-US`, `de`…) to a language we have text for. */
export function resolveLang(tag: string | null | undefined): Lang {
  const base = (tag ?? "").trim().toLowerCase();
  if (base === "") {
    return DEFAULT_LANG;
  }
  return base.startsWith("zh") ? "zh" : "en";
}

/** The best language in an Accept-Language header: the highest quality value we can serve, else the default. */
export function langFromAcceptLanguage(header: string | null | undefined): Lang {
  if (!header || header.trim() === "") {
    return DEFAULT_LANG;
  }
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = Number(/q=([0-9.]+)/.exec(params.join(";"))?.[1] ?? "1");
      return { tag: tag.trim(), q: Number.isFinite(q) ? q : 0, index };
    })
    .filter((entry) => entry.tag !== "" && entry.tag !== "*" && entry.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index);
  const first = ranked[0];
  return first ? resolveLang(first.tag) : DEFAULT_LANG;
}

function fill(
  template: string,
  vars: Record<string, string | number>,
  wrap: (text: string) => string,
  raw: boolean,
) {
  return template
    .split(/(\{\w+\})/)
    .map((part) => {
      const name = /^\{(\w+)\}$/.exec(part)?.[1];
      if (name === undefined || !(name in vars)) {
        return wrap(part);
      }
      return raw ? String(vars[name]) : wrap(String(vars[name]));
    })
    .join("");
}

/** Plain text with `{name}` placeholders filled. */
export function tr(lang: Lang, key: MsgKey, vars: Record<string, string | number> = {}): string {
  const entry = CATALOG[key];
  return fill(lang === "zh" ? entry[0] : entry[1], vars, (text) => text, false);
}

/**
 * HTML: the catalog text is escaped, and the values are inserted as given, so the caller passes already-safe markup
 * (an escaped string or a `<code>` element). A value is never taken from the catalog.
 */
export function trHtml(
  lang: Lang,
  key: MsgKey,
  escape: (text: string) => string,
  markup: Record<string, string> = {},
): string {
  const entry = CATALOG[key];
  return fill(lang === "zh" ? entry[0] : entry[1], markup, escape, true);
}

export function allMessageKeys(): MsgKey[] {
  return Object.keys(CATALOG) as MsgKey[];
}
