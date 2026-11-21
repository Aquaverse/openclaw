import fs from "node:fs";
import type { IdentifierAuthentication } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { expect, it } from "vitest";
import { resolveImapConfig } from "./config.js";

it("rejects invalid passwords while deferring unresolved secret references", () => {
  const account = {
    host: "imap.example.com",
    user: "reader@example.com",
    agentId: "mail_reader",
  };
  for (const password of [undefined, null, 123, false, []]) {
    expect(() => resolveImapConfig({ accounts: { inbox: { ...account, password } } })).toThrow(
      "IMAP account inbox requires a resolved password",
    );
  }
  expect(
    resolveImapConfig({
      accounts: {
        inbox: {
          ...account,
          password: { source: "env", provider: "default", id: "IMAP_PASSWORD" },
        },
      },
    }),
  ).toEqual({ accounts: {} });
});

it("accepts all SDK authentication strengths and rejects an unknown config minimum", () => {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const strengths = [
    "mutable",
    "unverified",
    "asserted",
    "verified",
  ] satisfies IdentifierAuthentication[];
  for (const min of [...strengths, "unknown"]) {
    const value = {
      accounts: {
        inbox: {
          host: "imap.example.com",
          user: "reader@example.com",
          password: "fixture-password",
          agentId: "mail_reader",
          senderAuth: { min },
        },
      },
    };
    expect(
      validateJsonSchemaValue({
        schema: manifest.configSchema,
        cacheKey: "imap.manifest.config-schema",
        value,
      }).ok,
    ).toBe(min !== "unknown");
    if (min !== "unknown") {
      expect(resolveImapConfig(value).accounts.inbox?.senderAuth.min).toBe(min);
    }
  }
});

it("accepts a mailbox account without enabling the incoming-message watcher", () => {
  const account = resolveImapConfig({
    accounts: {
      work: {
        email: "person@example.com",
        from: "person@example.com",
        host: "imap.example.com",
        port: 993,
        secure: true,
        user: "person",
        password: "fixture-password",
        smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
      },
    },
  }).accounts.work;

  expect(account).toMatchObject({
    email: "person@example.com",
    from: "person@example.com",
    smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
  });
  expect(account).not.toHaveProperty("agentId");
});
