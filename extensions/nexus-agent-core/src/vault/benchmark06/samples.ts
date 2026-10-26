// Benchmark 06 "File processing", first version: the fixed sample set. Every sample is built from literals in this file (no
// binary fixtures), and every expectation was decided by hand, so a score below 100% always means a behaviour change.
// Sample names carry the case id so a failure points at its sample.

const enc = (value: string) => new TextEncoder().encode(value);

/** UTF-16 with a byte order mark, as Windows Notepad writes it. */
const utf16 = (value: string, bigEndian: boolean): Uint8Array => {
  const out = new Uint8Array(2 + value.length * 2);
  out.set(bigEndian ? [0xfe, 0xff] : [0xff, 0xfe]);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const lo = code & 0xff;
    const hi = code >> 8;
    out.set(bigEndian ? [hi, lo] : [lo, hi], 2 + index * 2);
  }
  return out;
};

export type ExtractionSample = {
  id: string;
  name: string;
  bytes: Uint8Array;
  /** `ready`: the exact text that must come back (after the extractor's documented cleaning). `rejected`: the failure code. */
  expect: { state: "ready"; text: string } | { state: "rejected"; code: string };
};

const LONG_LINES = Array.from(
  { length: 40 },
  (_, i) => `line ${String(i).padStart(2, "0")} ${"w".repeat(40)}`,
);

export const EXTRACTION_SAMPLES: readonly ExtractionSample[] = [
  {
    id: "E01 utf-8 text",
    name: "e01-notes.txt",
    bytes: enc("Quarterly budget review\nOwner: Dana\n"),
    expect: { state: "ready", text: "Quarterly budget review\nOwner: Dana" },
  },
  {
    id: "E02 utf-8 with BOM",
    name: "e02-bom.txt",
    bytes: new Uint8Array([0xef, 0xbb, 0xbf, ...enc("Bom file\n")]),
    expect: { state: "ready", text: "Bom file" },
  },
  {
    id: "E03 utf-16 LE",
    name: "e03-utf16le.txt",
    bytes: utf16("Little endian note\n", false),
    expect: { state: "ready", text: "Little endian note" },
  },
  {
    id: "E04 utf-16 BE",
    name: "e04-utf16be.txt",
    bytes: utf16("Big endian note\n", true),
    expect: { state: "ready", text: "Big endian note" },
  },
  {
    id: "E05 gb18030 legacy Chinese",
    name: "e05-旧文件.txt",
    // 发票收据 in GB18030
    bytes: new Uint8Array([0xb7, 0xa2, 0xc6, 0xb1, 0xca, 0xd5, 0xbe, 0xdd]),
    expect: { state: "ready", text: "发票收据" },
  },
  {
    id: "E06 markdown kept as written",
    name: "e06-readme.md",
    bytes: enc("# Trip plan\n\n- Flight on Friday\n- Hotel near the station\n"),
    expect: { state: "ready", text: "# Trip plan\n\n- Flight on Friday\n- Hotel near the station" },
  },
  {
    id: "E07 csv",
    name: "e07-table.csv",
    bytes: enc("item,amount\nrent,1200\nwater,35\n"),
    expect: { state: "ready", text: "item,amount\nrent,1200\nwater,35" },
  },
  {
    id: "E08 json",
    name: "e08-data.json",
    bytes: enc('{"vendor":"Acme Power","total":87.5}'),
    expect: { state: "ready", text: '{"vendor":"Acme Power","total":87.5}' },
  },
  {
    id: "E09 html: visible text only",
    name: "e09-page.html",
    bytes: enc(
      "<html><head><style>p{color:red}</style></head><body><!-- hidden comment -->" +
        "<script>var tracker = 1</script><h1>Order confirmed</h1><p>Total &amp; tax: 42&nbsp;USD</p></body></html>",
    ),
    // Block tags become line breaks and runs of blank lines collapse to one, so a heading and a paragraph are one blank line apart.
    expect: { state: "ready", text: "Order confirmed\n\nTotal & tax: 42 USD" },
  },
  {
    id: "E10 CRLF and control characters",
    name: "e10-crlf.txt",
    bytes: enc("first\r\nsecond\u0007 line\rthird"),
    expect: { state: "ready", text: "first\nsecond line\nthird" },
  },
  {
    id: "E11 xml",
    name: "e11-feed.xml",
    bytes: enc('<?xml version="1.0"?><feed><item>alpha</item></feed>'),
    expect: { state: "ready", text: '<?xml version="1.0"?><feed><item>alpha</item></feed>' },
  },
  {
    id: "E12 source code",
    name: "e12-script.py",
    bytes: enc("def total(xs):\n    return sum(xs)\n"),
    expect: { state: "ready", text: "def total(xs):\n    return sum(xs)" },
  },
  {
    id: "E13 astral characters",
    name: "e13-emoji.txt",
    bytes: enc("Birthday plan 🎂 at 7pm 🎉"),
    expect: { state: "ready", text: "Birthday plan 🎂 at 7pm 🎉" },
  },
  {
    id: "E14 long text read back page by page",
    name: "e14-long.txt",
    bytes: enc(LONG_LINES.join("\n")),
    expect: { state: "ready", text: LONG_LINES.join("\n") },
  },
  {
    id: "R01 png is refused, not guessed",
    name: "r01-photo.png",
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
    expect: { state: "rejected", code: "unsupported_type" },
  },
  {
    id: "R02 pdf is refused until a PDF extractor exists",
    name: "r02-scan.pdf",
    bytes: enc("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n"),
    expect: { state: "rejected", code: "unsupported_type" },
  },
  {
    id: "R03 office zip is refused",
    name: "r03-report.docx",
    bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]),
    expect: { state: "rejected", code: "unsupported_type" },
  },
  {
    id: "R04 binary content with a text name",
    name: "r04-binary.txt",
    bytes: new Uint8Array([0x68, 0x69, 0x00, 0x01, 0x02, 0x03, 0x00, 0x00]),
    expect: { state: "rejected", code: "binary_content" },
  },
  {
    id: "R05 over the size limit",
    name: "r05-huge.txt",
    bytes: enc(`huge ${"y".repeat(70_000)}`),
    expect: { state: "rejected", code: "too_large" },
  },
];

// ------------------------------------------------------------------ content search

export type SearchDoc = { name: string; body: string };

/** The corpus of owner A (besides the extraction samples above, which are searchable too) and one document of owner B. */
export const SEARCH_DOCS: readonly SearchDoc[] = [
  {
    name: "s01-lease.txt",
    body: "Apartment lease: monthly rent 1200 USD, due on the first of the month.",
  },
  {
    name: "s02-receipt.txt",
    body: "Receipt from Acme Power. Rent is not included. Electricity 87.5 USD.",
  },
  { name: "s03-发票.txt", body: "本月发票已报销，金额共计三百元。" },
  {
    name: "s04-meeting.md",
    body: "# Planning\nThe budget review moved to Thursday. Alpha team owns the agenda.",
  },
  { name: "s05-wild.txt", body: "Discount is 100% off, code A_B*C" },
  { name: "s06-trip.txt", body: "Flight to Lisbon on Friday, hotel near the station." },
];

export const OTHER_OWNER_DOC: SearchDoc = {
  name: "other-owner.txt",
  body: "rent and budget review and secret-b-word",
};

export type SearchCase = {
  id: string;
  query: string;
  expectNames: readonly string[];
  mode?: "fts" | "like";
};

export const SEARCH_CASES: readonly SearchCase[] = [
  { id: "Q01 single word", query: "lease", expectNames: ["s01-lease.txt"] },
  {
    id: "Q02 every term must match (AND)",
    query: "rent usd",
    expectNames: ["s01-lease.txt", "s02-receipt.txt"],
  },
  {
    id: "Q03 case-insensitive",
    query: "BUDGET REVIEW",
    expectNames: ["e01-notes.txt", "s04-meeting.md"],
  },
  { id: "Q04 text of a legacy-encoded file", query: "发票收据", expectNames: ["e05-旧文件.txt"] },
  {
    id: "Q05 Chinese, three characters or more",
    query: "已报销",
    expectNames: ["s03-发票.txt"],
    mode: "fts",
  },
  {
    id: "Q06 Chinese, two characters (substring scan)",
    query: "发票",
    expectNames: ["e05-旧文件.txt", "s03-发票.txt"],
    mode: "like",
  },
  {
    id: "Q07 text inside html only when visible",
    query: "Order confirmed",
    expectNames: ["e09-page.html"],
  },
  { id: "Q08 script and comment text is not indexed", query: "tracker", expectNames: [] },
  {
    id: "Q09 words of a markdown file",
    query: "Hotel near the station",
    expectNames: ["e06-readme.md", "s06-trip.txt"],
  },
  { id: "Q10 a phrase that appears nowhere", query: "unicorn ledger", expectNames: [] },
  { id: "Q11 another owner's text is invisible", query: "secret-b-word", expectNames: [] },
  {
    id: "Q12 text beyond the first page of a long file",
    query: "line 39",
    expectNames: ["e14-long.txt"],
  },
  { id: "Q13 a rejected file has no text to find", query: "Catalog", expectNames: [] },
  {
    id: "Q14 percent is a character, not a wildcard",
    query: "100%",
    expectNames: ["s05-wild.txt"],
  },
  {
    id: "Q15 underscore is a character, not a wildcard",
    query: "A_B",
    expectNames: ["s05-wild.txt"],
  },
  { id: "Q16 full-text operators are plain text", query: '"alpha" OR *', expectNames: [] },
  {
    id: "Q17 NEAR and column filters are plain text",
    query: "NEAR(rent usd) body:lease",
    expectNames: [],
  },
];
