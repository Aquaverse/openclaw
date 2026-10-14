// The module renders inside the Control UI origin, which holds the operator's gateway credentials, so nothing from the
// Task store may become markup there. The renderers already escape every value; this is the second, independent layer: the
// HTML is parsed inertly (DOMParser never runs scripts) and rebuilt from an allow-list of tags and attributes. Unknown
// tags are replaced by their text, every attribute but `class` (plain tokens only) is dropped, and the only link target
// that survives is a `nexus-nav:` route.
import { routeFromHref, type NexusRoute } from "./route.ts";

const ALLOWED_TAGS = new Set([
  "a",
  "code",
  "div",
  "h1",
  "h2",
  "p",
  "pre",
  "span",
  "table",
  "tbody",
  "td",
  "th",
  "thead",
  "tr",
]);
const CLASS_TOKEN = /^[A-Za-z0-9_-]+$/;

export type NavigateHandler = (route: NexusRoute) => void;

function clean(source: Node, target: Node, doc: Document, hrefOf: (route: NexusRoute) => string) {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === 3) {
      target.appendChild(doc.createTextNode(child.textContent ?? ""));
      continue;
    }
    if (child.nodeType !== 1) {
      continue;
    }
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      // Dropping the element keeps only its text: a stray <script>/<img> becomes inert characters.
      if (tag !== "script" && tag !== "style") {
        target.appendChild(doc.createTextNode(element.textContent ?? ""));
      }
      continue;
    }
    const copy = doc.createElement(tag);
    const classes = (element.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((c) => CLASS_TOKEN.test(c));
    if (classes.length > 0) {
      copy.setAttribute("class", classes.join(" "));
    }
    if (tag === "a") {
      const route = routeFromHref(element.getAttribute("href") ?? "");
      if (route) {
        copy.setAttribute("href", hrefOf(route));
        copy.dataset.nexusRoute = JSON.stringify(route);
      }
    }
    clean(element, copy, doc, hrefOf);
    target.appendChild(copy);
  }
}

/**
 * Replaces `container`'s content with the sanitized `html`. Clicks on route links call `navigate` instead of following
 * the href (which only exists so the link can be opened in a new tab). Returns a disposer for the click handler.
 */
export function mountSanitized(
  container: HTMLElement,
  html: string,
  hrefOf: (route: NexusRoute) => string,
  navigate: NavigateHandler,
): () => void {
  const parsed = new DOMParser().parseFromString(
    `<!doctype html><body>${html}</body>`,
    "text/html",
  );
  const fragment = document.createDocumentFragment();
  clean(parsed.body, fragment, document, hrefOf);
  container.replaceChildren(fragment);
  const onClick = (event: MouseEvent) => {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey
    ) {
      return;
    }
    const anchor = (event.target as Element | null)?.closest?.("a[data-nexus-route]");
    const raw = anchor?.getAttribute("data-nexus-route");
    if (!raw) {
      return;
    }
    event.preventDefault();
    try {
      navigate(JSON.parse(raw) as NexusRoute);
    } catch {
      // A malformed attribute cannot happen from our own sanitizer; ignore rather than navigate somewhere unknown.
    }
  };
  container.addEventListener("click", onClick);
  return () => container.removeEventListener("click", onClick);
}
