import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  htmlToMarkdown,
  sanitizeHtml,
  stripInvisibleUnicode,
  type WebContentExtractorPlugin,
} from "openclaw/plugin-sdk/web-content-extractor";

const READABILITY_MAX_HTML_CHARS = 1_000_000;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3_000;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const READABILITY_MODULE = "@mozilla/readability";
// The public worker bundle avoids per-module DOM loading; sanitized HTML excludes canvas.
const LINKEDOM_MODULE = "linkedom/worker";

const loadReadabilityDeps = createLazyRuntimeModule(() =>
  Promise.all([
    import(READABILITY_MODULE) as Promise<typeof import("@mozilla/readability")>,
    import(LINKEDOM_MODULE) as Promise<typeof import("linkedom/worker")>,
  ]),
);

function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  let depth = 0;
  const len = html.length;
  for (let i = html.indexOf("<"); i >= 0; i = html.indexOf("<", i + 1)) {
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) {
      continue;
    }

    let j = i + 1;
    let closing = false;
    if (html.charCodeAt(j) === 47) {
      closing = true;
      j += 1;
    }

    while (j < len && html.charCodeAt(j) <= 32) {
      j += 1;
    }

    const nameStart = j;
    while (j < len) {
      const c = html.charCodeAt(j);
      const isNameChar =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 58 ||
        c === 45;
      if (!isNameChar) {
        break;
      }
      j += 1;
    }

    if (j === nameStart) {
      continue;
    }

    if (closing) {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    const tagName = html.slice(nameStart, j).toLowerCase();
    if (HTML_VOID_TAGS.has(tagName)) {
      continue;
    }

    let selfClosing = false;
    for (let k = j; k < len && k < j + 200; k++) {
      const c = html.charCodeAt(k);
      if (c === 62) {
        selfClosing = html.charCodeAt(k - 1) === 47;
        break;
      }
    }
    if (selfClosing) {
      continue;
    }

    depth += 1;
    if (depth > maxDepth) {
      return true;
    }
  }
  return false;
}

// linkedom uses the first <base>'s raw href (null for `<base target>`) as baseURI, so
// Readability cannot absolutize links; browsers resolve the first <base href> against the page.
function resolveDocumentBase(document: Document, pageUrl: string): void {
  const base = document.querySelector("base[href]");
  const href = base ? URL.parse(base.getAttribute("href") ?? "", pageUrl)?.href : undefined;
  for (const element of document.querySelectorAll("base")) {
    if (element === base && href) {
      element.setAttribute("href", href);
    } else {
      element.remove();
    }
  }
}

// Readability keeps only the block that looks most like an article body, so an issue or
// pull request page loses its header, including the Open/Closed/Merged label. That label is
// the one fact people fetch such pages for, so it is read from the page before Readability
// rewrites the document and put back in front of the extracted text. The selectors name the
// GitHub issue/PR state label (current and legacy markup); other pages are unaffected.
const PAGE_STATUS_SELECTOR = [
  '[data-testid="header-state"]',
  '[data-component="StateLabel"]',
  ".gh-header-meta .State",
].join(", ");
const PAGE_STATUS_MAX_CHARS = 40;

function readPageStatus(document: Document): string | undefined {
  const text = document
    .querySelector(PAGE_STATUS_SELECTOR)
    ?.textContent?.replace(/\s+/g, " ")
    .trim();
  return text && text.length <= PAGE_STATUS_MAX_CHARS ? stripInvisibleUnicode(text) : undefined;
}

export function createReadabilityWebContentExtractor(): WebContentExtractorPlugin {
  return {
    id: "readability",
    label: "Readability",
    autoDetectOrder: 10,
    extract: async (request) => {
      const cleanHtml = await sanitizeHtml(request.html);
      if (
        cleanHtml.length > READABILITY_MAX_HTML_CHARS ||
        exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)
      ) {
        return null;
      }
      try {
        const [{ Readability }, { parseHTML }] = await loadReadabilityDeps();
        const { document } = parseHTML(cleanHtml, { location: { href: request.url } });
        resolveDocumentBase(document, request.url);
        // Must run before Readability: parse() removes nodes from this document.
        const pageStatus = readPageStatus(document);
        const reader = new Readability(document);
        const parsed = reader.parse();
        if (!parsed) {
          return null;
        }
        const title = parsed.title || undefined;
        // Render the selected HTML because textContent joins adjacent block elements.
        const rendered = htmlToMarkdown(parsed.content ?? "", { extractMode: request.extractMode });
        const body = stripInvisibleUnicode(rendered.text);
        if (!body) {
          return null;
        }
        const text = pageStatus ? `Status: ${pageStatus}\n\n${body}` : body;
        return { text, title: title ?? rendered.title };
      } catch {
        return null;
      }
    },
  };
}
