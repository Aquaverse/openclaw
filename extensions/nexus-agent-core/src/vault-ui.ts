// Pure helpers for the console's "Files" tab, shared by the page renderer (src/ui-render.ts) and the browser module
// (browser/). No node or DOM imports: this file is bundled into the Control UI module as well.
import type { VaultFileRecord, VaultFileState, VaultStatsResult } from "./store/vault-types.js";

/** An upload carries the file as base64 in one RPC frame; the gateway frame limit is 25 MiB, so stay well under it. */
export const VAULT_UPLOAD_MAX_BYTES = 16 * 1024 * 1024;
/** The file list asks for at most this many rows (the RPC's own maximum). */
export const FILES_PAGE_LIMIT = 200;

export const FILE_TABS = ["all", "inbox", "vault", "deliverable", "trash", "damaged"] as const;
export type FileTab = (typeof FILE_TABS)[number];
export const DEFAULT_FILE_TAB: FileTab = "all";

export function parseFileTab(raw: string | null | undefined): FileTab {
  return (FILE_TABS as readonly string[]).includes(raw ?? "") ? (raw as FileTab) : DEFAULT_FILE_TAB;
}

/** The nexus.vault.list parameters behind one tab. */
export function fileListParams(tab: FileTab): Record<string, unknown> {
  const base = { limit: FILES_PAGE_LIMIT, pinnedFirst: true };
  switch (tab) {
    case "inbox":
    case "vault":
    case "deliverable":
      return { ...base, collection: tab, state: "active" };
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
