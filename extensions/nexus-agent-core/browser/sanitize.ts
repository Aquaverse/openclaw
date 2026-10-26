// The module renders inside the Control UI origin, which holds the operator's gateway credentials, so nothing from the
// Task store may become markup there. The renderers already escape every value; this is the second, independent layer: the
// HTML is parsed inertly (DOMParser never runs scripts) and rebuilt from an allow-list of tags and attributes. Unknown
// tags are replaced by their text, every attribute but `class` (plain tokens only) is dropped, and the only link target
// that survives is a `nexus-nav:` route. A <button> survives only as an action marker: a known action name plus an id,
// which the page maps to a confirmation dialog built from its own loaded records, never from the markup.
import { routeFromHref, type NexusRoute } from "./route.ts";

export type NexusAction =
  | { kind: "decision"; id: string }
  | { kind: "watch-cancel"; id: string }
  | { kind: "pref-new" }
  | { kind: "pref-edit"; id: string }
  | { kind: "pref-delete"; id: string }
  | { kind: "evidence-view"; id: string }
  | { kind: "file-new" }
  | { kind: "file-import" }
  | { kind: "file-search" }
  | { kind: "file-open"; id: string };

const ACTION_ID = /^[A-Za-z0-9_-]{1,40}$/;

/** Maps a marker's (name, id) pair to an action, or undefined when it is not one we render. */
export function actionFromMarker(act: string | null, id: string | null): NexusAction | undefined {
  if (act === "pref-new") {
    return { kind: "pref-new" };
  }
  if (act === "file-new") {
    return { kind: "file-new" };
  }
  if (act === "file-search") {
    return { kind: "file-search" };
  }
  if (act === "file-import") {
    return { kind: "file-import" };
  }
  if (!id || !ACTION_ID.test(id)) {
    return undefined;
  }
  if (
    act === "decision" ||
    act === "watch-cancel" ||
    act === "pref-edit" ||
    act === "pref-delete" ||
    act === "evidence-view" ||
    act === "file-open"
  ) {
    return { kind: act, id };
  }
  return undefined;
}

const ALLOWED_TAGS = new Set([
  "a",
  "button",
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
export type ActionHandler = (action: NexusAction) => void;

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
    if (tag === "button") {
      const action = actionFromMarker(
        element.getAttribute("data-nx-act"),
        element.getAttribute("data-nx-id"),
      );
      if (!action) {
        // Not a marker we rendered: keep the label as text, nothing clickable.
        target.appendChild(doc.createTextNode(element.textContent ?? ""));
        continue;
      }
      copy.setAttribute("type", "button");
      copy.setAttribute("data-nx-act", action.kind);
      if ("id" in action) {
        copy.setAttribute("data-nx-id", action.id);
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
  onAction?: ActionHandler,
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
    const target = event.target as Element | null;
    const marker = target?.closest?.("button[data-nx-act]");
    if (marker) {
      const action = actionFromMarker(
        marker.getAttribute("data-nx-act"),
        marker.getAttribute("data-nx-id"),
      );
      if (action && onAction) {
        event.preventDefault();
        onAction(action);
      }
      return;
    }
    const anchor = target?.closest?.("a[data-nexus-route]");
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
