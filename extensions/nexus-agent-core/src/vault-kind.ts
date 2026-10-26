// The file "kinds" of the Files tab filter, one list for the console, the RPC and the store. A kind is decided by the
// stored media type, which the vault sniffs from the file's first bytes (vault-rules.ts), never by the file name.
// No node or DOM imports: this file is bundled into the Control UI module as well.

export const FILE_KINDS = ["text", "image", "pdf", "office", "other"] as const;
export type FileKind = (typeof FILE_KINDS)[number];

export function parseFileKind(raw: unknown): FileKind | undefined {
  return typeof raw === "string" && (FILE_KINDS as readonly string[]).includes(raw)
    ? (raw as FileKind)
    : undefined;
}

// Fixed fragments over the lower-cased media type: nothing from a request is ever put into the SQL text.
const KIND_SQL: Record<Exclude<FileKind, "other">, (m: string) => string> = {
  text: (m) =>
    `(${m} LIKE 'text/%' OR ${m} IN ('application/json','application/xml','application/x-yaml') OR ${m} LIKE '%+json' OR ${m} LIKE '%+xml')`,
  image: (m) => `${m} LIKE 'image/%'`,
  pdf: (m) => `${m} = 'application/pdf'`,
  office: (m) =>
    `(${m} LIKE 'application/vnd.openxmlformats-officedocument.%' OR ${m} LIKE 'application/vnd.ms-%' OR ${m} = 'application/msword' OR ${m} LIKE 'application/vnd.oasis.opendocument.%')`,
};

/** The SQL condition for a kind over `column` (a media type column such as `o.mime`). */
export function kindCondition(kind: FileKind, column: string): string {
  const m = `lower(${column})`;
  if (kind === "other") {
    return `NOT (${Object.values(KIND_SQL)
      .map((sql) => sql(m))
      .join(" OR ")})`;
  }
  return KIND_SQL[kind](m);
}
