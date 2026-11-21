import type { IdentifierAuthentication } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { asOptionalRecord, filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";

const SENDER_STRENGTHS = [
  "mutable",
  "unverified",
  "asserted",
  "verified",
] as const satisfies readonly IdentifierAuthentication[];
type HookDispatch = OpenClawPluginApi["runtime"]["hooks"]["dispatchHookAgentTurn"];

export type ImapAccountConfig = {
  email: string;
  from: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox: string;
  watch: { mode: "auto" | "idle" | "interval"; pollSeconds: number };
  allowedSenders: string[];
  senderAuth: {
    min: IdentifierAuthentication;
    trustedAuthservIds: string[];
    acceptTrustedAuthservId: boolean;
  };
  addressTokens: Array<{ token: string; senders: string[] }>;
  smtp?: {
    host: string;
    port: number;
    security: "starttls" | "tls";
  };
  agentId?: string;
  deliver: boolean;
  includeBody: boolean;
  maxBytes: number;
  model?: string;
  thinking?: Parameters<HookDispatch>[0]["thinking"];
  timeoutSeconds?: number;
};

export type ImapPluginConfig = { accounts: Record<string, ImapAccountConfig> };

export function resolveImapConfig(
  value: unknown,
  onUnavailableAccount?: (accountId: string) => void,
): ImapPluginConfig {
  const configured = asOptionalRecord(asOptionalRecord(value)?.accounts);
  const accounts: Record<string, ImapAccountConfig> = {};
  for (const [accountId, input] of Object.entries(configured ?? {})) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/u.test(accountId)) {
      throw new Error(`IMAP account id ${JSON.stringify(accountId)} is not session-safe`);
    }
    const account = asOptionalRecord(input);
    if (!account) {
      throw new Error(`IMAP account ${accountId} must be an object`);
    }
    const { host, user, password } = account;
    if (typeof host !== "string" || typeof user !== "string") {
      throw new Error(`IMAP account ${accountId} requires host, user, and resolved password`);
    }
    if (typeof password !== "string") {
      if (asOptionalRecord(password)) {
        onUnavailableAccount?.(accountId);
        continue;
      }
      throw new Error(`IMAP account ${accountId} requires a resolved password`);
    }
    const watch = asOptionalRecord(account.watch);
    const senderAuth = asOptionalRecord(account.senderAuth);
    const smtp = asOptionalRecord(account.smtp);
    const mode = watch?.mode;
    const min = senderAuth?.min;
    const thinking = [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "adaptive",
      "max",
      "ultra",
    ].find(
      (level): level is NonNullable<ImapAccountConfig["thinking"]> => level === account.thinking,
    );
    accounts[accountId] = {
      email:
        typeof account.email === "string"
          ? account.email
          : typeof account.from === "string"
            ? account.from
            : user,
      from:
        typeof account.from === "string"
          ? account.from
          : typeof account.email === "string"
            ? account.email
            : user,
      host,
      user,
      password,
      port: typeof account.port === "number" ? account.port : 993,
      secure: account.secure !== false,
      mailbox: typeof account.mailbox === "string" ? account.mailbox : "INBOX",
      watch: {
        mode: mode === "idle" || mode === "interval" ? mode : "auto",
        pollSeconds: Math.max(15, typeof watch?.pollSeconds === "number" ? watch.pollSeconds : 60),
      },
      allowedSenders: filterStringEntries(account.allowedSenders),
      senderAuth: {
        // The predicate requires every SDK strength to remain in the local config values.
        min:
          SENDER_STRENGTHS.find(
            (strength): strength is IdentifierAuthentication => strength === min,
          ) ?? "verified",
        trustedAuthservIds: filterStringEntries(senderAuth?.trustedAuthservIds),
        acceptTrustedAuthservId: senderAuth?.acceptTrustedAuthservId === true,
      },
      addressTokens: Array.isArray(account.addressTokens)
        ? account.addressTokens.flatMap((entry) => {
            const tokenEntry = asOptionalRecord(entry);
            return typeof tokenEntry?.token === "string"
              ? [{ token: tokenEntry.token, senders: filterStringEntries(tokenEntry.senders) }]
              : [];
          })
        : [],
      ...(smtp && typeof smtp.host === "string"
        ? {
            smtp: {
              host: smtp.host,
              port: typeof smtp.port === "number" ? smtp.port : 587,
              security: smtp.security === "tls" ? "tls" : "starttls",
            },
          }
        : {}),
      ...(typeof account.agentId === "string" ? { agentId: account.agentId } : {}),
      deliver: account.deliver === true,
      includeBody: account.includeBody !== false,
      maxBytes: typeof account.maxBytes === "number" ? account.maxBytes : 20_000,
      ...(typeof account.model === "string" ? { model: account.model } : {}),
      ...(thinking ? { thinking } : {}),
      ...(typeof account.timeoutSeconds === "number"
        ? { timeoutSeconds: account.timeoutSeconds }
        : {}),
    };
  }
  return { accounts };
}
