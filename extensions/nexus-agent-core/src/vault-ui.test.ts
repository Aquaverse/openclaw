import { describe, expect, it } from "vitest";
import type { VaultFileRecord } from "./store/vault-types.js";
import { extractionReason, renderFiles } from "./ui-render.js";
import {
  DEFAULT_FILE_QUERY,
  DEFAULT_FILE_TAB,
  downloadFileName,
  FILE_TABS,
  fileActionsFor,
  fileDownloadable,
  fileFilterActive,
  fileLink,
  fileListParams,
  fileQueryToParams,
  formatBytes,
  maybeText,
  parseFileQuery,
  parseFileTab,
  tabCounts,
  type FileQuery,
  type FileTab,
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
    const query = (tab: FileTab) => ({ ...DEFAULT_FILE_QUERY, tab });
    expect(fileListParams(query("all"))).toEqual({
      state: "active",
      pinnedFirst: true,
      limit: 20,
      offset: 0,
    });
    expect(fileListParams(query("inbox"))).toMatchObject({ collection: "inbox", state: "active" });
    expect(fileListParams(query("deliverable"))).toMatchObject({
      collection: "deliverable",
      state: "active",
    });
    expect(fileListParams(query("trash"))).toMatchObject({ state: "trashed" });
    expect(fileListParams(query("damaged"))).toMatchObject({ state: "damaged" });
  });

  it("turns the page, page size and name filter into limit, offset and nameContains", () => {
    expect(
      fileListParams({ ...DEFAULT_FILE_QUERY, tab: "vault", name: "报告", page: 3, size: 50 }),
    ).toEqual({
      collection: "vault",
      state: "active",
      pinnedFirst: true,
      limit: 50,
      offset: 100,
      nameContains: "报告",
    });
  });

  it("sends the kind, favorite and sensitivity filters only when they are set", () => {
    expect(
      fileListParams({
        ...DEFAULT_FILE_QUERY,
        kind: "pdf",
        favorite: true,
        sensitivity: "sensitive",
      }),
    ).toEqual({
      state: "active",
      pinnedFirst: true,
      limit: 20,
      offset: 0,
      kind: "pdf",
      favorite: true,
      sensitivity: "sensitive",
    });
    expect(fileListParams(DEFAULT_FILE_QUERY)).not.toHaveProperty("kind");
    expect(fileListParams(DEFAULT_FILE_QUERY)).not.toHaveProperty("favorite");
    expect(fileListParams(DEFAULT_FILE_QUERY)).not.toHaveProperty("sensitivity");
  });

  it("round-trips the filters through the page parameters and says when any narrows the list", () => {
    const query = {
      ...DEFAULT_FILE_QUERY,
      kind: "office" as const,
      favorite: true,
      sensitivity: "normal" as const,
    };
    expect(fileQueryToParams(query)).toEqual({ qkind: "office", qfav: "1", qsens: "normal" });
    expect(parseFileQuery((name) => fileQueryToParams(query)[name])).toEqual(query);
    expect(fileLink("nexus-nav:", query, { tab: "trash" })).toBe(
      "nexus-nav:/files?tab=trash&qkind=office&qfav=1&qsens=normal",
    );
    expect(fileFilterActive(DEFAULT_FILE_QUERY)).toBe(false);
    const paged: FileQuery = { ...DEFAULT_FILE_QUERY, size: 100, page: 4, tab: "trash" };
    expect(fileFilterActive(paged)).toBe(false);
    for (const change of [
      { name: "a" },
      { kind: "pdf" },
      { favorite: true },
      { sensitivity: "normal" },
    ] as const) {
      expect(fileFilterActive({ ...DEFAULT_FILE_QUERY, ...change })).toBe(true);
    }
  });

  it("reads a query from untrusted text, keeps only non-default parts and links pages", () => {
    const read = (values: Record<string, string>) => parseFileQuery((name) => values[name]);
    expect(read({})).toEqual(DEFAULT_FILE_QUERY);
    expect(read({ tab: "x", qname: " a\u0000b ", page: "-2", size: "7" })).toEqual({
      ...DEFAULT_FILE_QUERY,
      name: "a b",
    });
    expect(read({ qname: "x".repeat(500) }).name).toHaveLength(200);
    expect(fileQueryToParams(DEFAULT_FILE_QUERY)).toEqual({});
    expect(
      fileQueryToParams({ ...DEFAULT_FILE_QUERY, tab: "trash", name: "n", page: 2, size: 100 }),
    ).toEqual({
      tab: "trash",
      qname: "n",
      page: "2",
      size: "100",
    });
    const query = { ...DEFAULT_FILE_QUERY, name: "a&b", page: 4 };
    expect(fileLink("nexus-nav:", query, { page: 5 })).toBe("nexus-nav:/files?qname=a%26b&page=5");
    expect(fileLink("nexus-nav:", query, { tab: "trash", page: 1 })).toBe(
      "nexus-nav:/files?tab=trash&qname=a%26b",
    );
    expect(fileLink("nexus-nav:", DEFAULT_FILE_QUERY)).toBe("nexus-nav:/files");
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
      "favorite",
      "sensitivity",
      "purge",
    ]);
    expect(fileActionsFor({ state: "active", collection: "vault" })).toContain("favorite");
    expect(fileActionsFor({ state: "trashed", collection: "vault" })).not.toContain("favorite");
    expect(fileActionsFor({ state: "active", collection: "vault" })).toContain("trash");
    expect(fileActionsFor({ state: "active", collection: "vault" })).not.toContain("keep");
    expect(fileActionsFor({ state: "trashed", collection: "vault" })).toEqual(["restore", "purge"]);
    expect(fileActionsFor({ state: "damaged", collection: "vault" })).toEqual(["purge"]);
    expect(fileActionsFor({ state: "purging", collection: "vault" })).toEqual([]);
  });

  it("downloads active and trashed files only", () => {
    expect(fileDownloadable({ state: "active" })).toBe(true);
    expect(fileDownloadable({ state: "trashed" })).toBe(true);
    expect(fileDownloadable({ state: "damaged" })).toBe(false);
    expect(fileDownloadable({ state: "purging" })).toBe(false);
  });

  it("makes a download name that is safe on any file system", () => {
    expect(downloadFileName("tax.pdf")).toBe("tax.pdf");
    expect(downloadFileName("../../etc/passwd")).toBe("_.._etc_passwd");
    expect(downloadFileName("a:b*c?.txt")).toBe("a_b_c_.txt");
    expect(downloadFileName("<b>notes</b>.txt")).toBe("_b_notes__b_.txt");
    expect(downloadFileName("..hidden")).toBe("hidden");
    expect(downloadFileName("trailing. . ")).toBe("trailing");
    expect(downloadFileName("tab\tname\u0000.txt")).toBe("tab_name_.txt");
    expect(downloadFileName("   ")).toBe("file");
    expect(downloadFileName("...")).toBe("file");
    expect(downloadFileName("report.pdf", 2)).toBe("report-v2.pdf");
    expect(downloadFileName("README", 1)).toBe("README-v1");
    const long = downloadFileName(`${"x".repeat(300)}.pdf`);
    expect(long.length).toBe(200);
    expect(long.endsWith(".pdf")).toBe(true);
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
    expect(writable).toContain('data-nx-act="file-download" data-nx-id="F1ABC"');
    expect(writable).toContain("250");
    const readOnly = renderFiles({ files: rows, total: 2, tab: "all", stats }, { actions: false });
    expect(readOnly).not.toContain("file-new");
    expect(readOnly).not.toContain("file-import");
    expect(readOnly).toContain('data-nx-act="file-open"');
    // Reading is allowed on a read-only connection, so is taking a copy.
    expect(readOnly).toContain('data-nx-act="file-download"');
  });

  it("offers a download only for files whose bytes can be read", () => {
    const html = renderFiles(
      {
        files: [
          file({ id: "FACTIVE", state: "active" }),
          file({ id: "FTRASH", state: "trashed" }),
          file({ id: "FDAMAGED", state: "damaged" }),
        ],
        total: 3,
        tab: "all",
        stats,
      },
      { actions: true },
    );
    expect(html).toContain('data-nx-act="file-download" data-nx-id="FACTIVE"');
    expect(html).toContain('data-nx-act="file-download" data-nx-id="FTRASH"');
    expect(html).not.toContain('data-nx-act="file-download" data-nx-id="FDAMAGED"');
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

  it("puts upload and import on their own row, apart from the search row", () => {
    const html = renderFiles({ files: [file()], total: 1, tab: "all", stats }, { actions: true });
    const rows = html.split('<div class="nx-filerow">').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('data-nx-act="file-new"');
    expect(rows[0]).toContain('data-nx-act="file-import"');
    expect(rows[0]).not.toContain("file-search");
    expect(rows[1]).toContain('class="nx-filebar-slot"');
    expect(rows[1]).toContain('data-nx-act="file-search"');
    expect(rows[1]).not.toContain("file-new");
    // Read-only: no action row, the search row stays.
    const readOnly = renderFiles({ files: [file()], total: 1, tab: "all", stats });
    expect(readOnly.split('<div class="nx-filerow">')).toHaveLength(2);
    expect(readOnly).toContain("nx-filebar-slot");
  });

  it("pages the list with links that keep the tab, the name filter and the page size", () => {
    const html = renderFiles(
      { files: [file()], total: 250, tab: "vault", name: "a&b", page: 3, size: 50, stats },
      { lang: "en" },
    );
    expect(html).toContain("250 in total, showing 101–150 (page 3 of 5)");
    expect(html).toContain('href="nexus-nav:/files?tab=vault&amp;qname=a%26b&amp;size=50"');
    expect(html).toContain("page=4&amp;size=50");
    expect(html).toContain("Previous");
    expect(html).toContain("Next");
    // Tabs start over at the first page but keep the filter.
    expect(html).toContain('href="nexus-nav:/files?tab=trash&amp;qname=a%26b&amp;size=50"');
    // The pager sits above and below the table.
    expect(html.match(/class="pager"/g)).toHaveLength(2);
  });

  it("shows no pager controls on a single page and says so when a name matches nothing", () => {
    const single = renderFiles({ files: [file()], total: 1, tab: "all", stats });
    expect(single).not.toContain("下一页");
    const none = renderFiles(
      { files: [], total: 0, tab: "all", name: "zzz", stats },
      { lang: "en" },
    );
    expect(none).toContain("No files match.");
    // A kind, favorite or sensitivity filter that matches nothing says so as well.
    const filtered = renderFiles(
      { files: [], total: 0, tab: "all", favorite: true, stats },
      { lang: "en" },
    );
    expect(filtered).toContain("No files match.");
    expect(filtered).not.toContain("<table");
    expect(none).not.toContain("<table");
  });
});

describe("extractionReason", () => {
  const status = (failureCode: string | null, failureMessage: string | null = null) => ({
    failureCode,
    failureMessage,
  });
  it("is English by default and Chinese only when asked", () => {
    expect(extractionReason("en", status("too_large", "file too big"))).toMatch(/larger than/);
    expect(extractionReason("zh", status("too_large", "file too big"))).toContain("超过");
    expect(extractionReason("en", status("binary_content"))).toMatch(/binary/);
  });
  it("falls back to the server message for a code it does not know", () => {
    expect(extractionReason("zh", status("brand_new", "something odd"))).toBe("something odd");
    expect(extractionReason("en", status("brand_new"))).toBe("-");
    expect(extractionReason("en", status("toString"))).toBe("-");
  });
});
