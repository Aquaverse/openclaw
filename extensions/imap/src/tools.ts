import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { ImapAccountConfig, ImapPluginConfig } from "./config.js";
import { listMailboxes, readEmail, saveDraft, searchEmail, sendEmail } from "./mail-client.js";

const ACCOUNT = {
  type: "string",
  minLength: 1,
  description: "Configured account id, full email address, login username, or email prefix.",
};

const MAILBOX = {
  type: "string",
  minLength: 1,
  maxLength: 1024,
  description: "Exact mailbox path returned by email_mailboxes. Defaults to the account inbox.",
};

const ADDRESS_LIST = { type: "array", items: { type: "string" }, minItems: 1 };
const DATE = {
  type: "string",
  pattern: "^\\d{4}-\\d{2}-\\d{2}$",
  description: "Calendar date in YYYY-MM-DD format.",
};

type ConfiguredAccount = { id: string; account: ImapAccountConfig };

function accountSummary({ id, account }: ConfiguredAccount) {
  return { id, email: account.email };
}

function accountAliases({ id, account }: ConfiguredAccount): string[] {
  const localPart = (address: string) => address.split("@", 1)[0] ?? address;
  return [
    id,
    account.email,
    account.from,
    account.user,
    localPart(account.email),
    localPart(account.from),
  ]
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function configuredAccounts(config: ImapPluginConfig): ConfiguredAccount[] {
  return Object.entries(config.accounts).map(([id, account]) => ({ id, account }));
}

function accountFor(config: ImapPluginConfig, value: unknown) {
  const accounts = configuredAccounts(config);
  if (accounts.length === 0) {
    throw new Error("No configured email accounts are available");
  }
  if (accounts.length === 1) {
    return accounts[0]!.account;
  }
  const query = typeof value === "string" ? value.trim().toLowerCase() : "";
  const idMatch = query ? accounts.find(({ id }) => id.toLowerCase() === query) : undefined;
  if (idMatch) {
    return idMatch.account;
  }
  const matches = query
    ? accounts.filter((entry) => accountAliases(entry).includes(query))
    : accounts;
  if (matches.length === 1) {
    return matches[0]!.account;
  }
  const candidates = (matches.length > 0 ? matches : accounts)
    .map(({ id, account }) => `${id} (${account.email})`)
    .join(", ");
  if (matches.length === 0) {
    throw new Error(
      `No configured email account matches ${JSON.stringify(value)}. Available accounts: ${candidates}. Use email_accounts to search by account id, email address, or username.`,
    );
  }
  throw new Error(
    `Multiple configured email accounts match ${JSON.stringify(value)}: ${candidates}. Use email_accounts to find the candidates, then ask the user to choose a specific account id or full email address.`,
  );
}

function strings(value: unknown, name: string): string[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string" && item.trim())
  ) {
    throw new Error(`${name} must contain at least one email address`);
  }
  return value.map((item) => item.trim());
}

export function registerEmailTools(api: OpenClawPluginApi, currentConfig: () => ImapPluginConfig) {
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => ({
        name: "email_accounts",
        label: "Find email accounts",
        description:
          "List or search configured email accounts by account id, email address, or username without exposing credentials. Mail tools automatically use the account when only one is configured.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", maxLength: 320 },
          },
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          const query = typeof record.query === "string" ? record.query.trim().toLowerCase() : "";
          const accounts = configuredAccounts(currentConfig()).filter(
            (entry) =>
              !query || accountAliases(entry).some((candidate) => candidate.includes(query)),
          );
          const result = { accounts: accounts.map(accountSummary), count: accounts.length };
          context.assertInvocationCurrent();
          return textResult(JSON.stringify(result), result);
        },
      }),
    },
    { name: "email_accounts", workspaceAccess: false },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => ({
        name: "email_mailboxes",
        label: "List email folders",
        description:
          "List mailbox paths such as Inbox, Sent, Drafts, and Archive for a configured account. Use the returned exact path with email_search or email_read.",
        parameters: {
          type: "object",
          properties: { account: ACCOUNT },
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          const result = await listMailboxes(accountFor(currentConfig(), record.account));
          context.assertInvocationCurrent();
          return textResult(
            wrapExternalContent(JSON.stringify(result), { source: "unknown" }),
            result,
          );
        },
      }),
    },
    { name: "email_mailboxes", workspaceAccess: false },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => ({
        name: "email_search",
        label: "Search email",
        description:
          "Run a server-side search in a configured mailbox without changing message flags. Supports mailbox, sender, recipient, subject, unread, starred, and date filters. Omit account when only one is configured; use email_accounts to disambiguate multiple accounts.",
        parameters: {
          type: "object",
          properties: {
            account: ACCOUNT,
            mailbox: MAILBOX,
            query: { type: "string", maxLength: 200 },
            from: { type: "string", maxLength: 320 },
            to: { type: "string", maxLength: 320 },
            subject: { type: "string", maxLength: 998 },
            unread: { type: "boolean" },
            flagged: { type: "boolean" },
            since: DATE,
            before: DATE,
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          const result = await searchEmail(accountFor(currentConfig(), record.account), {
            ...(typeof record.mailbox === "string" ? { mailbox: record.mailbox } : {}),
            ...(typeof record.query === "string" ? { query: record.query } : {}),
            ...(typeof record.from === "string" ? { from: record.from } : {}),
            ...(typeof record.to === "string" ? { to: record.to } : {}),
            ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
            ...(record.unread === true ? { unread: true } : {}),
            ...(record.flagged === true ? { flagged: true } : {}),
            ...(typeof record.since === "string" ? { since: record.since } : {}),
            ...(typeof record.before === "string" ? { before: record.before } : {}),
            limit: typeof record.limit === "number" ? record.limit : 20,
          });
          context.assertInvocationCurrent();
          return textResult(
            wrapExternalContent(JSON.stringify(result), { source: "unknown" }),
            result,
          );
        },
      }),
    },
    { name: "email_search", workspaceAccess: false },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => ({
        name: "email_read",
        label: "Read email",
        description:
          "Read one email by mailbox UID without changing message flags. Omit account when only one is configured; use email_accounts to disambiguate multiple accounts.",
        parameters: {
          type: "object",
          properties: {
            account: ACCOUNT,
            mailbox: MAILBOX,
            uid: { type: "integer", minimum: 1 },
          },
          required: ["uid"],
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          if (!Number.isInteger(record.uid)) {
            throw new Error("uid must be a positive integer");
          }
          const result = await readEmail(
            accountFor(currentConfig(), record.account),
            record.uid as number,
            typeof record.mailbox === "string" ? record.mailbox : undefined,
          );
          context.assertInvocationCurrent();
          return textResult(
            wrapExternalContent(JSON.stringify(result), { source: "unknown" }),
            result,
          );
        },
      }),
    },
    { name: "email_read", workspaceAccess: false },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => ({
        name: "email_draft",
        label: "Save email draft",
        description:
          "Save a plain-text message in the account's IMAP Drafts folder without sending it. The user can later review and send it from their mail client. This tool never uses SMTP and does not require send approval.",
        parameters: {
          type: "object",
          properties: {
            account: ACCOUNT,
            to: ADDRESS_LIST,
            cc: ADDRESS_LIST,
            bcc: ADDRESS_LIST,
            subject: { type: "string", maxLength: 998 },
            text: { type: "string", minLength: 1, maxLength: 200000 },
          },
          required: ["text"],
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          const result = await saveDraft(accountFor(currentConfig(), record.account), {
            ...(Array.isArray(record.to) ? { to: strings(record.to, "to") } : {}),
            ...(Array.isArray(record.cc) ? { cc: strings(record.cc, "cc") } : {}),
            ...(Array.isArray(record.bcc) ? { bcc: strings(record.bcc, "bcc") } : {}),
            ...(typeof record.subject === "string" ? { subject: record.subject } : {}),
            text: String(record.text),
          });
          context.assertInvocationCurrent();
          return textResult(JSON.stringify(result), result);
        },
      }),
    },
    { name: "email_draft", workspaceAccess: false },
  );
  api.registerTool(
    {
      contextVersion: 2,
      create: (context) => ({
        name: "email_send",
        label: "Send email",
        description:
          "Send a plain-text email from a configured account. Omit account when only one is configured; use email_accounts to disambiguate multiple accounts. Requires one-time approval.",
        parameters: {
          type: "object",
          properties: {
            account: ACCOUNT,
            to: ADDRESS_LIST,
            cc: ADDRESS_LIST,
            bcc: ADDRESS_LIST,
            subject: { type: "string", minLength: 1, maxLength: 998 },
            text: { type: "string", minLength: 1, maxLength: 200000 },
          },
          required: ["to", "subject", "text"],
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          const result = await sendEmail(accountFor(currentConfig(), record.account), {
            to: strings(record.to, "to"),
            ...(Array.isArray(record.cc) ? { cc: strings(record.cc, "cc") } : {}),
            ...(Array.isArray(record.bcc) ? { bcc: strings(record.bcc, "bcc") } : {}),
            subject: String(record.subject),
            text: String(record.text),
          });
          context.assertInvocationCurrent();
          return textResult(JSON.stringify(result), result);
        },
      }),
    },
    { name: "email_send", workspaceAccess: false },
  );
  api.on("before_tool_call", (event) => {
    if (event.toolName !== "email_send") {
      return;
    }
    const params = event.params as Record<string, unknown>;
    const recipients = Array.isArray(params.to) ? params.to.join(", ") : "unknown recipients";
    return {
      requireApproval: {
        title: "Send email",
        description: `Send “${String(params.subject ?? "(no subject)").slice(0, 160)}” to ${recipients.slice(0, 280)}?`,
        severity: "warning",
        allowedDecisions: ["allow-once", "deny"],
      },
    };
  });
}
