// Spike recorder appends structured observations that get written back into DESIGN.md section 13.
import fs from "node:fs";
import path from "node:path";

export type SpikeNumber = 1 | 2 | 3 | 4;
export type SpikeOutcome = "ok" | "fail" | "info" | "skipped";

export type SpikeObservation = {
  seq: number;
  at: string;
  pid: number;
  spike: SpikeNumber;
  item: string;
  outcome: SpikeOutcome;
  data?: Record<string, unknown>;
};

export type SpikeRecorder = {
  record(
    spike: SpikeNumber,
    item: string,
    outcome: SpikeOutcome,
    data?: Record<string, unknown>,
  ): SpikeObservation;
  list(filter?: { spike?: SpikeNumber; item?: string }): SpikeObservation[];
  toMarkdown(spike?: SpikeNumber): string;
  readonly filePath: string | undefined;
};

/** Read every observation ever appended to the file (all processes, all plugin generations). */
export function readObservationFile(filePath: string): SpikeObservation[] {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const rows: SpikeObservation[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      rows.push(JSON.parse(line) as SpikeObservation);
    } catch {
      // A torn last line after kill -9 must not hide the earlier rows.
    }
  }
  return rows;
}

const MAX_STRING = 600;
const MAX_IN_MEMORY = 2000;

/** Keep observations small and JSON-safe: errors become {name, code, message}. */
export function describeError(error: unknown): Record<string, unknown> {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      name: error.name,
      ...(code === undefined ? {} : { code }),
      message: clip(error.message),
    };
  }
  return { message: clip(String(error)) };
}

function clip(value: string): string {
  return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
}

function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    return clip(value);
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value === undefined || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (depth >= 4) {
    return "[depth]";
  }
  if (value instanceof Error) {
    return describeError(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((entry) => sanitize(entry, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const next = sanitize(entry, depth + 1);
    if (next !== undefined) {
      out[key] = next;
    }
  }
  return out;
}

export function createSpikeRecorder(
  options: { filePath?: string; now?: () => Date } = {},
): SpikeRecorder {
  const now = options.now ?? (() => new Date());
  const entries: SpikeObservation[] = [];
  let seq = 0;
  if (options.filePath) {
    fs.mkdirSync(path.dirname(options.filePath), { recursive: true });
    // Continue the numbering of earlier processes so one file has one total order.
    seq = readObservationFile(options.filePath).reduce((max, row) => Math.max(max, row.seq), 0);
    // A kill -9 can leave a torn last line; start on a fresh line so the next row stays parseable.
    try {
      const existing = fs.readFileSync(options.filePath, "utf8");
      if (existing.length > 0 && !existing.endsWith("\n")) {
        fs.appendFileSync(options.filePath, "\n");
      }
    } catch {
      // No file yet.
    }
  }
  return {
    filePath: options.filePath,
    record(spike, item, outcome, data) {
      const observation: SpikeObservation = {
        seq: ++seq,
        at: now().toISOString(),
        pid: process.pid,
        spike,
        item,
        outcome,
        ...(data === undefined ? {} : { data: sanitize(data) as Record<string, unknown> }),
      };
      entries.push(observation);
      if (entries.length > MAX_IN_MEMORY) {
        entries.shift();
      }
      if (options.filePath) {
        try {
          fs.appendFileSync(options.filePath, `${JSON.stringify(observation)}\n`);
        } catch {
          // Observation persistence is best-effort; the in-memory list still answers the RPC.
        }
      }
      return observation;
    },
    list(filter) {
      return entries.filter(
        (entry) =>
          (filter?.spike === undefined || entry.spike === filter.spike) &&
          (filter?.item === undefined || entry.item === filter.item),
      );
    },
    toMarkdown(spike) {
      const rows = this.list(spike === undefined ? undefined : { spike });
      const lines = ["| # | spike | item | outcome | data |", "|---|---|---|---|---|"];
      for (const row of rows) {
        const data = row.data ? JSON.stringify(row.data).replaceAll("|", "\\|") : "";
        lines.push(`| ${row.seq} | ${row.spike} | ${row.item} | ${row.outcome} | ${data} |`);
      }
      return lines.join("\n");
    },
  };
}

const SHARED_RECORDERS = Symbol.for("nexus-agent-core.spike.recorders");

/**
 * One recorder per file per process. A config reload re-runs register(); without sharing, each
 * generation would get an empty in-memory list and its own seq numbering.
 */
export function getSharedSpikeRecorder(filePath: string): SpikeRecorder {
  const holder = globalThis as { [SHARED_RECORDERS]?: Map<string, SpikeRecorder> };
  const recorders = (holder[SHARED_RECORDERS] ??= new Map());
  let recorder = recorders.get(filePath);
  if (!recorder) {
    recorder = createSpikeRecorder({ filePath });
    recorders.set(filePath, recorder);
  }
  return recorder;
}
