import { describe, expect, it } from "vitest";
import type { VaultFileRecord } from "./store/vault-types.js";
import { renderFiles } from "./ui-render.js";
import {
  DEFAULT_FILE_TAB,
  FILE_TABS,
  fileActionsFor,
  fileListParams,
  formatBytes,
  maybeText,
  parseFileTab,
  tabCounts,
} from "./vault-ui.js";

const file = (overrides: Partial<VaultFileRecord> = {}): VaultFileRecord => ({
  id: "F1ABC",
  objectId: "O1",
  displayName: "tax.pdf",
  folder: "Taxes/2025",
  collection: "vault",
  state: "active",
  source: "upload",
  sourceRef: null,
  sensitivity: "normal",
  sensitivityBy: "user",
  importedBy: "operator:console",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_000_000,
  trashedAt: null,
  expiresAt: null,
  size: 2048,
  mime: "application/pdf",
  contentHash: "sha256:abc",
  versionCount: 1,
  pinnedAt: null,
  favorite: false,
  lastOpenedAt: null,
  ...overrides,
});

const stats = {
  files: {
    "inbox:active": 2,
    "vault:active": 5,
    "deliverable:active": 1,
    "vault:trashed": 3,
    "vault:damaged": 1,
    "vault:purging": 4,
  },
  objectBytes: 5 * 1024 * 1024,
  reservedBytes: 0,
};

describe("vault ui helpers", () => {
  it("falls back to the default tab for anything unknown", () => {
    expect(parseFileTab(undefined)).toBe(DEFAULT_FILE_TAB);
    expect(parseFileTab(null)).toBe(DEFAULT_FILE_TAB);
    expect(parseFileTab("../etc")).toBe(DEFAULT_FILE_TAB);
    for (const tab of FILE_TABS) {
      expect(parseFileTab(tab)).toBe(tab);
    }
  });

  it("maps every tab to list parameters the RPC accepts", () => {
    expect(fileListParams("all")).toMatchObject({ state: "active", pinnedFirst: true, limit: 200 });
    expect(fileListParams("all")).not.toHaveProperty("collection");
    expect(fileListParams("inbox")).toMatchObject({ collection: "inbox", state: "active" });
    expect(fileListParams("deliverable")).toMatchObject({
      collection: "deliverable",
      state: "active",
    });
    expect(fileListParams("trash")).toMatchObject({ state: "trashed" });
    expect(fileListParams("damaged")).toMatchObject({ state: "damaged" });
  });

  it("counts files per tab from the stats keys and ignores purging rows", () => {
    expect(tabCounts(stats)).toEqual({
      all: 8,
      inbox: 2,
      vault: 5,
      deliverable: 1,
      trash: 3,
      damaged: 1,
    });
  });

  it("formats sizes", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(2048)).toBe("2.0 KiB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatBytes(-1)).toBe("-");
    expect(formatBytes(Number.NaN)).toBe("-");
  });

  it("offers only the actions that fit the file's state", () => {
    expect(fileActionsFor({ state: "active", collection: "inbox" })).toEqual([
      "keep",
      "discard",
      "edit",
      "pin",
      "sensitivity",
      "purge",
    ]);
    expect(fileActionsFor({ state: "active", collection: "vault" })).toContain("trash");
    expect(fileActionsFor({ state: "active", collection: "vault" })).not.toContain("keep");
    expect(fileActionsFor({ state: "trashed", collection: "vault" })).toEqual(["restore", "purge"]);
    expect(fileActionsFor({ state: "damaged", collection: "vault" })).toEqual(["purge"]);
    expect(fileActionsFor({ state: "purging", collection: "vault" })).toEqual([]);
  });

  it("only previews text-like types", () => {
    expect(maybeText("text/plain")).toBe(true);
    expect(maybeText("application/json")).toBe(true);
    expect(maybeText("application/vnd.api+json")).toBe(true);
    expect(maybeText("application/octet-stream")).toBe(true);
    expect(maybeText("application/pdf")).toBe(false);
    expect(maybeText("image/png")).toBe(false);
  });
});

describe("renderFiles", () => {
  it("never turns a file name or folder into markup", () => {
    const html = renderFiles(
      {
        files: [file({ displayName: "<img src=x onerror=alert(1)>.pdf", folder: "<b>x</b>" })],
        total: 1,
        tab: "all",
        stats,
      },
      { actions: true },
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>x</b>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.pdf");
  });

  it("links every tab through the nexus-nav placeholder and marks the current one", () => {
    const html = renderFiles({ files: [], total: 0, tab: "trash", stats });
    expect(html).toContain('href="nexus-nav:/files"');
    expect(html).toContain('href="nexus-nav:/files?tab=inbox"');
    expect(html).toContain('href="nexus-nav:/files?tab=trash" class="on"');
    expect(html).toContain("(3)");
  });

  it("offers upload, import and per-row details only with actions, and says how many rows are hidden", () => {
    const rows = [file(), file({ id: "F2ABC", displayName: "b.txt" })];
    const writable = renderFiles({ files: rows, total: 250, tab: "all", stats }, { actions: true });
    expect(writable).toContain('data-nx-act="file-new"');
    expect(writable).toContain('data-nx-act="file-import"');
    expect(writable).toContain('data-nx-act="file-open" data-nx-id="F1ABC"');
    expect(writable).toContain("250");
    const readOnly = renderFiles({ files: rows, total: 2, tab: "all", stats }, { actions: false });
    expect(readOnly).not.toContain("file-new");
    expect(readOnly).not.toContain("file-import");
    expect(readOnly).toContain('data-nx-act="file-open"');
  });

  it("tags sensitive and pinned files and speaks English on request", () => {
    const html = renderFiles(
      {
        files: [file({ sensitivity: "sensitive", pinnedAt: 1_700_000_000_000 })],
        total: 1,
        tab: "all",
        stats,
      },
      { lang: "en" },
    );
    expect(html).toContain("Files");
    expect(html).toContain("pill bad");
    expect(html).toMatch(/Sensitive/i);
    expect(html).toMatch(/Pinned/i);
  });
});
