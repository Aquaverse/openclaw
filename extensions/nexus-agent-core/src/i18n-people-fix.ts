// Page text of the identity corrections on the People page: merging two records of one person, and saying a typed name "is not
// a person" (zh first, en second). Merged into the catalog in i18n.ts.
export const PEOPLE_FIX_MESSAGES = {
  "pp.btn.merge": ["合并到…", "Merge into…"],
  "pp.dlg.merge": ["合并“{name}”", "Merge “{name}”"],
  "pp.merge.intro": [
    "只有“确实是同一个人”才合并。合并后，这条记录会收起（留一个“已合并到…”的标记），他的承诺、联系方式和名字都归到保留下来的那一位名下。",
    "Merge only when these are really the same person. This record folds away (leaving an “merged into…” marker); its commitments, contacts and names go to the person who stays.",
  ],
  "pp.merge.keep": ["保留哪一位", "Who stays"],
  "pp.merge.pick": [
    "先选保留下来的那一位，下面会写明合并会改什么。",
    "Pick who stays; what the merge changes is listed below.",
  ],
  "pp.merge.none": [
    "没有可以合并进去的同类记录（只能合并同一类型的两条记录）。",
    "There is no other record of the same type to merge into.",
  ],
  "pp.merge.open": [
    "{n} 条未结案的承诺、{m} 条已结案的承诺，改记在 {name} 名下。这是同一个人，所以责任版本不变，已告知和对方回应都保留。",
    "{n} open and {m} closed commitments move to {name}. It is the same person, so the responsibility version and the told / response states stay.",
  ],
  "pp.merge.noCommitments": ["他名下没有承诺。", "Nothing is recorded under this person."],
  "pp.merge.names": [
    "“{from}”和他的别名会成为 {name} 的别名，以后用这些名字也能找到他。",
    "“{from}” and its aliases become aliases of {name}.",
  ],
  "pp.merge.contacts": [
    "{n} 条联系方式归到 {name} 名下（其中 {shared} 条两边都有，合成一条）。",
    "{n} contact notes move to {name} ({shared} are on both sides and become one).",
  ],
  "pp.merge.links": [
    "{n} 处工作或承诺里的参与记录一并归过去。",
    "{n} participation records in Works or commitments move too.",
  ],
  "pp.merge.work": ["牵涉的工作：{title}", "Work affected: {title}"],
  "pp.merge.rel": [
    "两边写的关系不一样，请选一个保留：",
    "The two records state different relations; choose the one to keep:",
  ],
  "pp.merge.relPick": ["请选择", "Choose"],
  "pp.merge.relTarget": ["保留 {name} 的：{rel}", "Keep {name}’s: {rel}"],
  "pp.merge.relSource": ["保留“{from}”的：{rel}", "Keep “{from}”’s: {rel}"],
  "pp.merge.final": [
    "合并不能直接撤销（拆开要用“拆分”，这个功能还没有）。两条各自独立的承诺不会被合成一条。",
    "A merge cannot be undone directly (splitting apart is not built yet). Two separate commitments are never merged into one.",
  ],
  "pp.btn.mergeDo": ["合并", "Merge"],
  "pp.notice.merged": ["已把“{from}”合并到“{name}”。", "Merged “{from}” into “{name}”."],
  "pp.merged.note": [
    "这条记录已合并到另一位，不再单独使用。",
    "This record was merged into another person and is no longer used on its own.",
  ],
  "pp.merged.go": ["打开保留下来的那一位", "Open the person who stayed"],
  "pp.chip.merged": ["已合并", "Merged"],
  "pp.err.relconf": [
    "机构或团队不能是下属或同事：请同时把“关系”改成客户、供应商、其他，或者清除。",
    "An organization or team cannot be a direct report or colleague: change the relation too (client, supplier, other) or clear it.",
  ],
  "pp.err.choice": [
    "两边写的关系不一样，请先选择保留哪一个。",
    "The relations differ; choose which one to keep first.",
  ],
  "pp.pend.not": ["这不是一个人…", "Not a person…"],
  "pp.dlg.not": ["“{name}”不是一个人", "“{name}” is not a person"],
  "pp.not.what": [
    "“{name}”这个称呼下有 {n} 条未结案的承诺。它指的是什么？",
    "“{name}” has {n} open commitments. What does it stand for?",
  ],
  "pp.not.org": ["一个组织（公司、部门等）", "An organization (company, department…)"],
  "pp.not.team": ["一个团队或共享邮箱", "A team or shared mailbox"],
  "pp.not.self": ["其实是我自己负责", "It is actually mine"],
  "pp.not.dismiss": [
    "不对应任何责任人（如“会场”“待定”）",
    "Nobody is responsible (e.g. “the venue”, “TBD”)",
  ],
  "pp.not.name": ["新记录的名称", "Name of the new record"],
  "pp.not.orgDesc": [
    "新建一条机构记录，这些承诺改指向它。名字本来就对得上，所以承诺原样保留，已告知和对方回应不变。",
    "Creates an organization record and points these commitments at it. The name already matches, so told and response states stay.",
  ],
  "pp.not.teamDesc": [
    "新建一条团队记录，这些承诺改指向它。名字本来就对得上，所以承诺原样保留，已告知和对方回应不变。",
    "Creates a team record and points these commitments at it. The name already matches, so told and response states stay.",
  ],
  "pp.not.selfDesc": [
    "未结案的承诺改成由你负责，算新的责任版本，已告知和对方回应会清零；已结案的保持原样。",
    "Open commitments become yours with a new responsibility version (told / response start over); closed ones stay as they are.",
  ],
  "pp.not.dismissDesc": [
    "承诺继续显示“责任人待定”，只是这个称呼不再出现在“待确认人员”里；以后可以在“已忽略的称呼”里恢复。",
    "The commitments keep showing “responsible: to be confirmed”; the name just stops waiting here. You can bring it back under “Ignored names”.",
  ],
  "pp.btn.notDo": ["确认", "Confirm"],
  "pp.btn.notAnother": ["仍然新建这条记录", "Create it anyway"],
  "pp.not.taken": [
    "已经有记录叫这个名字（见上方）。如果确实是另一个，请点“仍然新建这条记录”。",
    "A record with this name already exists (above). If this is another one, use “Create it anyway”.",
  ],
  "pp.notice.notMoved": ["已处理 {n} 条承诺。", "{n} commitments handled."],
  "pp.notice.notSelf": [
    "{n} 条未结案的承诺改成了由你负责。",
    "{n} open commitments are now yours.",
  ],
  "pp.notice.dismissed": [
    "已忽略“{name}”，它不再出现在待确认人员里。",
    "“{name}” is ignored and no longer waits in “To confirm”.",
  ],
  "pp.dis.title": ["已忽略的称呼", "Ignored names"],
  "pp.dis.restore": ["恢复", "Bring back"],
  "pp.dis.note": [
    "这些称呼被你标成“不对应任何责任人”，它们下面的承诺仍显示“责任人待定”。",
    "You said these names point at nobody; their commitments still show “responsible: to be confirmed”.",
  ],
  "pp.notice.restored": ["“{name}”又回到待确认人员里了。", "“{name}” is back under “To confirm”."],
} as const satisfies Record<string, readonly [string, string]>;
