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
  },
  props: Record<string, string>,
  canWrite = true,
) {
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
          items: data.files ?? [file()],
          total: (data.files ?? [file()]).length,
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
        return { dataBase64: toBase64(new TextEncoder().encode("hello")), size: 5, eof: true };
      case "nexus.vault.upload":
        return { file: file(), deduplicated: false };
      case "nexus.vault.importPath":
        return { file: file({ displayName: "invoice.pdf" }) };
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
    navigation: { pageHref: () => "/p", openPage: () => {} },
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
    dialog: () => container.querySelector(".nx-dialog") as HTMLElement,
    writes: () => calls.filter((call) => !/\.(list|stats|read|get|search|text)$/.test(call.method)),
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
    expect(list?.params).toEqual({ limit: 200, pinnedFirst: true, state: "trashed" });
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
