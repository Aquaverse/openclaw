import { describe, expect, it, vi } from "vitest";
import { NAV_BASE, type NexusRoute } from "./route.ts";
import { mountSanitized } from "./sanitize.ts";

const hrefOf = (route: NexusRoute) => `/nexus?route=${route.view}`;

function mount(html: string) {
  const container = document.createElement("div");
  document.body.append(container);
  const navigate = vi.fn();
  const dispose = mountSanitized(container, html, hrefOf, navigate);
  return { container, navigate, dispose };
}

describe("mountSanitized", () => {
  it("keeps the tags and class tokens the renderers use", () => {
    const { container } = mount(
      '<h1>事项</h1><table><thead><tr><th>编号</th></tr></thead><tbody><tr><td class="pending"><code>T1</code></td></tr></tbody></table>',
    );
    expect(container.querySelector("h1")?.textContent).toBe("事项");
    expect(container.querySelector("td.pending code")?.textContent).toBe("T1");
  });

  it("turns scripts, images, handlers and foreign links into inert text or nothing", () => {
    const { container } = mount(
      [
        "<script>window.__pwned = 1</script>",
        '<img src=x onerror="window.__pwned = 2">',
        '<p onclick="window.__pwned = 3" style="position:fixed" class="ok bad&quot; onmouseover=&quot;x">text</p>',
        '<a href="javascript:window.__pwned=4">js</a>',
        '<a href="https://evil.example/">out</a>',
        '<iframe src="https://evil.example/"></iframe>',
        '<form action="https://evil.example/"><input name=x></form>',
      ].join(""),
    );
    expect(container.querySelector("script, img, iframe, form, input")).toBeNull();
    expect(container.querySelector("p")?.getAttributeNames()).toEqual(["class"]);
    expect(container.querySelector("p")?.className).toBe("ok");
    for (const anchor of container.querySelectorAll("a")) {
      expect(anchor.hasAttribute("href")).toBe(false);
      expect(anchor.hasAttribute("data-nexus-route")).toBe(false);
    }
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it("renders escaped markup as text, never as elements", () => {
    const { container } = mount("<p>&lt;img src=x onerror=alert(1)&gt;</p>");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("p")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("rewrites placeholder links into host links and navigates on a plain click", () => {
    const { container, navigate } = mount(
      `<a href="${NAV_BASE}/tasks/T1ABC"><code>T1ABC</code></a>`,
    );
    const anchor = container.querySelector("a") as HTMLAnchorElement;
    expect(anchor.getAttribute("href")).toBe("/nexus?route=task");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    anchor.querySelector("code")?.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(navigate).toHaveBeenCalledWith({ view: "task", taskId: "T1ABC" });
  });

  it("leaves modified clicks to the browser and stops listening after dispose", () => {
    const { container, navigate, dispose } = mount(`<a href="${NAV_BASE}/receipts">r</a>`);
    const anchor = container.querySelector("a") as HTMLAnchorElement;
    anchor.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, ctrlKey: true }),
    );
    expect(navigate).not.toHaveBeenCalled();
    dispose();
    anchor.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("action markers", () => {
  it("keeps a known marker as an inert button and reports it on click", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onAction = vi.fn();
    mountSanitized(
      container,
      '<button type="submit" class="nx-btn" data-nx-act="decision" data-nx-id="DEC1" onclick="x()" formaction="https://evil.example/">go</button>',
      hrefOf,
      vi.fn(),
      onAction,
    );
    const button = container.querySelector("button") as HTMLButtonElement;
    expect(button.getAttributeNames().sort()).toEqual([
      "class",
      "data-nx-act",
      "data-nx-id",
      "type",
    ]);
    expect(button.getAttribute("type")).toBe("button");
    button.click();
    expect(onAction).toHaveBeenCalledWith({ kind: "decision", id: "DEC1" });
  });

  it("turns forged or malformed markers into plain text", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onAction = vi.fn();
    mountSanitized(
      container,
      [
        '<button data-nx-act="delete-everything" data-nx-id="X1">a</button>',
        '<button data-nx-act="decision" data-nx-id="../etc">b</button>',
        '<button data-nx-act="watch-cancel">c</button>',
        "<button>d</button>",
      ].join(""),
      hrefOf,
      vi.fn(),
      onAction,
    );
    expect(container.querySelector("button")).toBeNull();
    expect(container.textContent).toBe("abcd");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("needs no id for the new-preference marker, and ignores clicks without a handler", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onAction = vi.fn();
    mountSanitized(
      container,
      '<button data-nx-act="pref-new" data-nx-id="new">n</button>',
      hrefOf,
      vi.fn(),
      onAction,
    );
    (container.querySelector("button") as HTMLButtonElement).click();
    expect(onAction).toHaveBeenCalledWith({ kind: "pref-new" });
    const bare = document.createElement("div");
    document.body.append(bare);
    mountSanitized(
      bare,
      '<button data-nx-act="decision" data-nx-id="D1">x</button>',
      hrefOf,
      vi.fn(),
    );
    expect(() => (bare.querySelector("button") as HTMLButtonElement).click()).not.toThrow();
  });

  it("turns the file markers into actions and drops forged ones", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const onAction = vi.fn();
    mountSanitized(
      container,
      [
        '<button data-nx-act="file-new" data-nx-id="new">u</button>',
        '<button data-nx-act="file-import" data-nx-id="new">i</button>',
        '<button data-nx-act="file-open" data-nx-id="F1ABC">o</button>',
        '<button data-nx-act="file-open" data-nx-id="../x">bad</button>',
        '<button data-nx-act="file-open">bare</button>',
      ].join(""),
      hrefOf,
      vi.fn(),
      onAction,
    );
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      button.click();
    }
    expect(onAction.mock.calls.map((call) => call[0])).toEqual([
      { kind: "file-new" },
      { kind: "file-import" },
      { kind: "file-open", id: "F1ABC" },
    ]);
  });
});
