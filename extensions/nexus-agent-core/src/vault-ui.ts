// Pure helpers for the console's "Files" tab, shared by the page renderer (src/ui-render.ts) and the browser module
// (browser/). No node or DOM imports: this file is bundled into the Control UI module as well.
import type { VaultFileRecord, VaultFileState, VaultStatsResult } from "./store/vault-types.js";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "./task-query.js";

/** An upload carries the file as base64 in one RPC frame; the gateway frame limit is 25 MiB, so stay well under it. */
export const VAULT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
const MAX_PAGE = 100_000;
const MAX_NAME = 200;

export const FILE_TABS = ["all", "inbox", "vault", "deliverable", "trash", "damaged"] as const;
export type FileTab = (typeof FILE_TABS)[number];
export const DEFAULT_FILE_TAB: FileTab = "all";

export function parseFileTab(raw: string | null | undefined): FileTab {
  return (FILE_TABS as readonly string[]).includes(raw ?? "") ? (raw as FileTab) : DEFAULT_FILE_TAB;
}

/** What the Files tab shows: one tab, an optional file-name filter, and a page of the result. */
export type FileQuery = { tab: FileTab; name: string; page: number; size: number };
export const DEFAULT_FILE_QUERY: FileQuery = {
  tab: DEFAULT_FILE_TAB,
  name: "",
  page: 1,
  size: DEFAULT_PAGE_SIZE,
};

/** Host page parameters (and link query keys) of a file query. */
export const FILE_PARAMS = { tab: "tab", name: "qname", page: "page", size: "size" } as const;

function cleanName(raw: string | undefined): string {
  let out = "";
  for (const ch of raw ?? "") {
    const code = ch.codePointAt(0) ?? 0;
    out += code < 0x20 || code === 0x7f ? " " : ch;
  }
  return out.trim().slice(0, MAX_NAME);
}

/** Reads a file query from any string source (host props, a link's query); every field is validated. */
export function parseFileQuery(read: (name: string) => string | undefined): FileQuery {
  const page = Number(read(FILE_PARAMS.page));
  const size = Number(read(FILE_PARAMS.size));
  return {
    tab: parseFileTab(read(FILE_PARAMS.tab)),
    name: cleanName(read(FILE_PARAMS.name)),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

/** Only the non-default fields, so the plain tab keeps a plain URL. */
export function fileQueryToParams(query: FileQuery): Record<string, string> {
  const out: Record<string, string> = {};
  if (query.tab !== DEFAULT_FILE_TAB) {
    out[FILE_PARAMS.tab] = query.tab;
  }
  if (query.name !== "") {
    out[FILE_PARAMS.name] = query.name;
  }
  if (query.page > 1) {
    out[FILE_PARAMS.page] = String(query.page);
  }
  if (query.size !== DEFAULT_PAGE_SIZE) {
    out[FILE_PARAMS.size] = String(query.size);
  }
  return out;
}

/** A link to the Files tab with these parts of the query changed (a page change keeps the rest). */
export function fileLink(base: string, query: FileQuery, change: Partial<FileQuery> = {}): string {
  const qs = new URLSearchParams(fileQueryToParams({ ...query, ...change })).toString();
  return `${base}/files${qs === "" ? "" : `?${qs}`}`;
}

/** The nexus.vault.list parameters behind one query. */
export function fileListParams(query: FileQuery): Record<string, unknown> {
  const base = {
    limit: query.size,
    offset: (query.page - 1) * query.size,
    pinnedFirst: true,
    ...(query.name === "" ? {} : { nameContains: query.name }),
  };
  switch (query.tab) {
    case "inbox":
    case "vault":
    case "deliverable":
      return { ...base, collection: query.tab, state: "active" };
    case "trash":
      return { ...base, state: "trashed" };
    case "damaged":
      return { ...base, state: "damaged" };
    default:
      return { ...base, state: "active" };
  }
}

/** File counts per tab, from the `collection:state` keys of nexus.vault.stats. */
export function tabCounts(stats: Pick<VaultStatsResult, "files">): Record<FileTab, number> {
  const counts: Record<FileTab, number> = {
    all: 0,
    inbox: 0,
    vault: 0,
    deliverable: 0,
    trash: 0,
    damaged: 0,
  };
  for (const [key, value] of Object.entries(stats.files)) {
    const [collection, state] = key.split(":");
    if (state === "active") {
      counts.all += value;
      if (collection === "inbox" || collection === "vault" || collection === "deliverable") {
        counts[collection] += value;
      }
    } else if (state === "trashed") {
      counts.trash += value;
    } else if (state === "damaged") {
      counts.damaged += value;
    }
  }
  return counts;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "-";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export type FileAction =
  | "keep"
  | "discard"
  | "edit"
  | "pin"
  | "sensitivity"
  | "trash"
  | "restore"
  | "purge";

/** Which actions the detail dialog offers for a file in its current state. The RPCs still re-check every one. */
export function fileActionsFor(file: Pick<VaultFileRecord, "state" | "collection">): FileAction[] {
  const state: VaultFileState = file.state;
  if (state === "active") {
    return file.collection === "inbox"
      ? ["keep", "discard", "edit", "pin", "sensitivity", "purge"]
      : ["edit", "pin", "sensitivity", "trash", "purge"];
  }
  if (state === "trashed") {
    return ["restore", "purge"];
  }
  if (state === "damaged") {
    return ["purge"];
  }
  return [];
}

/** Types whose first bytes are worth trying as a text preview. The decoder still refuses anything that is not text. */
export function maybeText(mime: string): boolean {
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime === "application/xml" ||
    mime === "application/x-yaml" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml") ||
    mime === "application/octet-stream"
  );
}
