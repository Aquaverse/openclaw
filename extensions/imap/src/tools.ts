import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { textResult } from "openclaw/plugin-sdk/tool-results";
import type { ImapPluginConfig } from "./config.js";
import { readEmail, searchEmail, sendEmail } from "./mail-client.js";

const ACCOUNT = { type: "string", minLength: 1, description: "Configured email account id." };

function accountFor(config: ImapPluginConfig, value: unknown) {
  const id = typeof value === "string" ? value : "";
  const account = config.accounts[id];
  if (!account) {
    throw new Error(`Unknown email account ${JSON.stringify(id)}`);
  }
  return account;
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
        name: "email_search",
        label: "Search email",
        description: "Search a configured mailbox without changing message flags.",
        parameters: {
          type: "object",
          properties: {
            account: ACCOUNT,
            query: { type: "string", maxLength: 200 },
            from: { type: "string", maxLength: 320 },
            unread: { type: "boolean" },
            limit: { type: "integer", minimum: 1, maximum: 50, default: 20 },
          },
          required: ["account"],
          additionalProperties: false,
        },
        async execute(_id, input, signal) {
          context.assertInvocationCurrent();
          signal?.throwIfAborted();
          const record = input as Record<string, unknown>;
          const result = await searchEmail(accountFor(currentConfig(), record.account), {
            ...(typeof record.query === "string" ? { query: record.query } : {}),
            ...(typeof record.from === "string" ? { from: record.from } : {}),
            ...(record.unread === true ? { unread: true } : {}),
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
        description: "Read one email by mailbox UID without changing message flags.",
        parameters: {
          type: "object",
          properties: { account: ACCOUNT, uid: { type: "integer", minimum: 1 } },
          required: ["account", "uid"],
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
        name: "email_send",
        label: "Send email",
        description:
          "Send a plain-text email from a configured account. Requires one-time approval.",
        parameters: {
          type: "object",
          properties: {
            account: ACCOUNT,
            to: { type: "array", items: { type: "string" }, minItems: 1 },
            cc: { type: "array", items: { type: "string" } },
            bcc: { type: "array", items: { type: "string" } },
            subject: { type: "string", minLength: 1, maxLength: 998 },
            text: { type: "string", minLength: 1, maxLength: 200000 },
          },
          required: ["account", "to", "subject", "text"],
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
