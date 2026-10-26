// Pure helpers for the console's "Files" tab, shared by the page renderer (src/ui-render.ts) and the browser module
// (browser/). No node or DOM imports: this file is bundled into the Control UI module as well.
import type {
  VaultFileRecord,
  VaultFileState,
  VaultSensitivity,
  VaultStatsResult,
} from "./store/vault-types.js";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "./task-query.js";
import { parseFileKind, type FileKind } from "./vault-kind.js";

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

/**
 * What the Files tab shows: one tab, optional filters (file name, kind, favorites only, sensitivity) and a page of the
 * result. `kind` and `sensitivity` are "" for "any".
 */
export type FileQuery = {
  tab: FileTab;
  name: string;
  kind: FileKind | "";
  favorite: boolean;
  sensitivity: VaultSensitivity | "";
  page: number;
  size: number;
};
export const DEFAULT_FILE_QUERY: FileQuery = {
  tab: DEFAULT_FILE_TAB,
  name: "",
  kind: "",
  favorite: false,
  sensitivity: "",
  page: 1,
  size: DEFAULT_PAGE_SIZE,
};

/** Host page parameters (and link query keys) of a file query. */
export const FILE_PARAMS = {
  tab: "tab",
  name: "qname",
  kind: "qkind",
  favorite: "qfav",
  sensitivity: "qsens",
  page: "page",
  size: "size",
} as const;

/** The parts a search changes (everything but the tab and the page). */
export type FileFilters = Pick<FileQuery, "name" | "kind" | "favorite" | "sensitivity" | "size">;

/** Whether any filter narrows the list (the page size and the tab do not). */
export function fileFilterActive(
  query: Pick<FileQuery, "name" | "kind" | "favorite" | "sensitivity">,
) {
  return query.name !== "" || query.kind !== "" || query.favorite || query.sensitivity !== "";
}

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
    kind: parseFileKind(read(FILE_PARAMS.kind)) ?? "",
    favorite: read(FILE_PARAMS.favorite) === "1",
    sensitivity: ((raw) => (raw === "sensitive" || raw === "normal" ? raw : ""))(
      read(FILE_PARAMS.sensitivity),
    ),
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
  if (query.kind !== "") {
    out[FILE_PARAMS.kind] = query.kind;
  }
  if (query.favorite) {
    out[FILE_PARAMS.favorite] = "1";
  }
  if (query.sensitivity !== "") {
    out[FILE_PARAMS.sensitivity] = query.sensitivity;
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
    ...(query.kind === "" ? {} : { kind: query.kind }),
    ...(query.favorite ? { favorite: true } : {}),
    ...(query.sensitivity === "" ? {} : { sensitivity: query.sensitivity }),
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
  | "favorite"
  | "sensitivity"
  | "trash"
  | "restore"
  | "purge";

/** Which actions the detail dialog offers for a file in its current state. The RPCs still re-check every one. */
export function fileActionsFor(file: Pick<VaultFileRecord, "state" | "collection">): FileAction[] {
  const state: VaultFileState = file.state;
  if (state === "active") {
    return file.collection === "inbox"
      ? ["keep", "discard", "edit", "pin", "favorite", "sensitivity", "purge"]
      : ["edit", "pin", "favorite", "sensitivity", "trash", "purge"];
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

/** Whether the bytes can be read back for a download: an active or trashed file (a trashed file is still the user's). */
export function fileDownloadable(file: Pick<VaultFileRecord, "state">): boolean {
  return file.state === "active" || file.state === "trashed";
}

/** The most the console downloads through the gateway connection (the bytes are held in the page until saved). */
export const VAULT_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024;

const FILE_NAME_FORBIDDEN = /[/\\:*?"<>|]/g;

/** Control characters (C0 and DEL) become underscores too; done by code point so no control character sits in a pattern. */
function replaceControlChars(text: string): string {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f ? "_" : char;
  }).join("");
}
const FILE_NAME_MAX = 200;

/**
 * The name a download is saved under: the file's own name made safe for any file system (no path separators, control or
 * reserved characters, no leading dots), with `-v<n>` before the extension for an older version.
 */
export function downloadFileName(displayName: string, version?: number): string {
  let name = replaceControlChars(displayName).replace(FILE_NAME_FORBIDDEN, "_").trim();
  name = name.replace(/^\.+/, "").replace(/[. ]+$/, "");
  if (name === "") {
    name = "file";
  }
  if (name.length > FILE_NAME_MAX) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
    name = name.slice(0, FILE_NAME_MAX - ext.length) + ext;
  }
  if (version !== undefined) {
    const dot = name.lastIndexOf(".");
    name = dot > 0 ? `${name.slice(0, dot)}-v${version}${name.slice(dot)}` : `${name}-v${version}`;
  }
  return name;
}
