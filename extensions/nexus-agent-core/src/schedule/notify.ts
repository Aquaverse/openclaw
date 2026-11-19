// The one notification a follow-up check can carry (the user's choice in the plan form): "when this check sees a change, tell this
// channel". It is part of the plan the user accepts, and it is sent by this plugin after the check has REPORTED, never by the check's
// model, so the model cannot send anything or send it anywhere else. If the chosen channel is not available at that moment, nothing
// is sent and no other channel is tried: the check record only says the chosen channel was unavailable.
import {
  NOTIFY_LIMITS,
  NOTIFY_PLACEHOLDERS,
  type CheckOutcome,
  type NoticeRecord,
  type NotifySpec,
} from "./types.js";

const CHANNEL_ID = /^[a-z][a-z0-9_-]{0,39}$/u;
const ACCOUNT_ID = /^[A-Za-z0-9_.-]{1,64}$/u;

const WRAP_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  "`": "`",
  "\u201c": "\u201d",
  "\u2018": "\u2019",
  "\u300c": "\u300d",
  "\u300e": "\u300f",
  "<": ">",
};

/**
 * What a person types into "send to" is rarely exactly what a channel wants: full-width `\uff03`/`\uff20`, quotes around it, a pasted
 * mention (`<#C0123|general>`), or a link copied from the app. This turns the common shapes into the channel's own id form and
 * leaves everything else exactly as typed (names, `#name`, `@name`, ids, phone numbers), so the host's resolver sees the real intent.
 */
export function tidyTarget(raw: string): string {
  let t = raw.normalize("NFKC").trim();
  for (let i = 0; i < 2 && t.length > 2; i += 1) {
    const close = WRAP_PAIRS[t[0] ?? ""];
    if (close === undefined || !t.endsWith(close) || (t[0] === "<" && /^<[#@]/u.test(t))) {
      break;
    }
    t = t.slice(1, -1).trim();
  }
  // Mentions: <#C0123|name> (Slack), <#123456> (Discord channel), <@U0123|name> (Slack user).
  const mention = /^<([#@])([A-Za-z0-9]+)(?:\|[^>]*)?>$/u.exec(t);
  if (mention) {
    const [, sigil, id = ""] = mention;
    if (sigil === "#") {
      return `channel:${id}`;
    }
    if (/^[UW][A-Z0-9]+$/u.test(id)) {
      return `user:${id}`;
    }
    return t;
  }
  // Links copied from the apps.
  const slack = /^https?:\/\/[^/\s]+\.slack\.com\/archives\/([CG][A-Z0-9]+)(?:[/?#]\S*)?$/u.exec(t);
  if (slack?.[1]) {
    return `channel:${slack[1]}`;
  }
  const discord =
    /^https?:\/\/(?:[a-z]+\.)?discord(?:app)?\.com\/channels\/(?:\d+|@me)\/(\d+)(?:[/?#]\S*)?$/iu.exec(
      t,
    );
  if (discord?.[1]) {
    return `channel:${discord[1]}`;
  }
  const tgPrivate = /^(?:https?:\/\/)?t\.me\/c\/(\d+)(?:[/?#]\S*)?$/iu.exec(t);
  if (tgPrivate?.[1]) {
    return `-100${tgPrivate[1]}`;
  }
  const tgName = /^(?:https?:\/\/)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})(?:[/?#]\S*)?$/iu.exec(t);
  if (tgName?.[1]) {
    return `@${tgName[1]}`;
  }
  // "# name" / "@ name" typed with a space.
  return t.replace(/^([#@])\s+/u, "$1");
}

/** A hint for a send that failed on a destination that is a name, not an id: what the person can do about it. */
function nameHint(to: string): string {
  const idLike =
    /^(?:channel|user|chat|group|dm|open_id|spaces|users|room|conversation|uuid|username):/iu.test(
      to,
    ) || /^[+-]?\d{5,}$/u.test(to);
  return idLike
    ? ""
    : " — 没能按名字找到目的地：请确认机器人已加入/能看到它，或改填 ID（见表单里的填写说明）";
}

/** A stored or submitted `notify`, or null when it is not a complete, valid one (the plan is then refused as `bad_notify`). */
export function parseNotify(raw: unknown): NotifySpec | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const o = raw as Record<string, unknown>;
  const text = typeof o.text === "string" ? o.text.trim() : "";
  const to = typeof o.to === "string" ? tidyTarget(o.to) : "";
  if (
    o.kind !== "channel" ||
    typeof o.channel !== "string" ||
    !CHANNEL_ID.test(o.channel) ||
    (o.accountId !== undefined &&
      (typeof o.accountId !== "string" || !ACCOUNT_ID.test(o.accountId))) ||
    to.length === 0 ||
    to.length > NOTIFY_LIMITS.to ||
    /[\r\n]/u.test(to) ||
    (o.mode !== "template" && o.mode !== "fixed") ||
    typeof o.onChanged !== "boolean" ||
    typeof o.onCannotCheck !== "boolean" ||
    (!o.onChanged && !o.onCannotCheck) ||
    text.length === 0 ||
    text.length > NOTIFY_LIMITS.text
  ) {
    return null;
  }
  return {
    kind: "channel",
    channel: o.channel,
    ...(typeof o.accountId === "string" ? { accountId: o.accountId } : {}),
    to,
    onChanged: o.onChanged,
    onCannotCheck: o.onCannotCheck,
    mode: o.mode,
    text,
  };
}

/** Does this outcome call for the notification the user chose? ("no_change" never does.) */
export function wantsNotice(spec: NotifySpec, outcome: CheckOutcome): boolean {
  return (
    (outcome === "changed" && spec.onChanged) || (outcome === "cannot_check" && spec.onCannotCheck)
  );
}

export type NoticeFacts = {
  outcome: CheckOutcome;
  summary: string;
  purpose: string;
  sources: readonly string[];
  at: number;
  tz?: string;
};

const OUTCOME_WORDS: Record<CheckOutcome, string> = {
  changed: "有变化",
  cannot_check: "没能检查",
  no_change: "没有变化",
};

function formatTime(at: number, tz?: string): string {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      dateStyle: "short",
      timeStyle: "short",
      ...(tz ? { timeZone: tz } : {}),
    }).format(new Date(at));
  } catch {
    return new Date(at).toISOString();
  }
}

/** The message text. A fixed text is sent exactly as the user wrote it; a template has its placeholders filled by the system. */
export function renderNotice(spec: NotifySpec, facts: NoticeFacts): string {
  if (spec.mode === "fixed") {
    return spec.text;
  }
  const values: Record<(typeof NOTIFY_PLACEHOLDERS)[number], string> = {
    "{summary}": facts.summary,
    "{purpose}": facts.purpose,
    "{result}": OUTCOME_WORDS[facts.outcome],
    "{source}": facts.sources[0] ?? "",
    "{time}": formatTime(facts.at, facts.tz),
  };
  let out = spec.text;
  for (const key of NOTIFY_PLACEHOLDERS) {
    out = out.split(key).join(values[key]);
  }
  return out.trim().slice(0, NOTIFY_LIMITS.rendered);
}

export type NoticeSender = (ctx: {
  to: string;
  text: string;
  accountId?: string;
  signal?: AbortSignal;
}) => Promise<unknown>;

/** What the plugin needs from the host to send, kept small so tests can stand in for it. */
export type NoticeHost = {
  /** Channel ids the host has configured and enabled right now (config only; whether a send works is found out on send). */
  connectedChannels: () => string[];
  /**
   * Turns what the user typed for "where" (a `#name`) into the id the channel sends to, by the channel's own directory: the same
   * resolution a message typed in chat gets. Undefined on a host that offers none (the text is then sent as typed).
   */
  resolveTarget?: (params: {
    channel: string;
    to: string;
    accountId?: string;
  }) => Promise<{ ok: true; to: string } | { ok: false; error: string }>;
  /** The host's outbound text send for one channel, or undefined when the channel plugin is not loaded. */
  loadSender: (channel: string) => Promise<NoticeSender | undefined>;
  logger?: { info(message: string): void; warn(message: string): void };
};

const SEND_TIMEOUT_MS = 15_000;

/** Sends the one chosen notification and says what happened; it never throws and never tries another channel. */
export async function sendNotice(
  host: NoticeHost,
  spec: NotifySpec,
  text: string,
  now: () => number = Date.now,
): Promise<NoticeRecord> {
  const base = { channel: spec.channel, to: spec.to, at: now() };
  if (!host.connectedChannels().includes(spec.channel)) {
    return { ...base, status: "unavailable" };
  }
  let send: NoticeSender | undefined;
  try {
    send = await host.loadSender(spec.channel);
  } catch {
    send = undefined;
  }
  if (!send) {
    return { ...base, status: "unavailable" };
  }
  const typed = tidyTarget(spec.to);
  let target = typed;
  if (host.resolveTarget) {
    const resolved = await host.resolveTarget({
      channel: spec.channel,
      to: typed,
      ...(spec.accountId ? { accountId: spec.accountId } : {}),
    });
    if (!resolved.ok) {
      const reason = `${resolved.error.slice(0, 160)}${nameHint(typed)}`;
      host.logger?.warn(`nexus: notice target not resolved for ${spec.channel}: ${reason}`);
      return { ...base, status: "failed", reason };
    }
    target = resolved.to;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    await send({
      to: target,
      text,
      ...(spec.accountId ? { accountId: spec.accountId } : {}),
      signal: controller.signal,
    });
    return { ...base, at: now(), status: "sent" };
  } catch (error) {
    // The reason is kept short and is the host's own error text, never the message content.
    const raw = error instanceof Error ? error.message : String(error);
    // A name that stayed a name (not found in the channel's directory) is refused by most channels as "needs an id": say what to do.
    const hint =
      target === typed && /\b(?:ids?|not found|unknown|invalid|resolve)\b/iu.test(raw)
        ? nameHint(typed)
        : "";
    const reason = `${raw}${hint}`.slice(0, 200);
    host.logger?.warn(`nexus: notice to ${spec.channel} failed: ${reason}`);
    return { ...base, status: "failed", reason };
  } finally {
    clearTimeout(timer);
  }
}

export type ConnectedChannel = { id: string; accounts: string[] };

/**
 * The channels the host has configured and not switched off, read from its config. This only says the channel is set up: whether a
 * send works is found out when it is sent (and a failure is recorded, nothing else is tried).
 */
export function connectedChannels(cfg: unknown): ConnectedChannel[] {
  const channels = (cfg as { channels?: unknown } | null | undefined)?.channels;
  if (typeof channels !== "object" || channels === null) {
    return [];
  }
  const out: ConnectedChannel[] = [];
  for (const [id, value] of Object.entries(channels as Record<string, unknown>)) {
    if (
      !CHANNEL_ID.test(id) ||
      typeof value !== "object" ||
      value === null ||
      (value as { enabled?: unknown }).enabled === false
    ) {
      continue;
    }
    const accounts = (value as { accounts?: unknown }).accounts;
    out.push({
      id,
      accounts:
        typeof accounts === "object" && accounts !== null && !Array.isArray(accounts)
          ? Object.keys(accounts).filter((a) => ACCOUNT_ID.test(a))
          : [],
    });
  }
  return out.toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
