// The markup of the "清理人员" page and of the person section of the receipts page. Pure functions (data in, markup out).
// The list itself (search box, tick boxes, pager) is built with DOM calls in browser/cleanup-view.ts and put into the slot this
// skeleton leaves; the sanitizer admits no form controls.
import type { CounterpartPurgeReceipt } from "./counterpart/types.js";
import { DEFAULT_LANG, tr, type Lang } from "./i18n.js";
import { esc, fmtTime } from "./ui-render.js";

/** Rows per page of the clear-people list; the default is the one the page opens with. */
export const CLEANUP_PAGE_SIZES = [20, 50, 100] as const;
export const CLEANUP_DEFAULT_SIZE = 50;

/** The page skeleton: a heading, the intro and an empty slot the list is mounted into. */
export function renderCleanup(lang: Lang = DEFAULT_LANG): string {
  return (
    `<h1>${esc(tr(lang, "cl.title"))}</h1>` +
    `<p class="muted">${esc(tr(lang, "cl.intro"))}</p>` +
    `<div class="nx-cleanup-slot"></div>`
  );
}

type ReceiptLine = CounterpartPurgeReceipt & { displayName: string };

/** The people-cleared section of the receipts page (appended after the task and preference sections). */
export function renderPersonReceipts(
  receipts: readonly ReceiptLine[],
  total: number,
  lang: Lang = DEFAULT_LANG,
): string {
  const count = lang === "zh" ? `（${total}）` : ` (${total})`;
  const head = `<h2>${esc(tr(lang, "cl.rc.sec"))}${count}</h2>`;
  if (receipts.length === 0) {
    return `${head}<p class="muted">${esc(tr(lang, "table.empty"))}</p>`;
  }
  const th = (key: Parameters<typeof tr>[1]) => `<th>${esc(tr(lang, key))}</th>`;
  const rows = receipts.map(
    (r) =>
      `<tr><td><code>${esc(r.id)}</code></td><td>${esc(r.displayName || r.counterpartId)}</td>` +
      `<td>${esc(tr(lang, "cl.rc.cell", { c: r.contactCount, a: r.aliasCount, r: r.relationCount }))}</td>` +
      `<td><code>${esc(r.nameHash.slice(0, 16))}</code></td><td>${esc(fmtTime(r.executedAt))}</td></tr>`,
  );
  return (
    head +
    `<table><thead><tr>${th("col.receipt")}${th("cl.rc.person")}${th("cl.rc.counts")}${th("cl.rc.hash")}${th("col.time")}</tr></thead>` +
    `<tbody>${rows.join("")}</tbody></table>`
  );
}
