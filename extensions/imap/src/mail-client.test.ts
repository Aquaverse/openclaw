import { beforeEach, expect, it, vi } from "vitest";
import type { ImapAccountConfig } from "./config.js";
import { sendEmail } from "./mail-client.js";

const smtp = vi.hoisted(() => ({
  sendMail: vi.fn(),
  close: vi.fn(),
}));
const imap = vi.hoisted(() => ({
  connect: vi.fn(),
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
  imap.list.mockResolvedValue([{ path: "INBOX" }, { path: "Sent Items", specialUse: "\\Sent" }]);
  imap.append.mockResolvedValue({ uid: 42 });
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
