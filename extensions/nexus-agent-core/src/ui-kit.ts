// Shared building blocks of the new page skeleton (object-model design 11.5b), as markup strings for the pure renderers.
// The Control UI module sanitizes every string against an allow-list (div / span / p / h1 / h2 / a / button), so the kit
// uses only those tags and plain class tokens; every value goes through `esc`. No DOM and no SDK.
import type { Lang } from "./i18n.js";
import { esc } from "./ui-render.js";

export type Tone = "accent" | "blue" | "green" | "amber" | "rose" | "gray";

/** A clickable marker: a known action name plus an id. The page maps it to a dialog built from its own loaded records. */
export const marker = (
  act: string,
  id: string | undefined,
  className: string,
  inner: string,
): string =>
  `<button class="${esc(className)}" data-nx-act="${esc(act)}"${id ? ` data-nx-id="${esc(id)}"` : ""}>${inner}</button>`;

/** A status pill: a coloured dot and always a word (colour alone never carries the state). */
export const chip = (tone: Tone, text: string): string =>
  `<span class="nx-chip nx-${tone}"><span class="nx-dot"></span>${esc(text)}</span>`;

/** A tinted notice bar; `inner` is markup the caller already escaped. */
export const callout = (tone: Tone | "plain", inner: string): string =>
  `<div class="nx-callout nx-${tone}">${inner}</div>`;

/** A titled block: a small heading (with an optional action on the right) over a rounded box of rows. */
export const section = (title: string, rows: readonly string[], action = ""): string =>
  `<div class="nx-sec"><div class="nx-sec-h"><h2>${esc(title)}</h2>${action}</div>` +
  `<div class="nx-box">${rows.join("")}</div></div>`;

/** One row of a box; `inner` is markup the caller already escaped. */
export const row = (inner: string, className = ""): string =>
  `<div class="nx-li${className ? ` ${esc(className)}` : ""}">${inner}</div>`;

/** Label / value pairs. */
export const kv = (pairs: readonly (readonly [string, string])[]): string =>
  `<div class="nx-kv">${pairs
    .map(([k, v]) => `<div class="nx-kv-k">${esc(k)}</div><div class="nx-kv-v">${v}</div>`)
    .join("")}</div>`;

export type TimelineEntry = { when: string; text: string; tag?: string };

/** Date column, text, optional small source tag. */
export const timeline = (entries: readonly TimelineEntry[]): string =>
  entries
    .map(
      (e) =>
        `<div class="nx-ev"><span class="nx-ev-when">${esc(e.when)}</span>` +
        `<span class="nx-ev-text">${esc(e.text)}</span>` +
        `${e.tag ? `<span class="nx-ev-tag">${esc(e.tag)}</span>` : ""}</div>`,
    )
    .join("");

const two = (value: number) => String(value).padStart(2, "0");

/** "Today 09:30", "10-08" this year, "2025-10-08" otherwise. Local time of the machine that renders. */
export function shortTime(ms: number | null | undefined, now: number, lang: Lang): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) {
    return "-";
  }
  const d = new Date(ms);
  const n = new Date(now);
  const sameDay =
    d.getFullYear() === n.getFullYear() &&
    d.getMonth() === n.getMonth() &&
    d.getDate() === n.getDate();
  if (sameDay) {
    return `${lang === "zh" ? "今天" : "Today"} ${two(d.getHours())}:${two(d.getMinutes())}`;
  }
  const day = `${two(d.getMonth() + 1)}-${two(d.getDate())}`;
  return d.getFullYear() === n.getFullYear() ? day : `${d.getFullYear()}-${day}`;
}
