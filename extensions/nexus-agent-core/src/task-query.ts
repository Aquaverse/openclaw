// The Task list's query: filters + paging, shared by the HTTP page (GET parameters) and the Control UI module (host page
// parameters). Plain data and pure functions only (no node imports): the browser module bundles this file too.
import { tr, type Lang, type MsgKey } from "./i18n.js";
import { TASK_STATUSES, type TaskStatus } from "./store/types.js";

export const PAGE_SIZES = [20, 50, 100] as const;
export const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE = 100_000;
const MAX_TEXT = 200;
const MAX_ID = 64;

export type TaskFilter = {
  /** Contains-match on the Task id. */
  id: string;
  /** Contains-match on the title. */
  title: string;
  /** Whitespace-separated terms; each must appear in the title, goal, summary or entities. */
  keyword: string;
  /** "" (all), "open", "closed" or one status. */
  status: string;
  /** Created at or after this local time (YYYY-MM-DDTHH:mm in routes and URLs; typed as YYYY-MM-DD HH:mm). */
  from: string;
  /** Created at or before this local time, through the end of that minute (YYYY-MM-DDTHH:mm). */
  to: string;
  page: number;
  size: number;
};

export const EMPTY_FILTER: TaskFilter = {
  id: "",
  title: "",
  keyword: "",
  status: "",
  from: "",
  to: "",
  page: 1,
  size: DEFAULT_PAGE_SIZE,
};

const CLOSED_CHOICES: readonly TaskStatus[] = ["succeeded", "failed", "cancelled"];
/** Statuses a console can usefully filter on: deleted and purging Tasks are never listed. */
const LISTED_STATUSES = TASK_STATUSES.filter(
  (status) => status !== "deleted" && status !== "purging",
);

export const STATUS_CHOICES: ReadonlyArray<readonly [value: string, label: string]> = [
  // Option labels are the system's own words (the same status names the list shows), so they are not translated.
  ["", "all"],
  ["open", "open"],
  ["closed", "closed"],
  ...LISTED_STATUSES.map((status) => [status, status] as const),
];

const STATUS_VALUES = new Set(STATUS_CHOICES.map(([value]) => value));

/** Query-string / host-parameter names for each field. */
export const FILTER_PARAMS = {
  id: "qid",
  title: "qtitle",
  keyword: "qkw",
  status: "status",
  from: "from",
  to: "to",
  page: "page",
  size: "size",
} as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/;

/**
 * A real local calendar date, or date and time (YYYY-MM-DD, or YYYY-MM-DD HH:mm with a space or a T), as a Date;
 * undefined otherwise.
 * `endOfDay` decides what a bare date means: the end of that day (an upper bound) or its start (a lower bound).
 */
function parseLocal(text: string, endOfDay = false): Date | undefined {
  const match = DATE_PATTERN.exec(text);
  if (!match) {
    return undefined;
  }
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const hasTime = match[4] !== undefined;
  const hour = hasTime ? Number(match[4]) : endOfDay ? 23 : 0;
  const minute = hasTime ? Number(match[5]) : endOfDay ? 59 : 0;
  const date = new Date(year, month - 1, day, hour, minute);
  return date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day &&
    date.getHours() === hour &&
    date.getMinutes() === minute
    ? date
    : undefined;
}

const two = (value: number) => String(value).padStart(2, "0");

export function formatDate(date: Date): string {
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The value of a datetime-local control: local time, minute precision. */
export function formatDateTime(date: Date): string {
  return `${formatDate(date)}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

function text(raw: string | undefined, max: number): string {
  return (raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, max);
}

function normalize(value: string, endOfDay: boolean): string {
  const date = parseLocal(value, endOfDay);
  return date ? formatDateTime(date) : "";
}

/** Reads a filter from any string source (URLSearchParams, host props); every field is validated. */
export function parseTaskFilter(read: (name: string) => string | undefined): TaskFilter {
  const get = (key: keyof typeof FILTER_PARAMS) => read(FILTER_PARAMS[key]);
  const status = text(get("status"), 32);
  const from = text(get("from"), 16);
  const to = text(get("to"), 16);
  const page = Number(get("page"));
  const size = Number(get("size"));
  return {
    id: text(get("id"), MAX_ID),
    title: text(get("title"), MAX_TEXT),
    keyword: text(get("keyword"), MAX_TEXT),
    status: STATUS_VALUES.has(status) ? status : "",
    // A bare date (an older link) means the whole day: the bounds are normalised to date and time.
    from: normalize(from, false),
    to: normalize(to, true),
    page: Number.isInteger(page) && page >= 1 ? Math.min(page, MAX_PAGE) : 1,
    size: (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE,
  };
}

/** Only non-default fields, so the plain list keeps a plain URL. */
export function filterToParams(filter: TaskFilter): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (key: keyof typeof FILTER_PARAMS, value: string | number, empty: string | number) => {
    if (value !== empty) {
      out[FILTER_PARAMS[key]] = String(value);
    }
  };
  put("id", filter.id, "");
  put("title", filter.title, "");
  put("keyword", filter.keyword, "");
  put("status", filter.status, "");
  put("from", filter.from, "");
  put("to", filter.to, "");
  put("page", filter.page, 1);
  put("size", filter.size, DEFAULT_PAGE_SIZE);
  return out;
}

export function filterToQuery(filter: TaskFilter): string {
  const query = new URLSearchParams(filterToParams(filter)).toString();
  return query === "" ? "" : `?${query}`;
}

/** True when any search / status / time filter is set (paging alone is not a filter). */
export function filterIsActive(filter: TaskFilter): boolean {
  return (
    filter.id !== "" ||
    filter.title !== "" ||
    filter.keyword !== "" ||
    filter.status !== "" ||
    filter.from !== "" ||
    filter.to !== ""
  );
}

export type TaskListRpcParams = {
  includeClosed: boolean;
  statuses?: TaskStatus[];
  limit: number;
  offset: number;
  id?: string;
  title?: string;
  keyword?: string;
  createdFrom?: number;
  createdTo?: number;
};

/** `nexus.task.list` parameters for a filter. Times are local; the RPC gets epoch milliseconds. */
export function filterToRpc(filter: TaskFilter): TaskListRpcParams {
  const params: TaskListRpcParams = {
    includeClosed: true,
    limit: filter.size,
    offset: (filter.page - 1) * filter.size,
  };
  if (filter.status === "open") {
    params.includeClosed = false;
  } else if (filter.status === "closed") {
    params.statuses = [...CLOSED_CHOICES];
  } else if (filter.status !== "") {
    params.statuses = [filter.status as TaskStatus];
  }
  if (filter.id !== "") {
    params.id = filter.id;
  }
  if (filter.title !== "") {
    params.title = filter.title;
  }
  if (filter.keyword !== "") {
    params.keyword = filter.keyword;
  }
  const from = parseLocal(filter.from);
  if (from) {
    params.createdFrom = from.getTime();
  }
  // "to" names a minute and includes all of it: the database bound is the start of the next one (exclusive).
  const to = parseLocal(filter.to, true);
  if (to) {
    params.createdTo = to.getTime() + 60_000;
  }
  return params;
}

export type TimePreset = "today" | "7d" | "30d";
export const TIME_PRESETS: ReadonlyArray<readonly [TimePreset, MsgKey]> = [
  ["today", "preset.today"],
  ["7d", "preset.7d"],
  ["30d", "preset.30d"],
];

/** From the start of the first local day through the end of today. */
export function presetRange(now: Date, preset: TimePreset): { from: string; to: string } {
  const days = preset === "today" ? 0 : preset === "7d" ? 6 : 29;
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - days);
  return { from: `${formatDate(start)}T00:00`, to: `${formatDate(now)}T23:59` };
}

export function pageInfo(
  filter: TaskFilter,
  total: number,
): { page: number; pages: number; first: number; last: number } {
  const pages = Math.max(1, Math.ceil(total / filter.size));
  const page = Math.min(filter.page, pages);
  const first = total === 0 ? 0 : (page - 1) * filter.size + 1;
  return { page, pages, first, last: Math.min(total, page * filter.size) };
}

/** Page numbers to link: the first, the last and a window around the current one (null = a gap). */
export function pageWindow(page: number, pages: number): Array<number | null> {
  const wanted = new Set([1, pages, page - 2, page - 1, page, page + 1, page + 2]);
  const numbers = [...wanted].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: Array<number | null> = [];
  for (const [index, n] of numbers.entries()) {
    if (index > 0 && n - (numbers[index - 1] as number) > 1) {
      out.push(null);
    }
    out.push(n);
  }
  return out;
}

export type FilterField = {
  key: "id" | "title" | "keyword" | "status" | "from" | "to" | "size";
  label: MsgKey;
  kind: "text" | "select";
  placeholder?: MsgKey;
  maxLength?: number;
};

/** The filter controls, in display order; both pages build their form from this list. */
export const FILTER_FIELDS: readonly FilterField[] = [
  { key: "id", label: "f.id", kind: "text", placeholder: "f.id.ph", maxLength: MAX_ID },
  { key: "title", label: "f.title", kind: "text", placeholder: "f.title.ph", maxLength: MAX_TEXT },
  {
    key: "keyword",
    label: "f.keyword",
    kind: "text",
    placeholder: "f.keyword.ph",
    maxLength: MAX_TEXT,
  },
  { key: "status", label: "f.status", kind: "select" },
  // Plain text, not a native date control: those follow the browser's own language (Chinese year-month-day wording, AM/PM…), while this
  // page, its list and its URLs all use one ISO-style format.
  { key: "from", label: "f.from", kind: "text", placeholder: "f.date.ph", maxLength: 16 },
  { key: "to", label: "f.to", kind: "text", placeholder: "f.date.ph", maxLength: 16 },
  { key: "size", label: "f.size", kind: "select" },
];

/** The options of a select field: status names stay English, the page-size unit follows the language. */
export function filterFieldOptions(
  field: FilterField,
  lang: Lang,
): ReadonlyArray<readonly [value: string, label: string]> {
  if (field.key === "size") {
    return PAGE_SIZES.map((n) => [String(n), tr(lang, "f.sizeOption", { n })] as const);
  }
  return field.key === "status" ? STATUS_CHOICES : [];
}

/** What a control shows: the canonical value, with the date and time separated by a space. */
export function filterFieldValue(filter: TaskFilter, key: FilterField["key"]): string {
  const value = String(filter[key]);
  return key === "from" || key === "to" ? value.replace("T", " ") : value;
}

/** True when a time box has text that is not a real date or date and time (it would otherwise be dropped silently). */
export function hasInvalidTime(read: (name: string) => string | undefined): boolean {
  return (["from", "to"] as const).some((key) => {
    const raw = text(read(FILTER_PARAMS[key]), 16);
    return raw !== "" && parseLocal(raw) === undefined;
  });
}
