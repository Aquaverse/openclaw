// Page text of the corrections that pull things apart on the People page: split one record into two people, and move a contact
// that was attached to the wrong person (zh first, en second). Merged into the catalog in i18n.ts.
import { CLEANUP_MESSAGES } from "./i18n-cleanup.js";

export const PEOPLE_SPLIT_MESSAGES = {
  "pp.btn.split": ["拆分…", "Split…"],
  "pp.btn.cmove": ["挂错了人", "Wrong person"],
  "pp.btn.splitDo": ["拆分", "Split"],
  "pp.btn.splitAnother": ["确认是另一个人，仍然拆分", "This is someone else, split anyway"],
  "pp.btn.cmoveDo": ["更正", "Correct"],
  "pp.dlg.split": ["拆分“{name}”", "Split “{name}”"],
  "pp.split.none": [
    "这条记录下面没有可以拆分的内容；如果只是想多一个人，请用“添加人员”。",
    "There is nothing here to split. To add one more person, use “Add a person”.",
  ],
  "pp.split.intro": [
    "“{name}”这条记录其实是两个人？先给新的那位起个名字，再选出属于他的联系方式、称呼和承诺；没选的都留在“{name}”名下。",
    "Does “{name}” actually hold two people? Name the new one, then pick the contacts, names and commitments that are theirs; whatever you leave unpicked stays with “{name}”.",
  ],
  "pp.split.name": ["新的那位叫什么", "Who the new person is"],
  "pp.split.contacts": ["属于新的那位的联系方式", "Contacts that belong to the new person"],
  "pp.split.aliases": ["属于新的那位的其他称呼", "Other names that belong to the new person"],
  "pp.split.commitments": ["属于新的那位的承诺", "Commitments that belong to the new person"],
  "pp.split.tagOpen": ["进行中", "Open"],
  "pp.split.tagDone": ["已结案", "Closed"],
  "pp.split.pick": [
    "选好之后，这里会写明会改什么。",
    "Once you have picked, what would change is written here.",
  ],
  "pp.split.i.empty": [
    "还没有选任何内容：只会新建一个空白的人，什么都不移动。",
    "Nothing is picked: this only adds an empty person and moves nothing.",
  ],
  "pp.split.i.open": [
    "{n} 条进行中的承诺改归新的那位：这是另一个人的责任，会开始新的责任版本，已告知和对方回应清零。",
    "{n} open commitments go to the new person. It is another person's responsibility, so each starts a new version (told and response states reset).",
  ],
  "pp.split.i.done": [
    "{n} 条已结案的承诺改归新的那位：结果不变，不重新核验。",
    "{n} closed commitments go to the new person; their result stays and is not judged again.",
  ],
  "pp.split.i.contacts": [
    "{n} 个联系方式改挂到新的那位，只向后生效，原来的挂接留作历史。",
    "{n} contacts are attached to the new person from now on; the old attachment stays as history.",
  ],
  "pp.split.i.aliases": ["{n} 个称呼改归新的那位。", "{n} names go to the new person."],
  "pp.split.i.kept": [
    "留在“{name}”名下：{open} 条进行中、{done} 条已结案的承诺，{contacts} 个联系方式。",
    "Staying with “{name}”: {open} open and {done} closed commitments, {contacts} contacts.",
  ],
  "pp.split.i.links": [
    "{n} 条参与记录（工作里的参与人）不会移动，仍在“{name}”名下；需要的话到工作里重新关联。",
    "{n} participant records (people in Works) do not move and stay with “{name}”; re-link them in the Work if needed.",
  ],
  "pp.split.i.work": ["会影响工作：{title}", "Reaches the Work: {title}"],
  "pp.split.i.final": [
    "拆分后不能直接撤销；已重置的责任版本不会恢复。",
    "A split cannot be undone directly, and responsibility versions that were reset do not come back.",
  ],
  "pp.notice.split": [
    "已把“{name}”拆开，新的那位是“{created}”。",
    "“{name}” is split; the new person is “{created}”.",
  ],
  "pp.dlg.cmove": ["这个联系方式挂错了人", "This contact is on the wrong person"],
  "pp.cmove.intro": [
    "{contact} 现在挂在“{name}”名下。它其实属于谁？",
    "{contact} is attached to “{name}” now. Whose is it really?",
  ],
  "pp.cmove.pick": ["改挂到", "Attach it to"],
  "pp.cmove.nobody": [
    "它不属于任何已知的人，只取消现在的挂接",
    "It belongs to nobody we know: only end the attachment",
  ],
  "pp.cmove.start": [
    "它一开始就挂错了：把通过它读到的证据重新判断一遍",
    "It was wrong from the start: judge the evidence read through it again",
  ],
  "pp.cmove.startHint": [
    "不勾选：只从现在起生效，之前的事件仍按当时的挂接核对。",
    "Unticked: it counts only from now on; earlier events are still checked against what was attached then.",
  ],
  "pp.cmove.i.dup": [
    "“{name}”已经有同样的联系方式，两条合成一条。",
    "“{name}” already has this contact; the two become one.",
  ],
  "pp.cmove.i.fromNow": [
    "从现在起，这个联系方式不再属于“{name}”；原来的挂接留作历史。",
    "From now on this contact is no longer “{name}”’s; the old attachment stays as history.",
  ],
  "pp.cmove.i.start": [
    "通过它读到的 {n} 条证据会被搁置并重新判断，涉及 {m} 个承诺，其中 {v} 个已核验完成。",
    "{n} pieces of evidence read through it are set aside and judged again, from {m} commitments ({v} already verified complete).",
  ],
  "pp.cmove.i.none": [
    "目前没有通过它读到的证据，所以“从一开始”和“从现在起”结果相同。",
    "No evidence has been read through it yet, so “from the start” and “from now on” come to the same.",
  ],
  "pp.cmove.i.safe": [
    "不会发送任何消息，也不会扩大任何外发授权。",
    "Nothing is sent and no outbound permission is widened.",
  ],
  "pp.notice.cmove": ["已把联系方式改挂到“{name}”。", "The contact is now attached to “{name}”."],
  "pp.notice.cmoveNobody": [
    "已取消这个联系方式的挂接。",
    "The attachment of this contact is ended.",
  ],
  // The clear-people page and the person section of the receipts page (i18n-cleanup.ts)
  ...CLEANUP_MESSAGES,
} as const satisfies Record<string, readonly [string, string]>;
