import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ImapAccountConfig } from "./config.js";

const MAX_READ_BYTES = 1_048_576;

type OutgoingMessage = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  text: string;
};

function imapClient(account: ImapAccountConfig) {
  return new ImapFlow({
    host: account.host,
    port: account.port,
    secure: account.secure,
    auth: { user: account.user, pass: account.password },
    logger: false,
    maxLiteralSize: MAX_READ_BYTES + 8_192,
    maxResponseSize: MAX_READ_BYTES + 32_768,
  });
}

function smtpTransport(account: ImapAccountConfig) {
  if (!account.smtp) {
    throw new Error("SMTP is not configured for this email account");
  }
  return createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.security === "tls",
    requireTLS: account.smtp.security === "starttls",
    auth: { user: account.user, pass: account.password },
  });
}

function connectionErrorDetail(error: unknown): string {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let genericMessage = "Command failed";
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    const record = asOptionalRecord(current);
    if (!record) {
      const text = String(current).trim();
      return text || genericMessage;
    }
    for (const key of ["responseText", "response"] as const) {
      const detail = record[key];
      if (typeof detail === "string" && detail.trim()) {
        return detail.trim();
      }
    }
    const message = typeof record.message === "string" ? record.message.trim() : "";
    if (message && message.toLowerCase() !== "command failed") {
      const code = typeof record.code === "string" ? record.code.trim() : "";
      return code && !message.includes(code) ? `${code}: ${message}` : message;
    }
    if (message) {
      genericMessage = message;
    }
    current = record.cause;
  }
  return genericMessage;
}

function mailConnectionError(
  protocol: "IMAP" | "SMTP",
  host: string,
  port: number,
  cause: unknown,
) {
  return new Error(
    `${protocol} connection to ${host}:${port} failed: ${connectionErrorDetail(cause)}`,
    cause instanceof Error ? { cause } : undefined,
  );
}

export async function testEmailConnection(account: ImapAccountConfig) {
  const client = imapClient(account);
  try {
    await client.connect();
    await client.mailboxOpen(account.mailbox, { readOnly: true });
  } catch (cause) {
    throw mailConnectionError("IMAP", account.host, account.port, cause);
  } finally {
    client.close();
  }
  let transport: ReturnType<typeof smtpTransport> | undefined;
  try {
    transport = smtpTransport(account);
    await transport.verify();
  } catch (cause) {
    throw mailConnectionError(
      "SMTP",
      account.smtp?.host ?? "unconfigured",
      account.smtp?.port ?? 0,
      cause,
    );
  } finally {
    transport?.close();
  }
  return { imap: "ok" as const, smtp: "ok" as const };
}

export async function listMailboxes(account: ImapAccountConfig) {
  const client = imapClient(account);
  try {
    await client.connect();
    return (await client.list()).map((mailbox) => {
      const summary: { path: string; specialUse?: string } = { path: mailbox.path };
      if (mailbox.specialUse) {
        summary.specialUse = mailbox.specialUse;
      }
      return summary;
    });
  } finally {
    client.close();
  }
}

export async function searchEmail(
  account: ImapAccountConfig,
  input: {
    mailbox?: string;
    query?: string;
    from?: string;
    to?: string;
    subject?: string;
    unread?: boolean;
    flagged?: boolean;
    since?: string;
    before?: string;
    limit: number;
  },
) {
  const client = imapClient(account);
  try {
    await client.connect();
    const mailbox = input.mailbox ?? account.mailbox;
    await client.mailboxOpen(mailbox, { readOnly: true });
    const terms: Record<string, unknown> = {};
    if (input.query) {
      terms.or = [
        { subject: input.query },
        { body: input.query },
        { from: input.query },
        { to: input.query },
      ];
    }
    if (input.from) {
      terms.from = input.from;
    }
    if (input.to) {
      terms.to = input.to;
    }
    if (input.subject) {
      terms.subject = input.subject;
    }
    if (input.unread) {
      terms.seen = false;
    }
    if (input.flagged) {
      terms.flagged = true;
    }
    if (input.since) {
      terms.since = input.since;
    }
    if (input.before) {
      terms.before = input.before;
    }
    if (Object.keys(terms).length === 0) {
      terms.all = true;
    }
    const found = await client.search(terms, { uid: true });
    const uids = Array.isArray(found) ? found.slice(-input.limit).toReversed() : [];
    const messages = [];
    for (const uid of uids) {
      const message = await client.fetchOne(
        uid.toString(),
        { uid: true, envelope: true },
        { uid: true },
      );
      if (!message) {
        continue;
      }
      messages.push({
        uid: message.uid,
        mailbox,
        subject: message.envelope?.subject ?? "",
        from: message.envelope?.from?.map((entry) => entry.address).filter(Boolean) ?? [],
        to: message.envelope?.to?.map((entry) => entry.address).filter(Boolean) ?? [],
        date:
          message.envelope?.date instanceof Date
            ? message.envelope.date.toISOString()
            : (message.envelope?.date ?? null),
      });
    }
    return messages;
  } finally {
    client.close();
  }
}

export async function readEmail(account: ImapAccountConfig, uid: number, mailbox?: string) {
  const client = imapClient(account);
  try {
    await client.connect();
    const selectedMailbox = mailbox ?? account.mailbox;
    await client.mailboxOpen(selectedMailbox, { readOnly: true });
    const message = await client.fetchOne(
      uid.toString(),
      { uid: true, source: true },
      { uid: true },
    );
    if (!message || !message.source) {
      throw new Error(`Email UID ${uid} was not found`);
    }
    if (message.source.byteLength > MAX_READ_BYTES) {
      throw new Error(`Email UID ${uid} exceeds the 1 MB read limit`);
    }
    const parsed = await simpleParser(message.source);
    return {
      uid,
      mailbox: selectedMailbox,
      messageId: parsed.messageId ?? null,
      subject: parsed.subject ?? "",
      from: parsed.from?.text ?? "",
      to: parsed.to
        ? Array.isArray(parsed.to)
          ? parsed.to.map((value) => value.text)
          : parsed.to.text
        : "",
      cc: parsed.cc
        ? Array.isArray(parsed.cc)
          ? parsed.cc.map((value) => value.text)
          : parsed.cc.text
        : "",
      date: parsed.date?.toISOString() ?? null,
      text: parsed.text?.slice(0, 100_000) ?? "",
    };
  } finally {
    client.close();
  }
}

async function composeMessage(
  account: ImapAccountConfig,
  input: OutgoingMessage,
  keepBcc: boolean,
) {
  const createdAt = new Date();
  const message = new MailComposer({ from: account.from, ...input, date: createdAt }).compile();
  message.keepBcc = keepBcc;
  return { raw: await message.build(), createdAt };
}

export async function saveDraft(account: ImapAccountConfig, input: OutgoingMessage) {
  const { raw, createdAt } = await composeMessage(account, input, true);
  const client = imapClient(account);
  try {
    await client.connect();
    const mailbox = (await client.list()).find(
      (candidate) => candidate.specialUse === "\\Drafts",
    )?.path;
    if (!mailbox) {
      throw new Error("No IMAP mailbox advertises the \\Drafts special-use flag");
    }
    const appended = await client.append(mailbox, raw, ["\\Draft"], createdAt);
    if (!appended) {
      throw new Error(`IMAP did not confirm the append to ${mailbox}`);
    }
    return {
      status: "saved" as const,
      mailbox,
      ...(typeof appended.uid === "number" ? { uid: appended.uid } : {}),
    };
  } finally {
    client.close();
  }
}

export async function sendEmail(
  account: ImapAccountConfig,
  input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string },
) {
  const { raw, createdAt: sentAt } = await composeMessage(account, input, false);
  const transport = smtpTransport(account);
  const result = await transport
    .sendMail({
      envelope: {
        from: account.from,
        to: [...input.to, ...(input.cc ?? []), ...(input.bcc ?? [])],
      },
      raw,
    })
    .finally(() => transport.close());

  const sent = {
    delivery: "sent" as const,
    accepted: result.accepted,
    rejected: result.rejected,
    messageId: result.messageId,
  };
  if (!account.saveSentCopy) {
    return { ...sent, sentCopy: { status: "disabled" as const } };
  }

  const client = imapClient(account);
  try {
    await client.connect();
    const mailbox =
      account.sentMailbox ??
      (await client.list()).find((candidate) => candidate.specialUse === "\\Sent")?.path;
    if (!mailbox) {
      throw new Error("No IMAP mailbox advertises the \\Sent special-use flag");
    }
    const appended = await client.append(mailbox, raw, ["\\Seen"], sentAt);
    if (!appended) {
      throw new Error(`IMAP did not confirm the append to ${mailbox}`);
    }
    return {
      ...sent,
      sentCopy: {
        status: "saved" as const,
        mailbox,
        ...(typeof appended.uid === "number" ? { uid: appended.uid } : {}),
      },
    };
  } catch (error) {
    return {
      ...sent,
      sentCopy: {
        status: "failed" as const,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    client.close();
  }
}
