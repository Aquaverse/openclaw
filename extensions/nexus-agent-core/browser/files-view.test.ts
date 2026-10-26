import type { ControlUiHost, ControlUiViewContext } from "openclaw/plugin-sdk/control-ui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { toBase64 } from "./files-view.ts";
import { createNexusPage } from "./page.ts";

const file = (overrides: Record<string, unknown> = {}) => ({
  id: "F1ABC",
  objectId: "O1",
  displayName: "<b>notes</b>.txt",
  folder: "Taxes",
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
  size: 5,
  mime: "text/plain",
  contentHash: "sha256:abc",
  versionCount: 1,
  pinnedAt: null,
  favorite: false,
  lastOpenedAt: null,
  ...overrides,
});

const STATS = { files: { "vault:active": 1 }, objectBytes: 5, reservedBytes: 0, objects: 1 };

function fixture(
  data: {
    files?: unknown[];
    fail?: Record<string, string>;
    vault?: boolean;
    extraction?: Record<string, unknown>;
    search?: unknown;
    text?: unknown;
    /** The version list and the task links of the (single) file. */
    versions?: unknown[];
    /** Answers nexus.vault.read (the default serves "hello"). */
    read?: (params: Record<string, unknown> | undefined) => unknown;
    links?: { total?: number; links: unknown[] };
    /** Answers nexus.vault.replace (the default reports a new version 2). */
    replace?: unknown;
    /** Answers nexus.vault.list itself (for paging); the default is one page holding `files`. */
    list?: (params: Record<string, unknown> | undefined) => { items: unknown[]; total: number };
  },
  props: Record<string, string>,
  canWrite = true,
  locale?: string,
) {
  const opened: Array<{ id: string; params: Record<string, unknown> }> = [];
  const calls: Array<{ method: string; params: Record<string, unknown> | undefined }> = [];
  const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
    calls.push({ method, params });
    if (data.fail?.[method]) {
      const error = new Error(data.fail[method]) as Error & { details?: unknown };
      if (method === "nexus.vault.importPath") {
        error.details = { reason: "outside_root" };
      }
      throw error;
    }
    if (data.vault === false && method.startsWith("nexus.vault.")) {
      throw new Error(`unknown method ${method}`);
    }
    switch (method) {
      case "nexus.task.list":
        return { tasks: [] };
      case "nexus.decision.list":
        return { decisions: [] };
      case "nexus.vault.stats":
        return STATS;
      case "nexus.vault.list":
        return {
          ...(data.list
            ? data.list(params)
            : { items: data.files ?? [file()], total: (data.files ?? [file()]).length }),
          ...(data.extraction ? { extraction: data.extraction } : {}),
        };
      case "nexus.vault.search":
        return (
          data.search ?? {
            items: [],
            total: 0,
            mode: "fts",
            unindexed: { pending: 0, failed: 0, unsupported: 0 },
          }
        );
      case "nexus.vault.text":
        return data.text ?? { available: false, outcome: "no_text", state: "none" };
      case "nexus.vault.read":
        return data.read
          ? data.read(params)
          : { dataBase64: toBase64(new TextEncoder().encode("hello")), size: 5, eof: true };
      case "nexus.vault.versions":
        return { versions: data.versions ?? [] };
      case "nexus.vault.links":
        return data.links ?? { total: 0, links: [] };
      case "nexus.vault.upload":
        return { file: file(), deduplicated: false };
      case "nexus.vault.importPath":
        return { file: file({ displayName: "invoice.pdf" }) };
      case "nexus.vault.replace":
        return (
          data.replace ?? {
            file: file(),
            deduplicated: false,
            replaced: { seq: 2, unchanged: false },
          }
        );
      case "nexus.vault.restoreVersion":
        return { file: file(), unchanged: false, restoredFrom: 1, seq: 3 };
      case "nexus.vault.purge":
        return { outcome: "purged" };
      default:
        return { outcome: "ok" };
    }
  });
  const host = {
    request,
    connection: { connected: true, canWrite } as ControlUiHost["connection"],
    redact: (text: string) => text,
    subscribe: () => () => {},
    onEvent: () => () => {},
    ...(locale ? { locale } : {}),
    navigation: {
      pageHref: () => "/p",
      openPage: (target: { id: string; params: Record<string, unknown> }) => {
        opened.push(target);
      },
    },
  } as unknown as ControlUiHost;
  const context: ControlUiViewContext = {
    host,
    signal: new AbortController().signal,
    props,
    presented: true,
    mountDefault: () => () => {},
  } as never;
  const container = document.createElement("div");
  document.body.append(container);
  createNexusPage()(container, context);
  return {
    container,
    calls,
    opened,
    dialog: () => container.querySelector(".nx-dialog") as HTMLElement,
    writes: () =>
      calls.filter(
        (call) => !/\.(list|stats|read|get|search|text|versions|links)$/.test(call.method),
      ),
  };
}

const flush = async () => {
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
  }
};
const click = (root: ParentNode, selector: string) => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`no element for ${selector}`);
  }
  el.click();
};
const buttonByText = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => b.textContent === text,
  );
const props = { view: "files" };

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("files tab", () => {
  it("shows the tab only when the gateway serves the vault", async () => {
    const served = fixture({}, { view: "tasks" });
    await flush();
    expect([...served.container.querySelectorAll("nav a")].map((a) => a.textContent)).toContain(
      "文件",
    );
    const without = fixture({ vault: false }, { view: "tasks" });
    await flush();
    expect(
      [...without.container.querySelectorAll("nav a")].map((a) => a.textContent),
    ).not.toContain("文件");
  });

  it("renders the list with the tab parameters and never turns a name into markup", async () => {
    const f = fixture({}, { view: "files", tab: "trash" });
    await flush();
    const list = f.calls.find((call) => call.method === "nexus.vault.list");
    expect(list?.params).toEqual({ limit: 20, offset: 0, pinnedFirst: true, state: "trashed" });
    expect(f.container.querySelector("main b, table b")).toBeNull();
    expect(f.container.textContent).toContain("<b>notes</b>.txt");
  });

  it("offers upload and import only to a writable connection", async () => {
    const ro = fixture({}, props, false);
    await flush();
    expect(ro.container.querySelector('button[data-nx-act="file-new"]')).toBeNull();
    const rw = fixture({}, props, true);
    await flush();
    expect(rw.container.querySelector('button[data-nx-act="file-new"]')).not.toBeNull();
    expect(rw.container.querySelector('button[data-nx-act="file-import"]')).not.toBeNull();
  });

  it("imports from a path and shows the refusal reason", async () => {
    const f = fixture({}, props);
    await flush();
    click(f.container, 'button[data-nx-act="file-import"]');
    const dialog = f.dialog();
    const input = dialog.querySelector("input") as HTMLInputElement;
    const send = buttonByText(dialog, "导入") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    input.value = "~/Downloads/invoice.pdf";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(send.disabled).toBe(false);
    send.click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.vault.importPath", params: { path: "~/Downloads/invoice.pdf" } },
    ]);
    expect(f.container.querySelector(".nx-notice")?.textContent).toContain("已导入 invoice.pdf");

    const refused = fixture({ fail: { "nexus.vault.importPath": "boom" } }, props);
    await flush();
    click(refused.container, 'button[data-nx-act="file-import"]');
    const box = refused.dialog().querySelector("input") as HTMLInputElement;
    box.value = "/etc/passwd";
    box.dispatchEvent(new Event("input", { bubbles: true }));
    (buttonByText(refused.dialog(), "导入") as HTMLButtonElement).click();
    await flush();
    expect(refused.dialog().textContent).toContain("导入被拒绝：outside_root");
  });

  it("previews text, renames and moves in separate calls, and pins", async () => {
    const f = fixture({}, props);
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const dialog = f.dialog();
    expect(dialog.querySelector("pre.nx-original")?.textContent).toBe("hello");
    const [name, folder] = Array.from(dialog.querySelectorAll("input")) as HTMLInputElement[];
    const save = buttonByText(dialog, "保存名称和文件夹") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    (name as HTMLInputElement).value = "renamed.txt";
    (name as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
    (folder as HTMLInputElement).value = "Taxes/2025";
    (folder as HTMLInputElement).dispatchEvent(new Event("input", { bubbles: true }));
    save.click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.vault.rename", params: { fileId: "F1ABC", displayName: "renamed.txt" } },
      { method: "nexus.vault.move", params: { fileId: "F1ABC", folder: "Taxes/2025" } },
    ]);
  });

  it("keeps an inbox file and pins it", async () => {
    const f = fixture({ files: [file({ collection: "inbox" })] }, { view: "files", tab: "inbox" });
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    (buttonByText(f.dialog(), "保留") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([{ method: "nexus.vault.keep", params: { fileId: "F1ABC" } }]);
  });

  it("purges only after the acknowledgement and repeats the file id", async () => {
    const f = fixture({ files: [file({ state: "trashed" })] }, { view: "files", tab: "trash" });
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const dialog = f.dialog();
    const purge = buttonByText(dialog, "永久清除") as HTMLButtonElement;
    expect(purge.disabled).toBe(true);
    const box = dialog.querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    expect(purge.disabled).toBe(false);
    purge.click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.vault.purge", params: { fileId: "F1ABC", confirmFileId: "F1ABC" } },
    ]);
  });

  it("shows details but offers no change on a read-only connection", async () => {
    const f = fixture({}, props, false);
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const dialog = f.dialog();
    expect(dialog.querySelector('input[type="checkbox"]')).toBeNull();
    expect(buttonByText(dialog, "移入回收站")).toBeUndefined();
    expect(dialog.textContent).toContain("sha256:abc");
  });

  it("closes a detail dialog from the close button in its header", async () => {
    const f = fixture({}, props, false);
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const head = f.dialog().querySelector(".nx-head") as HTMLElement;
    expect(head.querySelector(".nx-title")).not.toBeNull();
    const closeButton = head.querySelector("button.nx-x") as HTMLButtonElement;
    expect(closeButton.getAttribute("aria-label")).toBe("关闭");
    closeButton.click();
    expect(f.container.querySelector(".nx-dialog")).toBeNull();
  });

  it("shows the text state in the list and offers content search to a read-only connection too", async () => {
    const ready = {
      state: "ready",
      failureCode: null,
      failureMessage: null,
      attempts: 1,
      pages: 1,
      chars: 5,
      extractor: "text",
      updatedAt: 1,
    };
    const f = fixture({ extraction: { F1ABC: ready } }, props, false);
    await flush();
    expect(f.container.querySelector("table")?.textContent).toContain("可搜索");
    expect(f.container.querySelector('button[data-nx-act="file-search"]')).not.toBeNull();
  });

  it("searches by content, shows files only, and warns about files that could not be searched", async () => {
    const f = fixture(
      {
        search: {
          items: [file({ displayName: "report.md", folder: "Work" })],
          total: 1,
          mode: "fts",
          unindexed: { pending: 1, failed: 0, unsupported: 2 },
          extraction: {},
        },
      },
      props,
      false,
    );
    await flush();
    click(f.container, 'button[data-nx-act="file-search"]');
    const dialog = f.dialog();
    const input = dialog.querySelector("input") as HTMLInputElement;
    input.value = "  harbor contract ";
    (buttonByText(dialog, "搜索") as HTMLButtonElement).click();
    await flush();
    expect(f.calls.find((call) => call.method === "nexus.vault.search")?.params).toEqual({
      query: "harbor contract",
      limit: 50,
    });
    expect(dialog.textContent).toContain("Work/report.md");
    expect(dialog.textContent).toContain("找到 1 个文件");
    expect(dialog.textContent).toContain("另有 3 个文件暂时不能按内容搜索");
    expect(f.writes()).toEqual([]);
  });

  it("shows the extracted text for a ready file, falling back to the raw preview otherwise", async () => {
    const ready = {
      state: "ready",
      failureCode: null,
      failureMessage: null,
      attempts: 1,
      pages: 2,
      chars: 9,
      extractor: "text",
      updatedAt: 1,
    };
    const f = fixture(
      {
        extraction: { F1ABC: ready },
        text: { available: true, page: 0, pageCount: 2, text: "decoded 发票" },
      },
      props,
    );
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const dialog = f.dialog();
    expect(dialog.querySelector("pre.nx-original")?.textContent).toBe("decoded 发票");
    expect(dialog.textContent).toContain("第 1 / 2 页");
    expect(f.calls.some((call) => call.method === "nexus.vault.read")).toBe(false);
  });

  it("explains a failed extraction and queues it again on request", async () => {
    const failed = {
      state: "failed",
      failureCode: "extract_error",
      failureMessage: "disk hiccup",
      attempts: 3,
      pages: 0,
      chars: 0,
      extractor: "text",
      updatedAt: 1,
    };
    const f = fixture({ extraction: { F1ABC: failed } }, props);
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const dialog = f.dialog();
    expect(dialog.textContent).toContain("提取失败");
    expect(dialog.textContent).toContain("extract_error");
    (buttonByText(dialog, "重试提取") as HTMLButtonElement).click();
    await flush();
    expect(f.writes()).toEqual([
      { method: "nexus.vault.retryExtract", params: { fileId: "F1ABC" } },
    ]);
  });

  it("gives the failure reason in English unless the console is in Chinese", async () => {
    const failed = {
      state: "failed",
      failureCode: "too_large",
      failureMessage: "file is larger than the extraction limit",
      attempts: 1,
      pages: 0,
      chars: 0,
      extractor: "text",
      updatedAt: 1,
    };
    for (const [locale, expected] of [
      ["en", "Reason: The file is larger than the extraction size limit"],
      ["zh-CN", "原因：文件超过了提取大小上限"],
    ] as const) {
      const f = fixture({ extraction: { F1ABC: failed } }, props, true, locale);
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      expect(f.dialog().textContent).toContain(expected);
      expect(f.dialog().textContent).toContain("too_large");
    }
  });

  it("asks for the page, page size and name filter in the route and pages the list", async () => {
    const f = fixture(
      { list: () => ({ items: [file()], total: 130 }) },
      { view: "files", qname: "tax", page: "2", size: "50" },
      true,
      "en",
    );
    await flush();
    const list = f.calls.find((call) => call.method === "nexus.vault.list");
    expect(list?.params).toEqual({
      limit: 50,
      offset: 50,
      pinnedFirst: true,
      state: "active",
      nameContains: "tax",
    });
    expect(f.container.textContent).toContain("130 in total, showing 51–100 (page 2 of 3)");
    const next = [...f.container.querySelectorAll<HTMLAnchorElement>(".pager a")].find(
      (a) => a.textContent === "Next ›",
    );
    expect(next).toBeDefined();
    next?.click();
    expect(f.opened.at(-1)?.params).toEqual({ view: "files", qname: "tax", page: "3", size: "50" });
  });

  it("sends the filters from the route to the list and shows them in the controls", async () => {
    const f = fixture(
      {},
      { view: "files", qkind: "image", qfav: "1", qsens: "normal", qname: "x" },
      true,
      "en",
    );
    await flush();
    const list = f.calls.find((call) => call.method === "nexus.vault.list");
    expect(list?.params).toMatchObject({
      nameContains: "x",
      kind: "image",
      favorite: true,
      sensitivity: "normal",
    });
    const value = (field: string) =>
      (f.container.querySelector(`.nx-filebar select[name="${field}"]`) as HTMLSelectElement).value;
    expect([value("qkind"), value("qfav"), value("qsens")]).toEqual(["image", "1", "normal"]);
  });

  it("lands on the last page that still has rows when the requested page is gone", async () => {
    const f = fixture(
      {
        list: (params) =>
          (params?.offset as number) >= 40
            ? { items: [], total: 45 }
            : { items: [file()], total: 45 },
      },
      { view: "files", page: "5" },
    );
    await flush();
    const offsets = f.calls
      .filter((call) => call.method === "nexus.vault.list")
      .map((call) => call.params?.offset);
    expect(offsets).toEqual([80, 40]);
  });

  it("puts the name search between the buttons and the tabs and applies it from the first page", async () => {
    const f = fixture({}, { view: "files", page: "3" }, true, "en");
    await flush();
    const slot = f.container.querySelector(".nx-filebar-slot") as HTMLElement;
    const input = slot.querySelector<HTMLInputElement>('input[name="qname"]');
    expect(input).not.toBeNull();
    // Row order: buttons, search row, tabs.
    const html = f.container.querySelector("main")?.innerHTML ?? "";
    expect(html.indexOf('data-nx-act="file-new"')).toBeLessThan(html.indexOf("nx-filebar-slot"));
    expect(html.indexOf("nx-filebar-slot")).toBeLessThan(html.indexOf("nx-tabs"));
    (input as HTMLInputElement).value = "  invoice ";
    (slot.querySelector("select") as HTMLSelectElement).value = "100";
    slot.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(f.opened.at(-1)?.params).toEqual({ view: "files", qname: "invoice", size: "100" });
    // The kind, favorite and sensitivity filters travel with the name and the page size.
    const choose = (field: string, value: string) => {
      (slot.querySelector(`select[name="${field}"]`) as HTMLSelectElement).value = value;
    };
    choose("qkind", "pdf");
    choose("qfav", "1");
    choose("qsens", "sensitive");
    slot.querySelector("form")?.dispatchEvent(new Event("submit", { cancelable: true }));
    expect(f.opened.at(-1)?.params).toEqual({
      view: "files",
      qname: "invoice",
      qkind: "pdf",
      qfav: "1",
      qsens: "sensitive",
      size: "100",
    });
    expect(
      [...(slot.querySelector('select[name="qkind"]') as HTMLSelectElement).options].map(
        (o) => o.text,
      ),
    ).toEqual(["All types", "Text", "Images", "PDF", "Office documents", "Other"]);
    // Reset clears the filter, keeps the tab.
    (
      Array.from(slot.querySelectorAll("button")).find(
        (b) => b.textContent === "Reset",
      ) as HTMLButtonElement
    ).click();
    expect(f.opened.at(-1)?.params).toEqual({ view: "files" });
  });

  it("marks a file as favorite and takes the mark back, for active files only", async () => {
    const plain = fixture({}, props);
    await flush();
    click(plain.container, 'button[data-nx-act="file-open"]');
    await flush();
    (buttonByText(plain.dialog(), "收藏") as HTMLButtonElement).click();
    await flush();
    expect(plain.writes()).toEqual([
      { method: "nexus.vault.pin", params: { fileId: "F1ABC", favorite: true } },
    ]);
    const marked = fixture({ files: [file({ favorite: true })] }, props);
    await flush();
    click(marked.container, 'button[data-nx-act="file-open"]');
    await flush();
    expect(buttonByText(marked.dialog(), "收藏")).toBeUndefined();
    (buttonByText(marked.dialog(), "取消收藏") as HTMLButtonElement).click();
    await flush();
    expect(marked.writes()).toEqual([
      { method: "nexus.vault.pin", params: { fileId: "F1ABC", favorite: false } },
    ]);
    const trashed = fixture(
      { files: [file({ state: "trashed" })] },
      { view: "files", tab: "trash" },
    );
    await flush();
    click(trashed.container, 'button[data-nx-act="file-open"]');
    await flush();
    expect(buttonByText(trashed.dialog(), "收藏")).toBeUndefined();
  });

  describe("downloads", () => {
    const saved: Array<{ name: string; size: number }> = [];
    let blobs: Blob[] = [];
    beforeEach(() => {
      saved.length = 0;
      blobs = [];
      Object.assign(URL, {
        createObjectURL: (blob: Blob) => {
          blobs.push(blob);
          return "blob:test";
        },
        revokeObjectURL: () => {},
      });
      vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(
        function (this: HTMLAnchorElement) {
          saved.push({ name: this.download, size: blobs.at(-1)?.size ?? -1 });
        },
      );
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("downloads from the list without reloading, under a safe name, even on a read-only connection", async () => {
      const f = fixture({}, props, false);
      await flush();
      const listCalls = () => f.calls.filter((call) => call.method === "nexus.vault.list").length;
      const before = listCalls();
      click(f.container, 'button[data-nx-act="file-download"]');
      await flush();
      await flush();
      expect(saved).toEqual([{ name: "_b_notes__b_.txt", size: 5 }]);
      expect(f.container.querySelector(".nx-notice")?.textContent).toContain("已下载");
      expect(f.container.querySelector(".nx-notice")?.textContent).toContain("_b_notes__b_.txt");
      expect(f.calls.find((call) => call.method === "nexus.vault.read")?.params).toEqual({
        fileId: "F1ABC",
        offset: 0,
        length: 1024 * 1024,
      });
      expect(listCalls()).toBe(before);
    });

    it("downloads from the details and keeps the dialog open", async () => {
      const f = fixture({}, props);
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      const button = Array.from(f.dialog().querySelectorAll<HTMLButtonElement>("button")).find(
        (b) => b.textContent === "下载",
      ) as HTMLButtonElement;
      button.click();
      await flush();
      await flush();
      expect(saved).toHaveLength(1);
      expect(f.dialog().textContent).toContain("已下载");
      expect(button.disabled).toBe(false);
    });

    it("saves nothing when the bytes do not match the recorded hash", async () => {
      const f = fixture(
        {
          read: () => ({
            dataBase64: toBase64(new TextEncoder().encode("hello")),
            size: 5,
            eof: true,
            contentHash: "0".repeat(64),
          }),
        },
        props,
      );
      await flush();
      click(f.container, 'button[data-nx-act="file-download"]');
      await flush();
      await flush();
      expect(saved).toEqual([]);
      const notice = f.container.querySelector(".nx-notice") as HTMLElement;
      expect(notice.className).toContain("error");
      expect(notice.textContent).toContain("哈希不一致");
    });

    it("offers no download for a damaged file", async () => {
      const f = fixture({ files: [file({ state: "damaged" })] }, { view: "files", tab: "damaged" });
      await flush();
      expect(f.container.querySelector('button[data-nx-act="file-download"]')).toBeNull();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      expect(
        Array.from(f.dialog().querySelectorAll("button")).some((b) => b.textContent === "下载"),
      ).toBe(false);
    });

    it("lists the versions, shows the latest by default and opens the history on request", async () => {
      const versions = [
        {
          seq: 2,
          objectId: "O2",
          size: 7,
          mime: "text/plain",
          contentHash: "b".repeat(64),
          createdAt: 1_700_000_200_000,
          current: true,
        },
        {
          seq: 1,
          objectId: "O1",
          size: 5,
          mime: "text/plain",
          contentHash: "a".repeat(64),
          createdAt: 1_700_000_000_000,
          current: false,
        },
      ];
      const f = fixture({ files: [file({ versionCount: 2 })], versions }, props);
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      const detail = f.dialog();
      expect(detail.textContent).toContain("版本 2");
      expect(detail.textContent).not.toContain("版本 1");
      (buttonByText(detail, "更多版本（2）") as HTMLButtonElement).click();
      await flush();
      expect(f.container.querySelectorAll(".nx-dialog")).toHaveLength(1);
      const history = f.dialog();
      expect(history.querySelector(".nx-title")?.textContent).toBe("文件 F1ABC 的版本");
      expect(history.textContent).toContain("版本 2 (当前)");
      expect(history.textContent).toContain("版本 1");
      expect(history.textContent).not.toContain("a".repeat(64));
      Array.from(history.querySelectorAll<HTMLButtonElement>("button"))
        .filter((b) => b.textContent === "详情")[1]!
        .click();
      expect(history.textContent).toContain("a".repeat(64));
      // The older version downloads by its number and keeps it in the name.
      Array.from(history.querySelectorAll<HTMLButtonElement>("button"))
        .filter((b) => b.textContent === "下载")[1]!
        .click();
      await flush();
      await flush();
      const reads = f.calls.filter((call) => call.method === "nexus.vault.read");
      expect(reads.at(-1)?.params).toEqual({
        fileId: "F1ABC",
        offset: 0,
        length: 1024 * 1024,
        version: 1,
      });
      expect(saved.at(-1)?.name).toBe("_b_notes__b_-v1.txt");
      // Back to the file.
      (buttonByText(history, "返回文件详情") as HTMLButtonElement).click();
      await flush();
      vi.advanceTimersByTime(5);
      await flush();
      expect(f.dialog().querySelector(".nx-title")?.textContent).toBe("文件 F1ABC");
    });

    it("has no more-versions button for a file with a single version, or on an older gateway", async () => {
      const one = [
        {
          seq: 1,
          objectId: "O1",
          size: 5,
          mime: "text/plain",
          contentHash: "a".repeat(64),
          createdAt: 1_700_000_000_000,
          current: true,
        },
      ];
      const single = fixture({ versions: one }, props);
      await flush();
      click(single.container, 'button[data-nx-act="file-open"]');
      await flush();
      expect(single.dialog().textContent).toContain("版本 1");
      expect(
        Array.from(single.dialog().querySelectorAll("button")).some((b) =>
          (b.textContent ?? "").startsWith("更多版本"),
        ),
      ).toBe(false);
      const old = fixture({ fail: { "nexus.vault.versions": "unknown method" } }, props);
      await flush();
      click(old.container, 'button[data-nx-act="file-open"]');
      await flush();
      expect(old.dialog().textContent).toContain("版本数");
    });
  });

  it("shows the tasks that use the file as evidence, as text", async () => {
    const link = {
      evidenceId: "EV1",
      taskId: "T1",
      taskTitle: "<i>Refund</i> the order",
      taskStatus: "executing",
      claimIds: ["CL1", "CL2"],
      capturedAt: 1_700_000_000_000,
      bytesKept: true,
    };
    const f = fixture(
      {
        links: {
          total: 3,
          links: [
            link,
            { ...link, evidenceId: "EV2", taskId: "T2", claimIds: [], bytesKept: false },
          ],
        },
      },
      props,
    );
    await flush();
    click(f.container, 'button[data-nx-act="file-open"]');
    await flush();
    const dialog = f.dialog();
    expect(dialog.querySelector("i")).toBeNull();
    expect(dialog.textContent).toContain("<i>Refund</i> the order");
    expect(dialog.textContent).toContain("任务 T1");
    expect(dialog.textContent).toContain("证据 EV1");
    expect(dialog.textContent).toContain("支持的论断：CL1, CL2");
    expect(dialog.textContent).toContain("证据的原件已清理");
    expect(dialog.textContent).toContain("还有 1 条关联没有显示");
  });

  it("says so when no task uses the file, and hides the section on an older gateway", async () => {
    const none = fixture({}, props);
    await flush();
    click(none.container, 'button[data-nx-act="file-open"]');
    await flush();
    expect(none.dialog().textContent).toContain("还没有任务把这个文件作为证据使用。");
    const old = fixture({ fail: { "nexus.vault.links": "unknown method" } }, props);
    await flush();
    click(old.container, 'button[data-nx-act="file-open"]');
    await flush();
    expect(old.dialog().textContent).not.toContain("还没有任务把这个文件作为证据使用。");
  });

  describe("replace content and restore a version", () => {
    const twoVersions = [
      {
        seq: 2,
        objectId: "O2",
        size: 7,
        mime: "text/plain",
        contentHash: "b".repeat(64),
        createdAt: 1_700_000_200_000,
        current: true,
      },
      {
        seq: 1,
        objectId: "O1",
        size: 5,
        mime: "text/plain",
        contentHash: "a".repeat(64),
        createdAt: 1_700_000_000_000,
        current: false,
      },
    ];
    const choose = (dialog: HTMLElement, name: string, text: string) => {
      const picker = dialog.querySelector<HTMLInputElement>('input[type="file"]')!;
      const bytes = new TextEncoder().encode(text);
      Object.defineProperty(picker, "files", {
        configurable: true,
        value: [{ name, size: bytes.length, arrayBuffer: async () => bytes.buffer }],
      });
      picker.dispatchEvent(new Event("change"));
    };

    it("replaces the content from the detail dialog and says which version it is now", async () => {
      const f = fixture({}, props);
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      (buttonByText(f.dialog(), "替换内容") as HTMLButtonElement).click();
      await flush();
      vi.advanceTimersByTime(5);
      await flush();
      expect(f.container.querySelectorAll(".nx-dialog")).toHaveLength(1);
      const dialog = f.dialog();
      expect(dialog.querySelector(".nx-title")?.textContent).toBe("替换文件 F1ABC 的内容");
      expect(dialog.textContent).toContain("最多保留 5 个");
      const send = buttonByText(dialog, "替换") as HTMLButtonElement;
      expect(send.disabled).toBe(true);
      choose(dialog, "new.txt", "brand new");
      expect(send.disabled).toBe(false);
      send.click();
      await flush();
      await flush();
      const replace = f.calls.find((call) => call.method === "nexus.vault.replace");
      expect(replace?.params).toEqual({
        fileId: "F1ABC",
        dataBase64: toBase64(new TextEncoder().encode("brand new")),
      });
      expect(f.container.querySelector(".nx-notice")?.textContent).toContain("现在是版本 2");
      expect(f.container.querySelector(".nx-dialog")).toBeNull();
    });

    it("says so when the new content equals the current one", async () => {
      const f = fixture(
        { replace: { file: file(), deduplicated: true, replaced: { seq: 1, unchanged: true } } },
        props,
      );
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      (buttonByText(f.dialog(), "替换内容") as HTMLButtonElement).click();
      await flush();
      vi.advanceTimersByTime(5);
      await flush();
      choose(f.dialog(), "same.txt", "hello");
      (buttonByText(f.dialog(), "替换") as HTMLButtonElement).click();
      await flush();
      await flush();
      expect(f.container.querySelector(".nx-notice")?.textContent).toContain("没有产生新版本");
    });

    it("offers no replace on a trashed file or a read-only connection", async () => {
      const trashed = fixture(
        { files: [file({ state: "trashed" })] },
        { view: "files", tab: "trash" },
      );
      await flush();
      click(trashed.container, 'button[data-nx-act="file-open"]');
      await flush();
      expect(buttonByText(trashed.dialog(), "替换内容")).toBeUndefined();
      const readonly = fixture({}, props, false);
      await flush();
      click(readonly.container, 'button[data-nx-act="file-open"]');
      await flush();
      expect(buttonByText(readonly.dialog(), "替换内容")).toBeUndefined();
    });

    it("keeps the dialog open and shows the refusal when the gateway says no", async () => {
      const f = fixture(
        { fail: { "nexus.vault.replace": "the vault quota would be exceeded" } },
        props,
      );
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      (buttonByText(f.dialog(), "替换内容") as HTMLButtonElement).click();
      await flush();
      vi.advanceTimersByTime(5);
      await flush();
      choose(f.dialog(), "new.txt", "x");
      (buttonByText(f.dialog(), "替换") as HTMLButtonElement).click();
      await flush();
      await flush();
      expect(f.dialog().textContent).toContain("the vault quota would be exceeded");
    });

    it("restores an older version, but never offers it for the current one", async () => {
      const f = fixture({ files: [file({ versionCount: 2 })], versions: twoVersions }, props);
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      (buttonByText(f.dialog(), "更多版本（2）") as HTMLButtonElement).click();
      await flush();
      const history = f.dialog();
      expect(history.textContent).toContain("最多保留 5 个版本");
      const restores = Array.from(history.querySelectorAll<HTMLButtonElement>("button")).filter(
        (b) => b.textContent === "恢复为此版本",
      );
      expect(restores).toHaveLength(1);
      restores[0]!.click();
      await flush();
      await flush();
      const call = f.calls.find((c) => c.method === "nexus.vault.restoreVersion");
      expect(call?.params).toEqual({ fileId: "F1ABC", version: 1 });
      expect(f.container.querySelector(".nx-notice")?.textContent).toContain("版本 1");
      expect(f.container.querySelector(".nx-notice")?.textContent).toContain("版本 3");
      expect(f.container.querySelector(".nx-dialog")).toBeNull();
    });

    it("shows a failed restore inside the history and keeps it open", async () => {
      const f = fixture(
        {
          files: [file({ versionCount: 2 })],
          versions: twoVersions,
          fail: { "nexus.vault.restoreVersion": "that version no longer exists" },
        },
        props,
      );
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      (buttonByText(f.dialog(), "更多版本（2）") as HTMLButtonElement).click();
      await flush();
      (buttonByText(f.dialog(), "恢复为此版本") as HTMLButtonElement).click();
      await flush();
      await flush();
      expect(f.dialog().textContent).toContain("恢复失败：that version no longer exists");
      expect((buttonByText(f.dialog(), "恢复为此版本") as HTMLButtonElement).disabled).toBe(false);
    });

    it("hides restore for a read-only connection", async () => {
      const f = fixture(
        { files: [file({ versionCount: 2 })], versions: twoVersions },
        props,
        false,
      );
      await flush();
      click(f.container, 'button[data-nx-act="file-open"]');
      await flush();
      (buttonByText(f.dialog(), "更多版本（2）") as HTMLButtonElement).click();
      await flush();
      expect(buttonByText(f.dialog(), "恢复为此版本")).toBeUndefined();
      expect(f.dialog().textContent).not.toContain("最多保留");
    });
  });

  it("builds the upload dialog and refuses to send before a file is chosen", async () => {
    const f = fixture({}, props);
    await flush();
    click(f.container, 'button[data-nx-act="file-new"]');
    const send = buttonByText(f.dialog(), "上传") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(f.dialog().querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe("toBase64", () => {
  it("encodes chunks larger than the spread limit", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 3).fill(65);
    expect(atob(toBase64(bytes))).toBe("A".repeat(bytes.length));
  });
});
