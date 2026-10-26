import { asText } from "./as-text.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
import { DEFAULT_LANG, tr, trHtml, type Lang, type MsgKey } from "./i18n.js";
import type { EvidenceBlobView } from "./store/blob-types.js";
import type { ClaimRecord } from "./store/claim-types.js";
import type { DecisionRecord, ExecutionRecord } from "./store/decision-types.js";
// Server-rendered, read-only pages for the Control UI tab (DESIGN section 12 / Stage 4). Pure functions: data in, HTML string
// out, no I/O, no script. Everything dynamic goes through `esc`; the HTTP layer adds a strict CSP on top. These pages only
// show state - deciding, uploading and deleting stay on the RPC side, where scopes and confirmations live.
import type { PreferenceReceiptRow, PreferenceRecord } from "./store/preference-types.js";
import type { PurgeReceiptRow } from "./store/purge-types.js";
import type { TaskDetail, TaskRecord } from "./store/types.js";
import type { VaultExtractionStatus } from "./store/vault-text-types.js";
import type { VaultFileRecord, VaultStatsResult } from "./store/vault-types.js";
import type { WatchRecord } from "./store/watch-types.js";
import {
  DEFAULT_PAGE_SIZE,
  EMPTY_FILTER,
  FILTER_FIELDS,
  FILTER_PARAMS,
  TIME_PRESETS,
  filterFieldOptions,
  filterFieldValue,
  filterIsActive,
  filterToQuery,
  pageInfo,
  pageWindow,
  presetRange,
  type TaskFilter,
} from "./task-query.js";
import {
  FILE_TABS,
  fileLink,
  formatBytes,
  tabCounts,
  type FileQuery,
  type FileTab,
} from "./vault-ui.js";

export function esc(value: unknown): string {
  return asText(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function clip(value: unknown, max = 240): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("")}…`;
}

/** Local time of the machine that renders (the browser for the Control UI module, the gateway host for the HTTP page). */
export function fmtTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "-";
  }
  const d = new Date(ms);
  const two = (value: number) => String(value).padStart(2, "0");
  return (
    `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
  );
}

/** "UTC+08:00" for the zone `fmtTime` uses at that moment. */
export function tzLabel(at: Date): string {
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export type PageOptions = {
  title: string;
  basePath: string;
  nonce: string;
  active: "tasks" | "preferences" | "receipts";
  body: string;
  preferencesEnabled: boolean;
  lang?: Lang;
};

const CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1c1c1e;--muted:#6b6b72;--line:#e2e2e6;--accent:#2457d6;--warn:#b45309;--bad:#b42318;--ok:#067647}
@media (prefers-color-scheme:dark){:root{--bg:#161618;--fg:#ececf0;--muted:#9a9aa3;--line:#2e2e33;--accent:#7aa2ff;--warn:#f0a65b;--bad:#ff8a80;--ok:#5bd69a}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:16px}
nav{display:flex;gap:16px;border-bottom:1px solid var(--line);padding:8px 16px}
nav a{color:var(--muted);text-decoration:none}nav a.on{color:var(--fg);font-weight:600}
h1{font-size:20px;margin:12px 0}h2{font-size:15px;margin:20px 0 6px;color:var(--muted)}
table{border-collapse:collapse;width:100%}th,td{text-align:left;border-bottom:1px solid var(--line);padding:6px 8px;vertical-align:top}
th{color:var(--muted);font-weight:500}code,pre{font:12px/1.4 ui-monospace,monospace}pre{margin:0;white-space:pre-wrap;word-break:break-word}
a{color:var(--accent)}.muted{color:var(--muted)}.pill{border:1px solid var(--line);border-radius:10px;padding:0 8px}
.filters{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:8px 0}
.filters label{display:flex;gap:4px;align-items:center;color:var(--muted)}
.filters input,.filters select,.filters button{font:inherit;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:2px 8px}
.filters .f-keyword input{width:22em}.filters .f-from input,.filters .f-to input{width:11em}.filters .f-presets{flex-basis:100%}
.pager{margin:8px 0;display:flex;flex-wrap:wrap;gap:4px 10px;align-items:center}.pager .cur{font-weight:600}
.pending{color:var(--warn)}.bad{color:var(--bad)}.ok{color:var(--ok)}.hint{border:1px solid var(--line);border-radius:6px;padding:8px 12px;margin:8px 0}
`;

export function page(options: PageOptions): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const link = (href: string, label: MsgKey, key: PageOptions["active"]) =>
    `<a href="${esc(href)}"${options.active === key ? ' class="on"' : ""}>${esc(tr(lang, label))}</a>`;
  return [
    "<!doctype html>",
    `<html lang="${lang === "zh" ? "zh-CN" : "en"}"><head><meta charset="utf-8">`,
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${esc(options.title)}</title>`,
    `<style nonce="${esc(options.nonce)}">${CSS}</style>`,
    "</head><body>",
    "<nav>",
    link(`${options.basePath}/`, "nav.tasks", "tasks"),
    ...(options.preferencesEnabled
      ? [link(`${options.basePath}/preferences`, "nav.preferences", "preferences")]
      : []),
    link(`${options.basePath}/receipts`, "nav.receipts", "receipts"),
    "</nav>",
    `<main>${options.body}</main>`,
    "</body></html>",
  ].join("\n");
}

const STATUS_CLASS: Record<string, string> = {
  awaiting_decision: "pending",
  failed: "bad",
  succeeded: "ok",
};

export type TaskListView = {
  filter: TaskFilter;
  /** Matches across all pages. */
  total: number;
  /** Render the filter form (the HTTP page; the Control UI module builds its own controls). */
  form?: boolean;
  now?: Date;
  lang?: Lang;
  /** A time box held text that is not a date: say so instead of silently ignoring it. */
  timeProblem?: boolean;
};

function listLink(basePath: string, filter: TaskFilter, patch: Partial<TaskFilter>): string {
  return `${basePath}/${filterToQuery({ ...filter, ...patch })}`;
}

function renderFilterForm(
  filter: TaskFilter,
  basePath: string,
  now: Date,
  lang: Lang,
  timeProblem: boolean,
): string {
  const controls = FILTER_FIELDS.map((field) => {
    const value = filterFieldValue(filter, field.key);
    const name = FILTER_PARAMS[field.key];
    let control: string;
    if (field.kind === "select") {
      control =
        `<select name="${name}">` +
        filterFieldOptions(field, lang)
          .map(
            ([optionValue, label]) =>
              `<option value="${esc(optionValue)}"${optionValue === value ? " selected" : ""}>${esc(label)}</option>`,
          )
          .join("") +
        "</select>";
    } else {
      control =
        `<input type="${field.kind}" name="${name}" value="${esc(value)}"` +
        (field.placeholder ? ` placeholder="${esc(tr(lang, field.placeholder))}"` : "") +
        (field.maxLength ? ` maxlength="${field.maxLength}"` : "") +
        ">";
    }
    return `<label class="f-${field.key}">${esc(tr(lang, field.label))} ${control}</label>`;
  });
  const presets = TIME_PRESETS.map(
    ([key, label]) =>
      `<a href="${esc(listLink(basePath, filter, { ...presetRange(now, key), page: 1 }))}">${esc(tr(lang, label))}</a>`,
  );
  return (
    `<form class="filters" method="get" action="${esc(`${basePath}/`)}">` +
    controls.join("") +
    `<span class="f-actions"><button type="submit">${esc(tr(lang, "f.apply"))}</button> ` +
    `<a href="${esc(`${basePath}/`)}">${esc(tr(lang, "f.reset"))}</a></span>` +
    (timeProblem ? `<span class="f-error bad">${esc(tr(lang, "f.timeFormat"))}</span>` : "") +
    `<span class="f-presets muted">${esc(tr(lang, "f.presets", { zone: tzLabel(now) }))}${presets.join(" · ")}</span>` +
    "</form>"
  );
}

function renderPager(filter: TaskFilter, total: number, basePath: string, lang: Lang): string {
  const { page: current, pages, first, last } = pageInfo(filter, total);
  const summary = `<span class="muted">${esc(tr(lang, "pager.summary", { total, first, last, page: current, pages }))}</span>`;
  if (pages <= 1) {
    return `<p class="pager">${summary}</p>`;
  }
  const link = (label: string, target: number) =>
    `<a href="${esc(listLink(basePath, filter, { page: target }))}">${esc(label)}</a>`;
  const items: string[] = [];
  if (current > 1) {
    items.push(link(tr(lang, "pager.first"), 1), link(tr(lang, "pager.prev"), current - 1));
  }
  for (const n of pageWindow(current, pages)) {
    items.push(
      n === null
        ? '<span class="muted">…</span>'
        : n === current
          ? `<span class="cur">${n}</span>`
          : link(String(n), n),
    );
  }
  if (current < pages) {
    items.push(link(tr(lang, "pager.next"), current + 1), link(tr(lang, "pager.last"), pages));
  }
  return `<p class="pager">${summary} ${items.join(" ")}</p>`;
}

export function renderTaskList(
  tasks: readonly TaskRecord[],
  pendingByTask: ReadonlyMap<string, number>,
  basePath: string,
  view?: TaskListView,
): string {
  const lang = view?.lang ?? DEFAULT_LANG;
  const filter = view?.filter ?? EMPTY_FILTER;
  const heading = `<h1>${esc(tr(lang, "nav.tasks"))}</h1>`;
  const now = view?.now ?? new Date();
  const zone = tzLabel(now);
  const form = view?.form
    ? renderFilterForm(filter, basePath, now, lang, view.timeProblem === true)
    : "";
  if (tasks.length === 0) {
    const empty =
      view && filterIsActive(filter)
        ? `<p class="muted">${esc(tr(lang, "list.noMatch"))}<a href="${esc(`${basePath}/`)}">${esc(tr(lang, "list.clear"))}</a></p>`
        : `<p class="muted">${esc(tr(lang, "list.empty"))}</p>`;
    return heading + form + empty;
  }
  const rows = tasks.map((task) => {
    const pending = pendingByTask.get(task.id) ?? 0;
    return (
      "<tr>" +
      `<td><a href="${esc(`${basePath}/tasks/${task.id}`)}"><code>${esc(task.id)}</code></a></td>` +
      `<td>${esc(clip(task.title, 80))}</td>` +
      `<td class="${STATUS_CLASS[task.status] ?? ""}">${esc(task.status)}</td>` +
      `<td>${pending > 0 ? `<span class="pill pending">${esc(tr(lang, "list.pending", { n: pending }))}</span>` : ""}</td>` +
      `<td class="muted">${esc(fmtTime(task.createdAt))}</td>` +
      `<td class="muted">${esc(fmtTime(task.updatedAt))}</td>` +
      "</tr>"
    );
  });
  const pager = view ? renderPager(filter, view.total, basePath, lang) : "";
  const head = [
    tr(lang, "col.id"),
    tr(lang, "col.title"),
    tr(lang, "col.status"),
    "",
    tr(lang, "col.created", { zone }),
    tr(lang, "col.updated", { zone }),
  ];
  return (
    heading +
    form +
    pager +
    `<table><thead><tr>${head.map((cell) => `<th>${esc(cell)}</th>`).join("")}</tr></thead><tbody>` +
    rows.join("") +
    "</tbody></table>" +
    pager
  );
}

/** Evidence whose bytes are still stored: a blob key and not purged ("raw" is the normal state of stored bytes). */
export function hasBytes(item: Pick<EvidenceBlobView, "blobKey" | "redactionState">): boolean {
  return item.blobKey !== null && item.redactionState !== "purged";
}

export type TaskPageData = {
  detail: TaskDetail;
  decisions: readonly DecisionRecord[];
  executions: readonly ExecutionRecord[];
  claims: readonly ClaimRecord[] | undefined;
  evidence: readonly EvidenceBlobView[] | undefined;
  /** Only when the Watcher is on. */
  watches?: readonly WatchRecord[] | undefined;
  /** Emit action buttons. Only the Control UI module sets this (it confirms and calls the RPC); the HTTP page never does. */
  actions?: boolean;
  /** Offer "view original" on evidence that has bytes. Only the Control UI module sets this; it reads through the handle RPCs. */
  preview?: boolean;
};

/**
 * An action button is only a marker: a validated action name and id, nothing else. The module that mounts the markup
 * decides what the click does and rebuilds the confirmation from the record it loaded, never from these attributes.
 */
function button(act: string, id: string, label: string, extra = ""): string {
  return `<button type="button" class="nx-btn${extra}" data-nx-act="${esc(act)}" data-nx-id="${esc(id)}">${esc(label)}</button>`;
}

function section(lang: Lang, title: MsgKey, count: number | undefined, body: string): string {
  const suffix = count === undefined ? "" : lang === "zh" ? `（${count}）` : ` (${count})`;
  return `<h2>${esc(tr(lang, title))}${suffix}</h2>${body}`;
}

function table(lang: Lang, head: MsgKey[], rows: string[][]): string {
  if (rows.length === 0) {
    return `<p class="muted">${esc(tr(lang, "table.empty"))}</p>`;
  }
  return (
    `<table><thead><tr>${head.map((cell) => `<th>${esc(tr(lang, cell))}</th>`).join("")}</tr></thead><tbody>` +
    rows.map((row) => `<tr>${row.join("")}</tr>`).join("") +
    "</tbody></table>"
  );
}

const td = (value: unknown, cls = "") => `<td${cls ? ` class="${cls}"` : ""}>${esc(value)}</td>`;
const tdCode = (value: unknown) => `<td><code>${esc(value)}</code></td>`;

const OPEN_WATCH_DONE = new Set(["satisfied", "exhausted", "cancelled"]);

export function renderTaskDetail(
  data: TaskPageData,
  basePath: string,
  lang: Lang = DEFAULT_LANG,
): string {
  const { task, steps } = data.detail;
  const pending = data.decisions.filter((decision) => decision.status === "pending");
  const rest = data.decisions.filter((decision) => decision.status !== "pending");
  const code = (text: string) => `<code>${esc(text)}</code>`;
  const parts = [
    `<p><a href="${esc(`${basePath}/`)}">${esc(tr(lang, "detail.back"))}</a></p>`,
    `<h1>${esc(clip(task.title, 120))} <code class="muted">${esc(task.id)}</code></h1>`,
    `<p><span class="pill ${STATUS_CLASS[task.status] ?? ""}">${esc(task.status)}</span> ` +
      `<span class="muted">${esc(
        tr(lang, "detail.meta", {
          kind: task.kind,
          revision: task.revision,
          risk: task.riskCeiling,
          updated: fmtTime(task.updatedAt),
        }),
      )}</span></p>`,
    task.summary ? `<p>${esc(task.summary)}</p>` : "",
    section(lang, "sec.goal", undefined, `<pre>${esc(clip(task.goal, 1200))}</pre>`),
    section(lang, "sec.entities", undefined, `<pre>${esc(clip(task.entities, 1200))}</pre>`),
  ];
  const withActions = data.actions === true;
  parts.push(
    section(
      lang,
      "sec.pending",
      pending.length,
      (pending.length > 0 && !withActions
        ? `<div class="hint">${trHtml(lang, "hint.decisionReadOnly", esc, { code: code("nexus.decision.resolve") })}</div>`
        : "") +
        table(
          lang,
          [
            "col.id",
            "col.question",
            "col.type",
            "col.risk",
            "col.deadline",
            ...(withActions ? (["col.actions"] as const) : []),
          ],
          pending.map((decision) => {
            const cells = [
              tdCode(decision.id),
              td(clip(decision.question, 200)),
              td(decision.effectKind),
              td(decision.riskTier),
              td(fmtTime(decision.deadlineAt)),
            ];
            if (withActions) {
              cells.push(
                `<td>${button("decision", decision.id, tr(lang, "btn.reviewDecide"))}</td>`,
              );
            }
            return cells;
          }),
        ),
    ),
    section(
      lang,
      "sec.resolved",
      rest.length,
      table(
        lang,
        ["col.id", "col.question", "col.result", "col.source", "col.time"],
        rest.map((decision) => [
          tdCode(decision.id),
          td(clip(decision.question, 160)),
          td(decision.resolution ?? decision.status),
          td(decision.resolutionSource ?? "-"),
          td(fmtTime(decision.resolvedAt)),
        ]),
      ),
    ),
    section(
      lang,
      "sec.executions",
      data.executions.length,
      table(
        lang,
        ["col.id", "col.action", "col.status", "col.attempts", "col.time"],
        data.executions.map((execution) => [
          tdCode(execution.id),
          tdCode(execution.actionId),
          td(
            execution.state,
            execution.state === "failed" ? "bad" : execution.state === "unknown" ? "pending" : "",
          ),
          td(execution.attempts),
          td(fmtTime(execution.completedAt ?? execution.startedAt ?? execution.preparedAt)),
        ]),
      ),
    ),
  );
  if (data.claims) {
    parts.push(
      section(
        lang,
        "sec.claims",
        data.claims.length,
        table(
          lang,
          [
            "col.id",
            "col.subject",
            "col.predicate",
            "col.status",
            "col.required",
            "col.createdAt",
            "col.updatedAt",
          ],
          data.claims.map((claim) => [
            tdCode(claim.id),
            td(clip(claim.subject, 80)),
            td(claim.predicate),
            td(
              claim.state,
              claim.state === "VERIFIED" ? "ok" : claim.state === "REFUTED" ? "bad" : "",
            ),
            td(claim.requiredForCompletion ?? "-"),
            td(fmtTime(claim.createdAt)),
            td(fmtTime(claim.updatedAt)),
          ]),
        ),
      ),
    );
  }
  if (data.watches) {
    parts.push(
      section(
        lang,
        "sec.watches",
        data.watches.length,
        table(
          lang,
          [
            "col.id",
            "col.condition",
            "col.status",
            "col.checked",
            "col.nextCheck",
            "col.claim",
            ...(withActions ? (["col.actions"] as const) : []),
          ],
          data.watches.map((watch) => [
            tdCode(watch.id),
            td(clip(watch.expect, 120)),
            td(
              watch.status,
              watch.status === "satisfied" ? "ok" : watch.status === "exhausted" ? "bad" : "",
            ),
            td(`${watch.attempts}/${watch.maxAttempts}`),
            td(OPEN_WATCH_DONE.has(watch.status) ? "-" : fmtTime(watch.nextCheckAt)),
            tdCode(watch.claimId ?? "-"),
            ...(withActions
              ? [
                  OPEN_WATCH_DONE.has(watch.status)
                    ? "<td></td>"
                    : `<td>${button("watch-cancel", watch.id, tr(lang, "btn.cancel"))}</td>`,
                ]
              : []),
          ]),
        ),
      ),
    );
  }
  if (data.evidence) {
    parts.push(
      section(
        lang,
        "sec.evidence",
        data.evidence.length,
        `<p class="muted">${trHtml(lang, data.preview ? "hint.evidencePreview" : "hint.evidence", esc, { handle: code("nexus.evidence.handle"), read: code("nexus.evidence.read") })}</p>` +
          table(
            lang,
            [
              "col.id",
              "col.kind",
              "col.size",
              "col.classification",
              "col.sourceGroup",
              "col.bytes",
              "col.linked",
              "col.createdAt",
              ...(data.preview ? (["col.original"] as const) : []),
            ],
            data.evidence.map((item) => [
              tdCode(item.evidenceId),
              td(item.kind),
              td(item.byteSize === null ? "-" : `${item.byteSize} B`),
              td(item.classification),
              td(item.sourceGroup),
              td(
                hasBytes(item)
                  ? tr(lang, "bytes.stored")
                  : item.redactionState === "purged"
                    ? item.redactionState
                    : tr(lang, "bytes.none"),
              ),
              td(item.linkedClaimIds.join(", ") || "-"),
              td(fmtTime(item.capturedAt)),
              ...(data.preview
                ? [
                    hasBytes(item)
                      ? `<td>${button("evidence-view", item.evidenceId, tr(lang, "btn.viewOriginal"))}</td>`
                      : td("-"),
                  ]
                : []),
            ]),
          ),
      ),
    );
  }
  parts.push(
    section(
      lang,
      "sec.steps",
      steps.length,
      table(
        lang,
        [
          "col.seq",
          "col.kind",
          "col.status",
          "col.title",
          "col.startedAt",
          "col.endedAt",
          "col.detail",
        ],
        steps.map((step) => [
          td(step.seq),
          td(step.kind),
          td(step.status),
          td(clip(step.title, 160)),
          td(fmtTime(step.startedAt)),
          td(fmtTime(step.endedAt)),
          `<td class="muted"><pre>${esc(step.detail === null || step.detail === undefined ? "" : clip(step.detail, 300))}</pre></td>`,
        ]),
      ),
    ),
  );
  return parts.join("\n");
}

export function renderPreferences(
  preferences: readonly PreferenceRecord[],
  options: { actions?: boolean; lang?: Lang } = {},
): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const withActions = options.actions === true;
  const code = (text: string) => `<code>${esc(text)}</code>`;
  return (
    `<h1>${esc(tr(lang, "nav.preferences"))}</h1>` +
    (withActions
      ? `<div class="hint">${esc(tr(lang, "pref.hintActions"))}` +
        `${button("pref-new", "new", tr(lang, "btn.newPreference"))}</div>`
      : `<div class="hint">${trHtml(lang, "pref.hintReadOnly", esc, { set: code("nexus.preference.set"), del: code("nexus.preference.delete") })}</div>`) +
    table(
      lang,
      [
        "col.scope",
        "col.key",
        "col.value",
        "col.source",
        "col.confidence",
        "col.revision",
        "col.updatedAt",
        ...(withActions ? (["col.actions"] as const) : []),
      ],
      preferences.map((preference) => [
        td(preference.scope),
        tdCode(preference.key),
        `<td><pre>${esc(clip(preference.value, 200))}</pre></td>`,
        td(
          preference.origin === "task_exception"
            ? `task_exception (${preference.taskId ?? ""})`
            : preference.origin,
        ),
        td(preference.confidence === null ? "-" : preference.confidence),
        td(preference.revision),
        td(fmtTime(preference.updatedAt)),
        ...(withActions
          ? [
              `<td>${preference.origin === "stated" ? button("pref-edit", preference.id, tr(lang, "btn.edit")) + " " : ""}${button("pref-delete", preference.id, tr(lang, "btn.delete"))}</td>`,
            ]
          : []),
      ]),
    )
  );
}

export type FilesViewData = {
  files: readonly VaultFileRecord[];
  /** Rows matching the tab and the name filter, across everything the page did not show. */
  total: number;
  tab: FileTab;
  /** The name filter, the page (1-based) and the page size; the defaults are no filter, page 1, 20 rows. */
  name?: string;
  page?: number;
  size?: number;
  stats: Pick<VaultStatsResult, "files" | "objectBytes" | "reservedBytes">;
  /** Text extraction per file id (nexus.vault.list); absent when the gateway does not report it. */
  extraction?: Readonly<Record<string, VaultExtractionStatus>>;
};

/** The "Text" column and the dialogs show extraction in the same words. */
export function extractionLabel(
  status: Pick<VaultExtractionStatus, "state" | "failureCode"> | undefined,
): { key: MsgKey; tone: "" | "pending" | "bad" } | undefined {
  switch (status?.state) {
    case "ready":
      return status.failureCode === "truncated"
        ? { key: "files.tx.partial", tone: "" }
        : { key: "files.tx.ready", tone: "" };
    case "pending":
    case "running":
      return { key: "files.tx.pending", tone: "pending" };
    case "failed":
      return { key: "files.tx.failed", tone: "bad" };
    case "rejected":
      return { key: "files.tx.rejected", tone: "pending" };
    default:
      return undefined;
  }
}

const FAILURE_REASON = {
  unsupported_type: "files.fc.unsupported_type",
  too_large: "files.fc.too_large",
  binary_content: "files.fc.binary_content",
  undecodable: "files.fc.undecodable",
  bytes_missing: "files.fc.bytes_missing",
  extract_error: "files.fc.extract_error",
  truncated: "files.fc.truncated",
} as const satisfies Record<string, MsgKey>;

/**
 * Why extraction failed, in the console's language (English unless the user switched to Chinese). A code this build does
 * not know falls back to the server's own message, which is English.
 */
export function extractionReason(
  lang: Lang,
  status: Pick<VaultExtractionStatus, "failureCode" | "failureMessage">,
): string {
  const code = status.failureCode ?? "";
  const key = Object.hasOwn(FAILURE_REASON, code)
    ? FAILURE_REASON[code as keyof typeof FAILURE_REASON]
    : undefined;
  return key ? tr(lang, key) : (status.failureMessage ?? "-");
}

const FILE_TAB_LABEL = {
  all: "files.tab.all",
  inbox: "files.tab.inbox",
  vault: "files.tab.vault",
  deliverable: "files.tab.deliverable",
  trash: "files.tab.trash",
  damaged: "files.tab.damaged",
} as const satisfies Record<FileTab, MsgKey>;

const FILE_STATE_LABEL = {
  active: "files.st.active",
  trashed: "files.st.trashed",
  purging: "files.st.purging",
  damaged: "files.st.damaged",
} as const satisfies Record<VaultFileRecord["state"], MsgKey>;

const FILE_COLLECTION_LABEL = {
  inbox: "files.coll.inbox",
  vault: "files.coll.vault",
  deliverable: "files.coll.deliverable",
} as const satisfies Record<VaultFileRecord["collection"], MsgKey>;

/** The "Files" tab of the console. File names are user text: they only ever reach the page through `esc`. */
export function renderFiles(
  data: FilesViewData,
  options: { actions?: boolean; lang?: Lang; basePath?: string } = {},
): string {
  const lang = options.lang ?? DEFAULT_LANG;
  const withActions = options.actions === true;
  const base = options.basePath ?? "nexus-nav:";
  const counts = tabCounts(data.stats);
  const query: FileQuery = {
    tab: data.tab,
    name: data.name ?? "",
    page: data.page ?? 1,
    size: data.size ?? DEFAULT_PAGE_SIZE,
  };
  // The tabs keep the name filter and the page size, and start over at the first page.
  const tabs = FILE_TABS.map((tab) => {
    const href = fileLink(base, query, { tab, page: 1 });
    const label = `${tr(lang, FILE_TAB_LABEL[tab])} (${counts[tab]})`;
    return `<a href="${esc(href)}"${tab === data.tab ? ' class="on"' : ""}>${esc(label)}</a>`;
  });
  const tags = (file: VaultFileRecord) =>
    [
      file.sensitivity === "sensitive"
        ? `<span class="pill bad">${esc(tr(lang, "files.tag.sensitive"))}</span>`
        : "",
      file.pinnedAt !== null
        ? `<span class="pill">${esc(tr(lang, "files.tag.pinned"))}</span>`
        : "",
      file.favorite ? `<span class="pill">${esc(tr(lang, "files.tag.favorite"))}</span>` : "",
    ]
      .filter((tag) => tag !== "")
      .join(" ");
  const textCell = (file: VaultFileRecord): string => {
    const label = extractionLabel(data.extraction?.[file.id]);
    return label ? td(tr(lang, label.key), label.tone) : td("-");
  };
  const stateClass = (state: VaultFileRecord["state"]) =>
    state === "damaged" ? "bad" : state === "active" ? "" : "pending";
  const pager = renderFilePager(query, data.total, base, lang);
  const noMatch = data.files.length === 0 && query.name !== "";
  return (
    `<h1>${esc(tr(lang, "title.files"))}</h1>` +
    `<p class="muted">${esc(
      tr(lang, "files.usage", {
        files: counts.all + counts.trash + counts.damaged,
        used: formatBytes(data.stats.objectBytes),
        reserved: formatBytes(data.stats.reservedBytes),
      }),
    )}</p>` +
    `<p class="muted">${esc(tr(lang, withActions ? "files.hintActions" : "files.hintReadOnly"))}</p>` +
    (withActions
      ? `<div class="nx-filerow">${button("file-new", "new", tr(lang, "btn.upload"))}${button("file-import", "new", tr(lang, "btn.importPath"))}</div>`
      : "") +
    // The name filter is a live form the Control UI module moves into the slot; searching changes nothing, so the
    // read-only console offers it (and the content search next to it) too.
    `<div class="nx-filerow"><div class="nx-filebar-slot"></div>${button("file-search", "new", tr(lang, "btn.searchContent"))}</div>` +
    `<div class="nx-tabs">${tabs.join("")}</div>` +
    pager +
    (noMatch
      ? `<p class="muted">${esc(tr(lang, "files.noMatch"))}</p>`
      : table(
          lang,
          [
            "files.col.name",
            "files.col.folder",
            "files.col.type",
            "files.col.size",
            "files.col.source",
            "files.col.state",
            "files.col.text",
            "col.updatedAt",
            "col.actions",
          ],
          data.files.map((file) => [
            `<td>${esc(file.displayName)} ${tags(file)}</td>`,
            td(file.folder === "" ? "-" : file.folder),
            td(file.mime),
            td(formatBytes(file.size)),
            td(`${tr(lang, FILE_COLLECTION_LABEL[file.collection])} · ${file.source}`),
            td(tr(lang, FILE_STATE_LABEL[file.state]), stateClass(file.state)),
            textCell(file),
            td(fmtTime(file.updatedAt)),
            `<td>${button("file-open", file.id, tr(lang, "btn.details"))}</td>`,
          ]),
        )) +
    pager
  );
}

function renderFilePager(query: FileQuery, total: number, base: string, lang: Lang): string {
  const { page: current, pages, first, last } = pageInfo(query, total);
  const summary = `<span class="muted">${esc(tr(lang, "pager.summary", { total, first, last, page: current, pages }))}</span>`;
  if (pages <= 1) {
    return total === 0 ? "" : `<p class="pager">${summary}</p>`;
  }
  const link = (label: string, target: number) =>
    `<a href="${esc(fileLink(base, query, { page: target }))}">${esc(label)}</a>`;
  const items: string[] = [];
  if (current > 1) {
    items.push(link(tr(lang, "pager.first"), 1), link(tr(lang, "pager.prev"), current - 1));
  }
  for (const n of pageWindow(current, pages)) {
    items.push(
      n === null
        ? '<span class="muted">…</span>'
        : n === current
          ? `<span class="cur">${n}</span>`
          : link(String(n), n),
    );
  }
  if (current < pages) {
    items.push(link(tr(lang, "pager.next"), current + 1), link(tr(lang, "pager.last"), pages));
  }
  return `<p class="pager">${summary} ${items.join(" ")}</p>`;
}

export function renderReceipts(
  taskReceipts: readonly PurgeReceiptRow[],
  preferenceReceipts: readonly PreferenceReceiptRow[] | undefined,
  lang: Lang = DEFAULT_LANG,
): string {
  const parts = [
    `<h1>${esc(tr(lang, "nav.receipts"))}</h1>`,
    `<p class="muted">${esc(tr(lang, "receipts.note"))}</p>`,
    section(
      lang,
      "sec.tasks",
      taskReceipts.length,
      table(
        lang,
        [
          "col.receipt",
          "col.task",
          "col.claimEvents",
          "col.evidenceCount",
          "col.ledgerHead",
          "col.time",
        ],
        taskReceipts.map((receipt) => [
          tdCode(receipt.id),
          tdCode(receipt.taskId),
          td(receipt.claimEventCount),
          td(receipt.evidenceCount),
          tdCode((receipt.ledgerHeadDigest ?? "-").slice(0, 16)),
          td(fmtTime(receipt.executedAt)),
        ]),
      ),
    ),
  ];
  if (preferenceReceipts) {
    parts.push(
      section(
        lang,
        "sec.preferences",
        preferenceReceipts.length,
        table(
          lang,
          ["col.receipt", "col.keyHash", "col.revisionCount", "col.time"],
          preferenceReceipts.map((receipt) => [
            tdCode(receipt.id),
            tdCode(receipt.preferenceKeyHash.slice(0, 16)),
            td(receipt.revisionCount),
            td(fmtTime(receipt.executedAt)),
          ]),
        ),
      ),
    );
  }
  return parts.join("\n");
}
