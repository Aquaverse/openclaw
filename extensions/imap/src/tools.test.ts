import assert from "node:assert/strict";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, expect, it, vi } from "vitest";
import type { ImapAccountConfig, ImapPluginConfig } from "./config.js";

const mail = vi.hoisted(() => ({
  listMailboxes: vi.fn(),
  readEmail: vi.fn(),
  saveDraft: vi.fn(),
  searchEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock("./mail-client.js", () => mail);

import { registerEmailTools } from "./tools.js";

function account(overrides: Partial<ImapAccountConfig> = {}): ImapAccountConfig {
  return {
    email: "marvinxie@sding.me",
    from: "marvinxie@sding.me",
    host: "mail.sding.me",
    port: 993,
    secure: true,
    user: "marvinxie",
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
    deliver: false,
    includeBody: true,
    maxBytes: 20_000,
    ...overrides,
  };
}

function tools(config: ImapPluginConfig) {
  const registerTool = vi.fn<OpenClawPluginApi["registerTool"]>();
  registerEmailTools(createTestPluginApi({ id: "imap", registerTool }), () => config);
  return (name: string) => {
    const factory = registerTool.mock.calls.find(([, options]) => options?.name === name)?.[0];
    assert(factory && typeof factory !== "function" && "create" in factory, `missing ${name}`);
    const tool = factory.create({ assertInvocationCurrent() {} });
    assert(!Array.isArray(tool), `expected one ${name} tool`);
    return tool;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mail.searchEmail.mockResolvedValue([]);
  mail.listMailboxes.mockResolvedValue([]);
  mail.saveDraft.mockResolvedValue({ status: "saved", mailbox: "Drafts", uid: 42 });
});

it("uses the only configured account when a mailbox tool omits account", async () => {
  const only = account();
  const getTool = tools({ accounts: { personal: only } });

  await getTool("email_search").execute("search", { query: "status" });

  expect(mail.searchEmail).toHaveBeenCalledWith(only, { query: "status", limit: 20 });
});

it("resolves a mailbox tool account by login username or full email", async () => {
  const marvin = account();
  const other = account({
    email: "other@example.com",
    from: "other@example.com",
    user: "other",
  });
  const getTool = tools({ accounts: { marvin, other } });

  await getTool("email_search").execute("username", { account: "marvinxie" });
  await getTool("email_search").execute("address", { account: "other@example.com" });

  expect(mail.searchEmail.mock.calls.map(([selected]) => selected)).toEqual([marvin, other]);
});

it("refuses to guess when multiple accounts match the same username", async () => {
  const getTool = tools({
    accounts: {
      personal: account(),
      work: account({ email: "marvinxie@example.com", from: "marvinxie@example.com" }),
    },
  });

  await expect(
    getTool("email_search").execute("ambiguous", { account: "marvinxie" }),
  ).rejects.toThrow(/multiple configured email accounts.*personal.*work.*email_accounts/iu);
  expect(mail.searchEmail).not.toHaveBeenCalled();
});

it("searches configured accounts without exposing credentials", async () => {
  const getTool = tools({
    accounts: {
      marvin: account(),
      other: account({
        email: "other@example.com",
        from: "other@example.com",
        user: "other",
      }),
    },
  });

  const result = await getTool("email_accounts").execute("accounts", { query: "marvinxie" });

  expect(result.details).toEqual({
    accounts: [{ id: "marvin", email: "marvinxie@sding.me" }],
    count: 1,
  });
  expect(JSON.stringify(result)).not.toContain("fixture-password");
});

it("saves a draft through IMAP without invoking the SMTP sender", async () => {
  const only = account();
  const getTool = tools({ accounts: { personal: only } });

  const result = await getTool("email_draft").execute("draft", {
    to: ["recipient@example.com"],
    subject: "Status",
    text: "Ready",
  });

  expect(mail.saveDraft).toHaveBeenCalledWith(only, {
    to: ["recipient@example.com"],
    subject: "Status",
    text: "Ready",
  });
  expect(mail.sendEmail).not.toHaveBeenCalled();
  expect(result.details).toEqual({ status: "saved", mailbox: "Drafts", uid: 42 });
});

it("lists mailboxes and forwards structured search filters", async () => {
  const only = account();
  const getTool = tools({ accounts: { personal: only } });

  await getTool("email_mailboxes").execute("mailboxes", {});
  await getTool("email_search").execute("search", {
    mailbox: "Archive",
    to: "recipient@example.com",
    subject: "Status",
    flagged: true,
    since: "2026-11-01",
    before: "2026-11-21",
  });

  expect(mail.listMailboxes).toHaveBeenCalledWith(only);
  expect(mail.searchEmail).toHaveBeenCalledWith(only, {
    mailbox: "Archive",
    to: "recipient@example.com",
    subject: "Status",
    flagged: true,
    since: "2026-11-01",
    before: "2026-11-21",
    limit: 20,
  });
});
