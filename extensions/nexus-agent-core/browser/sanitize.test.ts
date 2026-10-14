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
