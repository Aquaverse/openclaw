import { beforeEach, expect, it, vi } from "vitest";
import type { ImapAccountConfig } from "./config.js";
import {
  listMailboxes,
  saveDraft,
  searchEmail,
  sendEmail,
  testEmailConnection,
} from "./mail-client.js";

const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(),
  verify: vi.fn(),
  close: vi.fn(),
}));
const imap = vi.hoisted(() => ({
  connect: vi.fn(),
  mailboxOpen: vi.fn(),
  search: vi.fn(),
  fetchOne: vi.fn(),
  list: vi.fn(),
  append: vi.fn(),
  close: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => smtp),
}));

vi.mock("imapflow", () => ({
  ImapFlow: class {
    connect = imap.connect;
    mailboxOpen = imap.mailboxOpen;
    search = imap.search;
    fetchOne = imap.fetchOne;
    list = imap.list;
    append = imap.append;
    close = imap.close;
  },
}));

const account = (overrides: Partial<ImapAccountConfig> = {}): ImapAccountConfig => ({
  email: "sender@example.com",
  from: "sender@example.com",
  host: "imap.example.com",
  port: 993,
  secure: true,
  user: "sender",
  password: "fixture-password",
  mailbox: "INBOX",
  saveSentCopy: true,
  watch: { mode: "auto", pollSeconds: 60 },
  allowedSenders: [],
  senderAuth: {
    min: "verified",
    trustedAuthservIds: [],
    acceptTrustedAuthservId: false,
  },
  addressTokens: [],
  smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
  deliver: false,
  includeBody: true,
  maxBytes: 20_000,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  smtp.sendMail.mockResolvedValue({
    accepted: ["recipient@example.com"],
    rejected: [],
    messageId: "<message@example.com>",
  });
  smtp.verify.mockResolvedValue(true);
  imap.connect.mockResolvedValue(undefined);
  imap.mailboxOpen.mockResolvedValue(undefined);
  imap.list.mockResolvedValue([{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }]);
  imap.append.mockResolvedValue({ uid: 42 });
});

it("reports the IMAP server response instead of a generic command failure", async () => {
  const failure = Object.assign(new Error("Command failed"), {
    responseText: "[AUTHENTICATIONFAILED] Invalid username or password",
  });
  imap.connect.mockRejectedValueOnce(failure);

  await expect(testEmailConnection(account())).rejects.toThrow(
    "IMAP connection to imap.example.com:993 failed: [AUTHENTICATIONFAILED] Invalid username or password",
  );
  expect(smtp.verify).not.toHaveBeenCalled();
});

it("reports SMTP connection details when verification fails", async () => {
  smtp.verify.mockRejectedValueOnce(
    Object.assign(new Error("Connection refused"), { code: "ECONNREFUSED" }),
  );

  await expect(testEmailConnection(account())).rejects.toThrow(
    "SMTP connection to smtp.example.com:587 failed: ECONNREFUSED: Connection refused",
  );
});

it("sends one message and archives the same RFC822 bytes in the discovered Sent mailbox", async () => {
  const result = await sendEmail(account(), {
    to: ["recipient@example.com"],
    bcc: ["private@example.com"],
    subject: "Status",
    text: "Ready",
  });

  expect(smtp.sendMail).toHaveBeenCalledOnce();
  const sent = smtp.sendMail.mock.calls[0]?.[0] as {
    envelope: { from: string; to: string[] };
    raw: Buffer;
  };
  expect(sent.envelope).toEqual({
    from: "sender@example.com",
    to: ["recipient@example.com", "private@example.com"],
  });
  expect(sent.raw).toBeInstanceOf(Buffer);
  expect(sent.raw.toString()).not.toContain("Bcc:");
  expect(imap.append).toHaveBeenCalledWith("Sent Items", sent.raw, ["\\Seen"], expect.any(Date));
  expect(result).toMatchObject({
    delivery: "sent",
    messageId: "<message@example.com>",
    sentCopy: { status: "saved", mailbox: "Sent Items", uid: 42 },
  });
});

it("uses the configured Sent mailbox without listing mailboxes", async () => {
  const result = await sendEmail(account({ sentMailbox: "已发送" }), {
    to: ["recipient@example.com"],
    subject: "Status",
    text: "Ready",
  });

  expect(imap.list).not.toHaveBeenCalled();
  expect(imap.append).toHaveBeenCalledWith(
    "已发送",
    expect.any(Buffer),
    ["\\Seen"],
    expect.any(Date),
  );
  expect(result.sentCopy).toMatchObject({ status: "saved", mailbox: "已发送" });
});

it("does not connect to IMAP when Sent-copy archiving is disabled", async () => {
  const result = await sendEmail(account({ saveSentCopy: false }), {
    to: ["recipient@example.com"],
    subject: "Status",
    text: "Ready",
  });

  expect(smtp.sendMail).toHaveBeenCalledOnce();
  expect(imap.connect).not.toHaveBeenCalled();
  expect(result.sentCopy).toEqual({ status: "disabled" });
});

it("does not archive a message that SMTP rejected", async () => {
  smtp.sendMail.mockRejectedValueOnce(new Error("SMTP rejected the message"));

  await expect(
    sendEmail(account(), {
      to: ["recipient@example.com"],
      subject: "Status",
      text: "Ready",
    }),
  ).rejects.toThrow("SMTP rejected the message");
  expect(imap.connect).not.toHaveBeenCalled();
  expect(imap.append).not.toHaveBeenCalled();
});

it("reports SMTP success and a failed Sent copy without resending", async () => {
  imap.append.mockRejectedValueOnce(new Error("append denied"));

  const result = await sendEmail(account(), {
    to: ["recipient@example.com"],
    subject: "Status",
    text: "Ready",
  });

  expect(smtp.sendMail).toHaveBeenCalledOnce();
  expect(result).toMatchObject({
    delivery: "sent",
    accepted: ["recipient@example.com"],
    messageId: "<message@example.com>",
    sentCopy: { status: "failed", error: "append denied" },
  });
});

it("saves a draft in the discovered Drafts mailbox without touching SMTP", async () => {
  imap.list.mockResolvedValueOnce([{ path: "INBOX" }, { path: "Drafts", specialUse: "\\Drafts" }]);

  const result = await saveDraft(account(), {
    to: ["recipient@example.com"],
    bcc: ["private@example.com"],
    subject: "Status",
    text: "Ready",
  });

  expect(smtp.sendMail).not.toHaveBeenCalled();
  expect(imap.append).toHaveBeenCalledWith(
    "Drafts",
    expect.any(Buffer),
    ["\\Draft"],
    expect.any(Date),
  );
  const raw = imap.append.mock.calls[0]?.[1] as Buffer;
  expect(raw.toString()).toContain("To: recipient@example.com");
  expect(raw.toString()).toContain("Bcc: private@example.com");
  expect(result).toMatchObject({ status: "saved", mailbox: "Drafts", uid: 42 });
});

it("lists mailbox paths and special-use roles", async () => {
  imap.list.mockResolvedValueOnce([
    { path: "INBOX", specialUse: "\\Inbox", listed: true },
    { path: "Drafts", specialUse: "\\Drafts", listed: true },
  ]);

  await expect(listMailboxes(account())).resolves.toEqual([
    { path: "INBOX", specialUse: "\\Inbox" },
    { path: "Drafts", specialUse: "\\Drafts" },
  ]);
});

it("searches the selected mailbox with structured server-side filters", async () => {
  imap.search.mockResolvedValueOnce([17]);
  imap.fetchOne.mockResolvedValueOnce({
    uid: 17,
    envelope: {
      subject: "Quarterly report",
      from: [{ address: "sender@example.com" }],
      to: [{ address: "recipient@example.com" }],
      date: new Date("2026-11-20T10:00:00Z"),
    },
  });

  const result = await searchEmail(account(), {
    mailbox: "Archive",
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "Quarterly report",
    unread: true,
    flagged: true,
    since: "2026-11-01",
    before: "2026-11-21",
    limit: 10,
  });

  expect(imap.mailboxOpen).toHaveBeenCalledWith("Archive", { readOnly: true });
  expect(imap.search).toHaveBeenCalledWith(
    {
      from: "sender@example.com",
      to: "recipient@example.com",
      subject: "Quarterly report",
      seen: false,
      flagged: true,
      since: "2026-11-01",
      before: "2026-11-21",
    },
    { uid: true },
  );
  expect(result).toEqual([
    expect.objectContaining({ uid: 17, mailbox: "Archive", subject: "Quarterly report" }),
  ]);
});
