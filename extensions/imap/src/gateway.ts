import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveImapConfig } from "./config.js";
import { testEmailConnection } from "./mail-client.js";

function assertCurrent(options: {
  signal?: AbortSignal;
  client?: { invalidated?: boolean } | null;
  hasCurrentClientAuthority?: () => boolean;
  sessionMutationCommitGuard?: () => void;
  sessionMutationAuthorization?: { assertCurrent: () => void };
}) {
  options.signal?.throwIfAborted();
  if (options.client?.invalidated || options.hasCurrentClientAuthority?.() === false) {
    throw new Error("Gateway requester authority changed");
  }
  options.sessionMutationCommitGuard?.();
  options.sessionMutationAuthorization?.assertCurrent();
}

export function registerEmailGatewayMethods(api: OpenClawPluginApi) {
  api.registerGatewayMethod(
    "email.testConnection",
    async (options) => {
      const input = asOptionalRecord(options.params.account);
      if (!input || typeof input.password !== "string") {
        throw new Error("Email account settings and password are required");
      }
      const account = resolveImapConfig({ accounts: { test: input } }).accounts.test;
      if (!account) {
        throw new Error("Email account settings are unavailable");
      }
      assertCurrent(options);
      const result = await testEmailConnection(account);
      assertCurrent(options);
      options.respond(true, result);
    },
    { scope: "operator.admin", profileAccess: "required" },
  );
}
