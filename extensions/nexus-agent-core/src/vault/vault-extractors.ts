// Text extractors of the personal file vault (Vault design 9.2). F2 ships ONE built-in extractor for text-class files
// (plain text, Markdown, CSV, JSON, XML, HTML, source code). It has no dependencies and works offline. The interface is
// deliberately small so a PDF / image / Office extractor can be added later without touching the queue or the index:
// an extractor gets the bytes and returns text, or throws `ExtractError` with a code and whether retrying can help.
// Extractors only ever see bytes of objects the ledger declared eligible; they never touch a file, a network or a process.

export class ExtractError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** false: this object can never be extracted by this extractor (the job becomes `rejected`, no retries). */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ExtractError";
  }
}

export type VaultExtractInput = { bytes: Uint8Array; mime: string; name: string };
export type VaultExtractOutput = { text: string };

export type VaultTextExtractor = {
  id: string;
  /** Bump when the output for the same bytes changes: the sweep then queues the object again. */
  version: string;
  accepts(file: { mime: string; name: string }): boolean;
  extract(input: VaultExtractInput): VaultExtractOutput;
};

const extensionOf = (name: string): string => {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
};

// ---------------------------------------------------------------- decoding

const NUL_SCAN_BYTES = 8192;

function hasNul(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, NUL_SCAN_BYTES);
  for (let index = 0; index < end; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
}

function tryDecode(label: string, bytes: Uint8Array, fatal: boolean): string | undefined {
  try {
    return new TextDecoder(label, { fatal }).decode(bytes);
  } catch {
    return undefined;
  }
}

/** UTF-8 (with or without BOM), UTF-16 with BOM, then GB18030 for legacy Chinese text. Anything else is refused as binary. */
export function decodeTextBytes(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(bytes.subarray(2));
  }
  if (hasNul(bytes)) {
    throw new ExtractError("binary_content", "the file contains binary data", false);
  }
  const utf8 = tryDecode("utf-8", bytes, true);
  if (utf8 !== undefined) {
    return utf8;
  }
  const legacy = tryDecode("gb18030", bytes, true);
  if (legacy !== undefined) {
    return legacy;
  }
  throw new ExtractError("undecodable", "the text encoding is not recognised", false);
}

/** Line endings to `\n`, control characters (other than tab / newline) dropped, no NUL ever reaches the index. */
export function cleanText(text: string): string {
  let out = "";
  for (const ch of text.replaceAll("\r\n", "\n").replaceAll("\r", "\n")) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 && code !== 9 && code !== 10) {
      continue;
    }
    if (code === 0x7f || code === 0xfeff) {
      continue;
    }
    out += ch;
  }
  return out;
}

// ---------------------------------------------------------------- html

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith("#")) {
      const code =
        body[1]?.toLowerCase() === "x"
          ? Number.parseInt(body.slice(2), 16)
          : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Visible text of an HTML document: scripts, styles and comments are dropped, block tags become line breaks. */
export function htmlToText(html: string): string {
  const withoutBlocks = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, " ");
  const withBreaks = withoutBlocks.replace(
    /<\/?(p|div|br|li|ul|ol|tr|table|h[1-6]|section|article|header|footer|pre|blockquote)\b[^>]*>/gi,
    "\n",
  );
  return decodeEntities(withBreaks.replace(/<[^>]*>/g, " "))
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line, index, lines) => line !== "" || (index > 0 && lines[index - 1] !== ""))
    .join("\n")
    .trim();
}

// ---------------------------------------------------------------- the built-in text extractor

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "tsv",
  "json",
  "jsonl",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "log",
  "rst",
  "tex",
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cc",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "sql",
  "css",
  "scss",
  "vue",
  "svelte",
  "lua",
  "r",
]);

export const TEXT_EXTRACTOR: VaultTextExtractor = {
  id: "text",
  version: "1",
  accepts({ mime, name }) {
    if (mime.startsWith("text/") || mime === "application/json" || mime === "application/xml") {
      return true;
    }
    // The sniffer only calls a file text when its first 4 KB are valid UTF-8, so a GBK / GB18030 file arrives as
    // `application/octet-stream`. The name only lets such a file through to the decoder, which still refuses binary data.
    return mime === "application/octet-stream" && TEXT_EXTENSIONS.has(extensionOf(name));
  },
  extract({ bytes, mime, name }) {
    const decoded = cleanText(decodeTextBytes(bytes));
    const ext = extensionOf(name);
    const text =
      mime === "text/html" || ext === "html" || ext === "htm" ? htmlToText(decoded) : decoded;
    return { text: text.trim() };
  },
};

export const BUILTIN_EXTRACTORS: readonly VaultTextExtractor[] = [TEXT_EXTRACTOR];

export function selectExtractor(
  file: { mime: string; name: string },
  extractors: readonly VaultTextExtractor[] = BUILTIN_EXTRACTORS,
): VaultTextExtractor | undefined {
  return extractors.find((extractor) => extractor.accepts(file));
}

// ---------------------------------------------------------------- paging

/**
 * Split into pages of about `pageChars`, preferring a line break near the end of the page. `maxChars` caps the total; when it
 * bites, the rest is dropped and `truncated` says so. Pages never split a surrogate pair.
 */
export function paginateText(
  text: string,
  pageChars: number,
  maxChars: number,
): { pages: string[]; truncated: boolean } {
  const capped = text.length > maxChars;
  let rest = capped ? text.slice(0, maxChars) : text;
  const pages: string[] = [];
  while (rest.length > pageChars) {
    let cut = pageChars;
    const newline = rest.lastIndexOf("\n", pageChars);
    if (newline > pageChars * 0.8) {
      cut = newline + 1;
    } else {
      const high = rest.charCodeAt(cut - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        cut -= 1;
      }
    }
    pages.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.length > 0 || pages.length === 0) {
    pages.push(rest);
  }
  return { pages: text === "" ? [] : pages, truncated: capped };
}
