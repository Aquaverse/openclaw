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
  "hint.evidencePreview": [
    "列表只显示元数据。有原文的证据可点「查看原文」预览文本（有大小上限）；完整读取经 {handle} / {read}。",
    'The list shows metadata only. Evidence with stored bytes has a "View original" button that previews text (size-limited); a full read goes through {handle} / {read}.',
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
  "col.createdAt": ["创建", "Created"],
  "col.startedAt": ["开始", "Started"],
  "col.endedAt": ["结束", "Ended"],
  "col.title": ["标题", "Title"],
  "col.detail": ["说明", "Detail"],
  "bytes.stored": ["在库", "stored"],
  "col.original": ["原文", "Original"],
  "btn.viewOriginal": ["查看原文", "View original"],
  "btn.close": ["关闭", "Close"],
  "ev.title": ["证据原文 {id}", "Evidence original {id}"],
  "ev.loading": ["正在读取……", "Reading…"],
  "ev.kind": ["类型", "Kind"],
  "ev.size": ["大小", "Size"],
  "ev.hash": ["内容哈希", "Content hash"],
  "ev.truncated": [
    "只显示前 {shown} 字节，共 {total} 字节。",
    "Showing the first {shown} of {total} bytes.",
  ],
  "ev.empty": ["（空内容）", "(empty)"],
  "ev.notText": [
    "内容不是文本，这里不预览。",
    "The content is not text, so it is not previewed here.",
  ],
  "ev.noBytes": [
    "这条证据没有原文（只有元数据，或原文已被清除）。",
    "This evidence has no stored bytes (metadata only, or the bytes were purged).",
  ],
  "ev.expired": [
    "读取句柄已过期或证据已变化，请关闭后重试。",
    "The read handle expired or the evidence changed; close this and try again.",
  ],
  "bytes.none": ["无", "none"],
  "btn.reviewDecide": ["查看并决定", "Review and decide"],
  "btn.cancel": ["取消", "Cancel"],
  "btn.newPreference": ["新增偏好", "New preference"],
  "btn.edit": ["编辑", "Edit"],
  "btn.delete": ["删除", "Delete"],

  // Files (the personal file vault tab)
  "nav.files": ["文件", "Files"],
  "title.files": ["文件", "Files"],
  "files.tab.all": ["全部", "All"],
  "files.tab.inbox": ["收件", "Inbox"],
  "files.tab.vault": ["文档库", "Library"],
  "files.tab.deliverable": ["产出", "Deliverables"],
  "files.tab.trash": ["回收站", "Trash"],
  "files.tab.damaged": ["已损坏", "Damaged"],
  "files.empty": ["这里还没有文件。", "No files here."],
  "files.usage": [
    "共 {files} 个文件，占用 {used}，写入中预留 {reserved}。",
    "{files} files, {used} stored, {reserved} reserved by writes in progress.",
  ],
  "files.shown": ["只显示前 {shown} 个，共 {total} 个。", "Showing the first {shown} of {total}."],
  "files.hintActions": [
    "文件只保存在这台电脑上。可以上传文件，或从下载、文稿等已允许的文件夹导入。标为敏感的文件不会提供给 Agent。",
    "Files stay on this computer. Upload a file, or import one from an allowed folder such as Downloads or Documents. Files marked sensitive are never offered to the Agent.",
  ],
  "files.hintReadOnly": [
    "当前连接没有写权限，只能查看文件列表。",
    "This connection cannot write, so the file list is view-only.",
  ],
  "btn.upload": ["上传文件", "Upload a file"],
  "btn.importPath": ["从本机路径导入", "Import from a path"],
  "btn.details": ["详情", "Details"],
  "btn.searchContent": ["搜索内容", "Search content"],
  "files.col.name": ["名称", "Name"],
  "files.col.folder": ["文件夹", "Folder"],
  "files.col.type": ["类型", "Type"],
  "files.col.size": ["大小", "Size"],
  "files.col.source": ["来源", "Source"],
  "files.col.state": ["状态", "State"],
  "files.col.text": ["文本", "Text"],
  "files.tx.ready": ["可搜索", "Searchable"],
  "files.tx.partial": ["可搜索（仅开头）", "Searchable (beginning only)"],
  "files.tx.pending": ["处理中", "Processing"],
  "files.tx.failed": ["提取失败", "Extraction failed"],
  "files.tx.rejected": ["不支持", "Not supported"],
  "files.tx.skipped": ["不提取", "Not extracted"],
  "files.tx.none": ["尚未处理", "Not processed yet"],
  "files.d.text": ["文本提取", "Text extraction"],
  "files.d.ref": ["引用码", "Reference code"],
  "files.d.refHint": [
    "在对话里写下这个引用码，Agent 就知道你指的是哪个文件（它只能看到名称和基本信息，看不到内容）。",
    "Write this code in a chat message so the Agent knows which file you mean (it sees the name and basic details only, never the contents).",
  ],
  "files.d.textFail": ["原因：{code}（{message}）", "Reason: {code} ({message})"],
  "files.act.retryExtract": ["重试提取", "Retry extraction"],
  "files.done.retryExtract": [
    "已重新排队提取文件 {id}。",
    "Queued file {id} for extraction again.",
  ],
  "files.pv.extracted": [
    "以下是提取出的文本（第 {page} / {pages} 页）。",
    "Extracted text (page {page} of {pages}).",
  ],
  "files.sr.title": ["按内容搜索文件", "Search files by content"],
  "files.sr.query": ["关键词", "Words"],
  "files.sr.placeholder": ["例如 发票 或 budget review", "e.g. invoice or budget review"],
  "files.sr.go": ["搜索", "Search"],
  "files.sr.searching": ["正在搜索……", "Searching…"],
  "files.sr.none": ["没有文件的内容匹配。", "No file's content matches."],
  "files.sr.found": ["找到 {n} 个文件。", "Found {n} file(s)."],
  "files.sr.notSearchable": [
    "另有 {n} 个文件暂时不能按内容搜索（处理中 {pending}、提取失败 {failed}、类型不支持 {unsupported}），所以“没找到”不代表内容里没有。",
    "{n} more file(s) cannot be searched by content yet (processing {pending}, failed {failed}, unsupported type {unsupported}), so “no match” does not mean the words are absent.",
  ],
  "files.sr.hint": [
    "只能搜索文本类文件（txt、md、csv、json、html、代码）。敏感文件不会被提取，也搜不到；Agent 只会知道哪些文件命中，看不到内容。",
    "Only text files (txt, md, csv, json, html, code) are searched. Sensitive files are never extracted or found; the Agent only learns which files match, never what they say.",
  ],
  "files.st.active": ["正常", "Active"],
  "files.st.trashed": ["在回收站", "In trash"],
  "files.st.purging": ["清除中", "Purging"],
  "files.st.damaged": ["已损坏", "Damaged"],
  "files.tag.sensitive": ["敏感", "Sensitive"],
  "files.tag.pinned": ["置顶", "Pinned"],
  "files.tag.favorite": ["收藏", "Favorite"],
  "files.coll.inbox": ["收件", "Inbox"],
  "files.coll.vault": ["文档库", "Library"],
  "files.coll.deliverable": ["产出", "Deliverable"],
  "files.gone": ["文件 {id} 已不存在，请刷新。", "File {id} no longer exists; refresh the list."],
  "files.d.title": ["文件 {id}", "File {id}"],
  "files.d.name": ["名称", "Name"],
  "files.d.folder": ["文件夹", "Folder"],
  "files.d.where": ["位置", "Where"],
  "files.d.type": ["类型", "Type"],
  "files.d.size": ["大小", "Size"],
  "files.d.hash": ["内容哈希", "Content hash"],
  "files.d.source": ["来源", "Source"],
  "files.d.created": ["导入时间", "Imported"],
  "files.d.updated": ["更新时间", "Updated"],
  "files.d.expires": ["到期", "Expires"],
  "files.d.versions": ["版本数", "Versions"],
  "files.d.sensitivity": ["敏感级别", "Sensitivity"],
  "files.act.keep": ["保留", "Keep"],
  "files.act.discard": ["丢弃", "Discard"],
  "files.act.trash": ["移入回收站", "Move to trash"],
  "files.act.restore": ["恢复", "Restore"],
  "files.act.pin": ["置顶", "Pin"],
  "files.act.unpin": ["取消置顶", "Unpin"],
  "files.act.markSensitive": ["标为敏感", "Mark sensitive"],
  "files.act.markNormal": ["标为普通", "Mark normal"],
  "files.act.save": ["保存名称和文件夹", "Save name and folder"],
  "files.act.purge": ["永久清除", "Purge permanently"],
  "files.done.keep": ["已保留文件 {id}。", "Kept file {id}."],
  "files.done.discard": ["已丢弃文件 {id}。", "Discarded file {id}."],
  "files.done.trash": ["已把文件 {id} 移入回收站。", "Moved file {id} to the trash."],
  "files.done.restore": ["已恢复文件 {id}。", "Restored file {id}."],
  "files.done.pin": ["已更新文件 {id} 的置顶。", "Updated the pin of file {id}."],
  "files.done.sensitivity": [
    "已更新文件 {id} 的敏感级别。",
    "Updated the sensitivity of file {id}.",
  ],
  "files.done.edit": ["已保存文件 {id}。", "Saved file {id}."],
  "files.done.purge": ["已永久清除文件 {id}。", "Purged file {id}."],
  "files.done.purgePending": [
    "文件 {id} 的清除已记录，还有 {n} 项没有确认完成，会在下次维护时继续。",
    "The purge of file {id} is recorded; {n} item(s) are not confirmed yet and will continue at the next maintenance pass.",
  ],
  "files.purge.ack": [
    "我明白：永久清除后无法恢复，文件内容和索引会被删除。",
    "I understand: a permanent purge cannot be undone and removes the file's content and index.",
  ],
  "files.purge.note": [
    "只保证文件库内已清除；你自己的备份、云同步和快照里的副本不受影响。",
    "This only guarantees the file is gone from the vault; copies in your own backups, cloud sync or snapshots are not touched.",
  ],
  "files.sensitiveNote": [
    "敏感文件：预览只在这里显示，不会提供给 Agent。",
    "Sensitive file: the preview is shown only here and is never offered to the Agent.",
  ],
  "files.pv.loading": ["正在读取预览……", "Reading the preview…"],
  "files.pv.notText": [
    "不是文本文件，这里不预览。",
    "This is not a text file, so it is not previewed here.",
  ],
  "files.up.title": ["上传文件", "Upload a file"],
  "files.up.pick": ["文件", "File"],
  "files.up.folder": ["文件夹（可选）", "Folder (optional)"],
  "files.up.tooBig": [
    "文件超过 {max} 字节，请改用“从本机路径导入”。",
    "The file is larger than {max} bytes; use “Import from a path” instead.",
  ],
  "files.up.send": ["上传", "Upload"],
  "files.up.done": ["已上传 {name}。", "Uploaded {name}."],
  "files.up.dedup": [
    "已上传 {name}（内容与库里已有文件相同，共用同一份存储）。",
    "Uploaded {name} (identical to a file already in the vault, so the storage is shared).",
  ],
  "files.imp.title": ["从本机路径导入", "Import from a path"],
  "files.imp.path": ["路径", "Path"],
  "files.imp.placeholder": ["例如 ~/Downloads/invoice.pdf", "e.g. ~/Downloads/invoice.pdf"],
  "files.imp.note": [
    "只能导入已配置文件夹里的普通文件，并复制一份到文件库。密钥目录、系统目录和 Nexus 状态目录会被拒绝。",
    "Only regular files inside the configured folders can be imported, and the file is copied into the vault. Credential folders, system folders and the Nexus state folder are refused.",
  ],
  "files.imp.send": ["导入", "Import"],
  "files.imp.refused": ["导入被拒绝：{reason}", "Import refused: {reason}"],
  "files.imp.done": ["已导入 {name}。", "Imported {name}."],

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
    .toSorted((a, b) => b.q - a.q || a.index - b.index);
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
