// Page text of the "清理人员" page (clear people who were deleted) and its entries in the receipts page (zh first, en second).
// Merged into the catalog through i18n-people-split.ts.
export const CLEANUP_MESSAGES = {
  "nav.cleanup": ["清理人员", "Clear people"],
  "title.cleanup": ["清理人员", "Clear people"],
  "cl.title": ["清理人员", "Clear people"],
  "cl.intro": [
    "这里只列出你已经“删除”的人。清除会永久去掉他们的联系方式、其他称呼和关系；名字保留，他们名下的承诺历史也不动。要先在“人员”页删除一个人，他才会出现在这里。",
    "Only people you have already deleted are listed. Clearing removes their contacts, other names and relations for good; the name stays and their commitment history is not touched. Delete a person on the People page first, then they show up here.",
  ],
  "cl.search.ph": ["按人名或称呼搜索", "Search by name or alias"],
  "cl.search.btn": ["搜索", "Search"],
  "cl.search.clear": ["清除搜索", "Clear search"],
  "cl.size.label": ["每页", "Per page"],
  "cl.size.option": ["{n} 人", "{n}"],
  "cl.empty": [
    "没有需要清理的人。先在“人员”页删除一个人，才会出现在这里。",
    "Nobody to clear. Delete a person on the People page first and they will appear here.",
  ],
  "cl.empty.search": ["没有找到与“{q}”对应的已删除的人。", "No deleted person matches “{q}”."],
  "cl.meta": [
    "联系方式 {contacts} 个 · 其他称呼 {aliases} 个",
    "{contacts} contacts · {aliases} other names",
  ],
  "cl.meta.reason": ["删除原因：{reason}", "Deleted because: {reason}"],
  "cl.pickPage": ["选择本页全部", "Select this page"],
  "cl.picked": ["已选 {n} 人", "{n} selected"],
  "cl.pickClear": ["取消选择", "Clear selection"],
  "cl.btn.purge": ["清除选中的人（{n}）", "Clear selected ({n})"],
  "cl.page": ["第 {page} / {pages} 页，共 {total} 人", "Page {page} of {pages}, {total} people"],
  "cl.prev": ["上一页", "Previous"],
  "cl.next": ["下一页", "Next"],
  "cl.dlg.title": ["清除 {n} 位已删除的人", "Clear {n} deleted people"],
  "cl.dlg.intro": [
    "下面这些人的联系方式、其他称呼和关系会被永久清除；名字保留，承诺历史不动。",
    "These people's contacts, other names and relations will be removed for good; the name stays and the commitment history is not touched.",
  ],
  "cl.dlg.names": ["涉及：{names}", "People: {names}"],
  "cl.dlg.namesMore": ["{names} 等 {n} 人", "{names} and {n} more"],
  "cl.dlg.loading": ["正在核对会清除什么…", "Checking what would be cleared…"],
  "cl.imp.contacts": [
    "{n} 个联系方式会被永久删除（连同它们的挂接记录 {links} 条）",
    "{n} contacts are deleted for good (with {links} attachment records)",
  ],
  "cl.imp.shared": [
    "另有 {n} 个联系方式还属于别的人：只取消这些人的挂接，联系方式本身保留",
    "{n} more contacts also belong to other people: only these people's attachment goes, the contact stays",
  ],
  "cl.imp.aliases": ["{n} 个其他称呼会被永久删除", "{n} other names are deleted for good"],
  "cl.imp.relations": ["{n} 条关系记录会被永久删除", "{n} relation records are deleted for good"],
  "cl.imp.nothing": [
    "这些人名下已经没有联系方式、其他称呼和关系，只会把他们标为“已清除”。",
    "These people no longer hold any contacts, other names or relations; they will just be marked as cleared.",
  ],
  "cl.imp.keep": [
    "名字保留；他们名下的 {n} 条承诺和 {m} 条参与记录不动，仍显示这个名字",
    "Names stay; their {n} commitments and {m} participant records are not touched and still show the name",
  ],
  "cl.imp.receipt": [
    "每一位会留一条清除回执（只有数量和名字的哈希，没有联系方式），可在“清除回执”页查看",
    "Each person leaves one receipt (counts and a hash of the name, no contacts), shown on the Purge receipts page",
  ],
  "cl.imp.final": [
    "清除不能撤销，也不能恢复这个人。",
    "This cannot be undone, and the person cannot be restored.",
  ],
  "cl.skip": [
    "有 {n} 位已经不在“已删除”状态（可能已恢复或已清除），会被跳过。",
    "{n} are no longer in the deleted state (restored or already cleared) and will be skipped.",
  ],
  "cl.ack": ["我明白：清除后不能撤销", "I understand this cannot be undone"],
  "cl.btn.go": ["永久清除", "Clear for good"],
  "cl.done": [
    "已清除 {n} 位已删除的人：联系方式 {contacts} 个、其他称呼 {aliases} 个、关系 {relations} 条。名字和承诺历史保留。",
    "Cleared {n} deleted people: {contacts} contacts, {aliases} other names, {relations} relations. Names and commitment history stay.",
  ],
  "cl.done.skipped": ["另有 {n} 位已跳过。", "{n} more were skipped."],
  "cl.err.nothing": [
    "选中的人已经不在“已删除”状态，没有可清除的内容。",
    "The selected people are no longer in the deleted state; there is nothing to clear.",
  ],
  "cl.err.readonly": [
    "这个连接是只读的，不能清除。",
    "This connection is read-only; nothing can be cleared.",
  ],
  "cl.err.read": ["读取失败：{message}", "Could not read: {message}"],
  "cl.rc.sec": ["人员清除", "People cleared"],
  "cl.rc.person": ["人员", "Person"],
  "cl.rc.counts": ["清除内容", "Cleared"],
  "cl.rc.cell": ["联系方式 {c} · 称呼 {a} · 关系 {r}", "{c} contacts · {a} names · {r} relations"],
  "cl.rc.hash": ["名字哈希", "Name hash"],
  "pp.purged.note": [
    "这个人的联系方式、其他称呼和关系已经清除，名字和承诺历史保留。已清除的人不能恢复。",
    "This person's contacts, other names and relations have been cleared; the name and the commitment history stay. A cleared person cannot be restored.",
  ],
} as const satisfies Record<string, readonly [string, string]>;
