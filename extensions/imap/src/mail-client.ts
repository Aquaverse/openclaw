import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createTransport } from "nodemailer";
import type { ImapAccountConfig } from "./config.js";

const MAX_READ_BYTES = 1_048_576;

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

export async function testEmailConnection(account: ImapAccountConfig) {
  const client = imapClient(account);
  try {
    await client.connect();
    await client.mailboxOpen(account.mailbox, { readOnly: true });
  } finally {
    client.close();
  }
  const transport = smtpTransport(account);
  try {
    await transport.verify();
  } finally {
    transport.close();
  }
  return { imap: "ok" as const, smtp: "ok" as const };
}

export async function searchEmail(
  account: ImapAccountConfig,
  input: { query?: string; from?: string; unread?: boolean; limit: number },
) {
  const client = imapClient(account);
  try {
    await client.connect();
    await client.mailboxOpen(account.mailbox, { readOnly: true });
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
    if (input.unread) {
      terms.seen = false;
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

export async function readEmail(account: ImapAccountConfig, uid: number) {
  const client = imapClient(account);
  try {
    await client.connect();
    await client.mailboxOpen(account.mailbox, { readOnly: true });
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

export async function sendEmail(
  account: ImapAccountConfig,
  input: { to: string[]; cc?: string[]; bcc?: string[]; subject: string; text: string },
) {
  const transport = smtpTransport(account);
  try {
    const result = await transport.sendMail({ from: account.from, ...input });
    return { accepted: result.accepted, rejected: result.rejected, messageId: result.messageId };
  } finally {
    transport.close();
  }
}
