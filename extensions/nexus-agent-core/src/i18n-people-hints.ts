// Page text of the W3c-3 hints (zh first, en second): "may repeat" commitments when merging, "may be the same person", the stop
// reason carried over from last time, and the helpers line / helper picker of the commitment dialogs. Merged into the catalog in i18n.ts.
export const PEOPLE_HINT_MESSAGES = {
  "pp.merge.dup": [
    "可能重复的承诺：“{a}”（{from}）和“{b}”（{name}）看起来是同一件事。合并后两条都会保留，合并后请自己看一下要不要取消其中一条。",
    "May repeat: “{a}” ({from}) and “{b}” ({name}) look like the same ask. Both stay after the merge; check afterwards whether to cancel one.",
  ],
  "pp.merge.dupMore": [
    "还有 {n} 对类似的承诺没有在这里列出。",
    "{n} more similar pairs are not listed here.",
  ],
  "pp.same.chip": ["疑似重复", "May be a duplicate"],
  "pp.same.name": ["名字一样", "same name"],
  "pp.same.alias": ["别名重合", "shared alias"],
  "pp.same.contact": ["联系方式相同", "same contact"],
  "pp.same.note": [
    "“{name}”可能和这位是同一个人（{why}）。确认是同一个人的话，用上面的“合并到…”处理；确实是两个人就不用管，这只是提醒。",
    "“{name}” may be the same person as this one ({why}). If so, use “Merge into…” above; if they really are two people, ignore this: it is only a hint.",
  ],
  "pp.same.link": ["看看“{name}”", "Open “{name}”"],
  "pp.dlg.off.prefill": [
    "原因里预填的是上次删除他时写的，请按这次的情况修改。",
    "The reason is filled in from the last time this person was deleted; change it to fit this time.",
  ],
  "cm.imp.helpers": [
    "有 {n} 位协助的人（{names}）：他们的协助记录会保留，不会被改动。",
    "{n} helpers ({names}): their records stay as they are.",
  ],
  "cm.f.helpers": ["协助的人（可选）", "People who help (optional)"],
  "cm.f.helperRole": ["协助的方式", "How they help"],
  "cm.notice.createdHelpers": [
    "已记录，并加了 {n} 位协助的人。",
    "Recorded, with {n} helpers added.",
  ],
  "cm.notice.createdHelpersPartial": [
    "已记录，但有 {n} 位协助的人没有加上（可以在承诺卡片的“协助的人”里再加）。",
    "Recorded, but {n} helpers could not be added (add them from the commitment’s “People who help”).",
  ],
} as const satisfies Record<string, readonly [string, string]>;
