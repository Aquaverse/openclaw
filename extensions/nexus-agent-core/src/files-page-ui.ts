// The Library destination of the host's left rail, laid out like the prototype (docs/prd/design/nexus-library.html): a
// list pane (title, usage line, upload button, tab pills, file rows with a type tile) and a detail pane for the chosen
// file (name, where it came from, size, extraction state, the goals that point at it). Values go through `esc`; the only
// clickable things are `nexus-nav:` links and known action markers.
import { tr, DEFAULT_LANG, type Lang, type MsgKey } from "./i18n.js";
import type { GoalForFile } from "./store/goal-types.js";
import type { VaultExtractionStatus } from "./store/vault-text-types.js";
import type { VaultFileRecord, VaultStatsResult } from "./store/vault-types.js";
import { esc, extractionLabel, extractionReason } from "./ui-render.js";
import { VAULT_COLLECTION_LABEL, VAULT_SOURCE_LABEL, VAULT_STATE_LABEL } from "./vault-labels.js";
import {
  FILE_TABS,
  fileDownloadable,
  fileLink,
  formatBytes,
  tabCounts,
  type FileQuery,
  type FileTab,
} from "./vault-ui.js";

export type FilesPageData = {
  files: readonly VaultFileRecord[];
  total: number;
  query: FileQuery;
  stats: Pick<VaultStatsResult, "files" | "objectBytes" | "reservedBytes">;
  /** Text extraction per file id, as nexus.vault.list reported it. */
  extraction?: Readonly<Record<string, VaultExtractionStatus>>;
  /** The file the detail pane shows, with the reads that only it needs. */
  detail?: {
    file: VaultFileRecord;
    extraction?: VaultExtractionStatus;
    goals?: readonly GoalForFile[];
  };
};

export type FilesPageOptions = {
  actions?: boolean;
  lang?: Lang;
  basePath?: string;
};

const TAB_LABEL: Record<FileTab, MsgKey> = {
  all: "files.tab.all",
  inbox: "files.tab.inbox",
  vault: "files.tab.vault",
  deliverable: "files.tab.deliverable",
  trash: "files.tab.trash",
  damaged: "files.tab.damaged",
};

const COLLECTION_LABEL = VAULT_COLLECTION_LABEL;
const STATE_LABEL = VAULT_STATE_LABEL;

const two = (value: number) => String(value).padStart(2, "0");
const mmdd = (ms: number): string => {
  const d = new Date(ms);
  return `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
};

/** The type tile of a row: the file's own extension, or the media type when the name has none. */
export function fileBadge(file: Pick<VaultFileRecord, "displayName" | "mime">): string {
  const extension = /\.([A-Za-z0-9]{1,6})$/.exec(file.displayName)?.[1];
  if (extension !== undefined) {
    return extension.toUpperCase();
  }
  const subtype = file.mime.split("/")[1] ?? file.mime;
  return subtype.slice(0, 4).toUpperCase();
}

const BADGE_TONE: Record<string, string> = {
  PDF: "rose",
  PNG: "blue",
  JPG: "blue",
  JPEG: "blue",
  GIF: "blue",
  SVG: "blue",
  XLSX: "green",
  XLS: "green",
  CSV: "green",
  DOCX: "accent",
  DOC: "accent",
  PPTX: "amber",
  PPT: "amber",
  MD: "gray",
  TXT: "gray",
  ZIP: "amber",
  M4A: "gray",
  MP3: "gray",
  MP4: "gray",
};
const toneOf = (tileText: string): string => BADGE_TONE[tileText] ?? "gray";

function typeTile(file: VaultFileRecord, extra = ""): string {
  const text = fileBadge(file);
  return `<span class="nx-ftile nx-t-${toneOf(text)}${extra}">${esc(text)}</span>`;
}

function marker(act: string, id: string | undefined, className: string, inner: string): string {
  return `<button class="${className}" data-nx-act="${act}"${id === undefined ? "" : ` data-nx-id="${esc(id)}"`}>${inner}</button>`;
}

function row(file: VaultFileRecord, query: FileQuery, lang: Lang, base: string): string {
  const on = query.file === file.id ? " on" : "";
  // The date sits at the right end of the title row; the meta line says where the file lives and how big it is.
  const meta = [tr(lang, COLLECTION_LABEL[file.collection]), formatBytes(file.size)];
  const tags = [
    file.sensitivity === "sensitive" ? tr(lang, "files.tag.sensitive") : "",
    file.pinnedAt !== null ? tr(lang, "files.tag.pinned") : "",
    file.state !== "active" ? tr(lang, STATE_LABEL[file.state]) : "",
  ].filter((tag) => tag !== "");
  return (
    `<a class="nx-wrow${on}" href="${esc(fileLink(base, query, { file: file.id }))}">` +
    typeTile(file) +
    `<span class="nx-wm"><span class="nx-wt">` +
    `<span class="nx-wtt">${esc(file.displayName)}</span>` +
    `<span class="nx-wtm">${esc(mmdd(file.updatedAt))}</span></span>` +
    `<span class="nx-gmeta">${meta.map((part) => esc(part)).join(" · ")}</span>` +
    (tags.length === 0
      ? ""
      : `<span class="nx-gmeta">${tags.map((tag) => esc(tag)).join(" · ")}</span>`) +
    `</span></a>`
  );
}

function pager(query: FileQuery, total: number, base: string, lang: Lang): string {
  const size = query.size;
  const pages = Math.max(1, Math.ceil(total / size));
  if (pages <= 1) {
    return total === 0
      ? ""
      : `<p class="nx-wfoot">${esc(tr(lang, "files.count", { n: total }))}</p>`;
  }
  // Paging drops the chosen file: the row it named is not on the page being opened, and a link that kept it would make the
  // list markup depend on the selection, which the module's in-place patch reads as "another list, rebuild it".
  const link = (label: string, page: number) =>
    `<a href="${esc(fileLink(base, query, { page, file: "" }))}">${esc(label)}</a>`;
  const parts = [esc(tr(lang, "files.count", { n: total }))];
  if (query.page > 1) {
    parts.push(link(tr(lang, "pager.prev"), query.page - 1));
  }
  parts.push(`<span class="cur">${query.page} / ${pages}</span>`);
  if (query.page < pages) {
    parts.push(link(tr(lang, "pager.next"), query.page + 1));
  }
  return `<p class="nx-wfoot">${parts.join(" ")}</p>`;
}

function listPane(data: FilesPageData, lang: Lang, actions: boolean, base: string): string {
  const counts = tabCounts(data.stats);
  const tags = FILE_TABS.map((tab) => {
    const on = data.query.tab === tab ? ' class="on"' : "";
    const href = fileLink(base, data.query, { tab, page: 1, file: "" });
    return `<a${on} href="${esc(href)}">${esc(tr(lang, TAB_LABEL[tab]))}<span class="nx-n">${counts[tab]}</span></a>`;
  }).join("");
  // Uploading changes the vault; searching it does not, so the search stays on a read-only console.
  const upload =
    `<div class="nx-lh-actions">` +
    (actions
      ? marker("file-new", undefined, "nx-ib", esc(tr(lang, "btn.upload"))) +
        marker("file-import", undefined, "nx-ib", esc(tr(lang, "btn.importPath")))
      : "") +
    marker("file-search", undefined, "nx-ib", esc(tr(lang, "btn.searchContent"))) +
    `</div>`;
  const body =
    data.files.length === 0
      ? `<p class="nx-wempty">${esc(tr(lang, "files.noMatch"))}</p>`
      : data.files.map((file) => row(file, data.query, lang, base)).join("");
  return (
    `<div class="nx-wlist"><div class="nx-lh"><div class="nx-lh-head"><h1>${esc(tr(lang, "nav.rail.library"))}</h1>${upload}</div>` +
    `<p class="nx-hello">${esc(
      tr(lang, "files.usage", {
        files: counts.all + counts.trash + counts.damaged,
        used: formatBytes(data.stats.objectBytes),
        reserved: formatBytes(data.stats.reservedBytes),
      }) + (data.query.tab === "inbox" ? ` ${tr(lang, "files.inbox.keep")}` : ""),
    )}</p><div class="nx-filebar-slot"></div></div>` +
    `<div class="nx-seg">${tags}</div>` +
    `<div class="nx-rows">${body}${pager(data.query, data.total, base, lang)}</div></div>`
  );
}

function detailPane(data: FilesPageData, lang: Lang, base: string): string {
  const detail = data.detail;
  if (!detail) {
    return (
      `<div class="nx-detail"><div class="nx-dw nx-gempty">` +
      `<p class="nx-muted">${esc(tr(lang, "files.d.pick"))}</p></div></div>`
    );
  }
  const file = detail.file;
  const extraction = detail.extraction;
  const extracted = extractionLabel(extraction);
  const chips = [
    file.sensitivity === "sensitive"
      ? `<span class="nx-chip nx-rose">${esc(tr(lang, "files.tag.sensitive"))}</span>`
      : "",
    file.pinnedAt !== null
      ? `<span class="nx-chip nx-amber">${esc(tr(lang, "files.tag.pinned"))}</span>`
      : "",
    file.state !== "active"
      ? `<span class="nx-chip">${esc(tr(lang, STATE_LABEL[file.state]))}</span>`
      : "",
  ]
    .filter((chip) => chip !== "")
    .join("");
  const topActions =
    (fileDownloadable(file)
      ? marker("file-download", file.id, "nx-ib", esc(tr(lang, "btn.download")))
      : "") +
    // The manage dialog is available on a read-only console too: it shows the preview, the versions and the evidence, and
    // disables its own write buttons there.
    marker("file-open", file.id, "nx-pb", esc(tr(lang, "files.d.manage")));
  const kv: [string, string][] = [
    [tr(lang, "files.col.folder"), file.folder === "" ? "-" : file.folder],
    [tr(lang, "files.col.type"), file.mime],
    [tr(lang, "files.col.size"), formatBytes(file.size)],
    [
      tr(lang, "files.col.source"),
      `${tr(lang, COLLECTION_LABEL[file.collection])} · ${tr(lang, VAULT_SOURCE_LABEL[file.source])}`,
    ],
    [tr(lang, "col.updatedAt"), mmdd(file.updatedAt)],
    [tr(lang, "files.d.versions"), String(file.versionCount)],
  ];
  if (extracted !== undefined) {
    const reason =
      extraction !== undefined && extraction.state === "failed"
        ? ` (${extractionReason(lang, extraction)})`
        : "";
    kv.push([tr(lang, "files.col.text"), `${tr(lang, extracted.key)}${reason}`]);
  }
  const goals = detail.goals ?? [];
  const goalsBlock =
    goals.length === 0
      ? ""
      : `<div class="nx-sec"><div class="nx-sec-h"><h2>${esc(tr(lang, "files.d.goalsHead"))}</h2></div>` +
        `<div class="nx-box">${goals
          .map(
            (goal) =>
              `<a class="nx-li nx-gsub" href="${esc(`${base}/goals/${goal.id}`)}">` +
              `<span class="nx-grow">${esc(goal.title)}</span></a>`,
          )
          .join("")}</div></div>`;
  return (
    `<div class="nx-detail"><div class="nx-dw">` +
    `<div class="nx-top"><span>${esc(tr(lang, COLLECTION_LABEL[file.collection]))}</span><span>·</span>` +
    `<span>${esc(file.mime)}</span><span class="nx-sp"></span>${topActions}</div>` +
    `<div class="nx-gtitle">${typeTile(file, " lg")}<div class="nx-gtitle-m">` +
    `<h1 class="nx-wtitle">${esc(file.displayName)}</h1>` +
    `<div class="nx-why">${chips}<span>${esc(tr(lang, "files.d.updatedOn", { date: mmdd(file.updatedAt) }))}</span></div>` +
    `</div></div>` +
    `<div class="nx-sec"><div class="nx-sec-h"><h2>${esc(tr(lang, "files.d.about"))}</h2></div>` +
    `<div class="nx-box"><div class="nx-kv">${kv
      .map(
        ([key, value]) =>
          `<span class="nx-kv-k">${esc(key)}</span><span class="nx-kv-v">${esc(value)}</span>`,
      )
      .join("")}</div></div></div>` +
    goalsBlock +
    `<p class="nx-wfoot">${esc(tr(lang, "files.d.manageHint"))}</p>` +
    `</div></div>`
  );
}

/** The Library page: the file list and the chosen file beside it. */
export function renderFilesPage(data: FilesPageData, options: FilesPageOptions = {}): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const actions = options.actions === true;
  const base = options.basePath ?? "nexus-nav:";
  return (
    `<div class="nx-works ${data.detail ? "nx-picked" : "nx-auto"}">` +
    `${listPane(data, lang, actions, base)}${detailPane(data, lang, base)}</div>`
  );
}
