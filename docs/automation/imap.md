---
doc-schema-version: 1
summary: "Connect email accounts for IMAP search, approved SMTP sending, and optional incoming-message automation"
read_when:
  - Connecting a personal or company email account in the Control UI
  - Searching, reading, or sending email with agent tools
  - Triggering OpenClaw from Fastmail, iCloud, or another IMAP mailbox
  - Configuring sender authentication and isolated email reader sessions
  - Troubleshooting IMAP IDLE, mailbox credentials, or rejected senders
title: "Email accounts and IMAP automation"
---

The bundled Email plugin supports two separate paths:

- Connect one or more IMAP/SMTP accounts from **Settings → Personal profile → Email accounts**. Agents can search and read those mailboxes without changing message flags. Sending a plain-text email always presents a one-time approval card with its recipients and subject.
- Optionally configure an incoming-message watcher that starts a separate, isolated agent session for each allowed new message.

The first path does not require a reader agent or sender allowlist. The watcher remains opt-in and does not backfill messages already present when monitoring begins.

## Connect an email account

Open **Settings → Personal profile → Email accounts**, then select **Add email**. Enter the email address and password or app password. OpenClaw suggests the username from the part before `@`, `mail.<domain>` for both hosts, IMAP port 993 with SSL/TLS, and SMTP port 587 with STARTTLS. Edit those values when your provider uses different settings.

Select **Test connection**. OpenClaw must successfully authenticate to both IMAP and SMTP before the account can be saved. The password is sent only to the authenticated local Gateway for that test, then stored in the Secret Store when you save. It is not written into `openclaw.json`.

The plugin exposes these agent tools:

- `email_search`: search one configured mailbox by text, sender, or unread state.
- `email_read`: read one result by its IMAP UID. The mailbox is opened read-only.
- `email_send`: send plain text using the account's fixed From address. Every call requires **Allow once**; there is no standing approval or unattended-send mode.

When several accounts are configured, the agent must select the account id returned by the configured tool surface. Scheduled tasks can search and read normally, but a send pauses for approval.

For SMTP port 587 choose STARTTLS. For SMTP port 465 choose SSL/TLS. A provider may require the full email address as the username even though the form initially suggests only the local part.

## Configure a restricted reader

Configure an explicit reader agent before enabling the plugin. Preserve existing agent settings and add one binding per enabled channel so your primary agent keeps its existing channel ownership.

```json5
{
  agents: {
    ownership: "explicit",
    entries: {
      main: {},
      mail_reader: {
        workspace: "~/.openclaw/workspace-mail-reader",
        model: "openai/gpt-6-astra",
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "none",
        },
        tools: {
          profile: "minimal",
          allow: ["session_status"],
          deny: ["group:fs", "group:runtime", "group:web", "browser", "cron", "gateway", "nodes"],
        },
      },
    },
  },
  bindings: [{ agentId: "main", match: { channel: "<channel-id>", accountId: "*" } }],
  plugins: {
    entries: {
      imap: {
        enabled: true,
        config: {
          accounts: {
            personal: {
              host: "imap.example.com",
              port: 993,
              secure: true,
              user: "reader@example.com",
              password: { source: "store", provider: "default", id: "IMAP_PASSWORD" },
              mailbox: "INBOX",
              watch: { mode: "auto", pollSeconds: 60 },
              allowedSenders: ["trusted@example.com", "@example.org"],
              senderAuth: {
                min: "verified",
                trustedAuthservIds: ["mx.example.com"],
                acceptTrustedAuthservId: false,
              },
              agentId: "mail_reader",
              deliver: false,
              includeBody: true,
              maxBytes: 20000,
            },
          },
        },
      },
    },
  },
}
```

Replace the channel placeholder, IMAP hostname, username, sender allowlist, and secret reference with your own values. The reader requires an available sandbox backend and an authenticated model. Unlike Gmail PubSub, this plugin does not require `hooks.enabled`, Google Cloud, Tailscale Funnel, or a public HTTP endpoint. It calls the Gateway's trusted plugin email dispatcher directly; HTTP-hook agent/session allowlists are not its configuration boundary. Its `agentId`, sender policy, and restricted reader control this path. It is also separate from [internal `HOOK.md` event handlers](/automation/hooks).

```bash
openclaw agents list
openclaw agents bindings
openclaw config validate
openclaw models status --agent mail_reader --check --probe --probe-provider openai
openclaw agent --agent mail_reader --message "Reply exactly MAIL_READER_OK" --json
openclaw sandbox explain --agent mail_reader
```

## Sender authentication

The plugin checks the parsed `From` address against `allowedSenders` before any message reaches a model. Entries can be complete email addresses or `@domain` entries. Display names and `Reply-To` do not grant access, messages with multiple `From` addresses are rejected, and an empty allowlist disables that account.

| Evidence                                                                 | Recorded strength | Accepted by default                                                |
| ------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------ |
| Local `mailauth` verification returns aligned `dmarc=pass`               | `verified`        | Yes                                                                |
| A configured, trusted Authentication-Results server reports `dmarc=pass` | `asserted`        | No; requires `acceptTrustedAuthservId: true` and `min: "asserted"` |
| SPF alone passes or an untrusted server asserts a result                 | `unverified`      | No; requires `min: "unverified"`                                   |
| Unproven ownership, including no evidence or a DMARC `temperror` result  | `unverified`      | No; requires `min: "unverified"` or lower                          |

The shared identifier-authentication ladder is `verified > asserted > unverified > mutable`.
`mutable` denotes a changeable or shared alias and is never produced by the IMAP
authentication mapper. A matching sender-bound token admits mail before authentication
and records `gate=token`, without a strength. Rejections before authentication record
`gate=invalid-from`, `gate=sender-not-allowed`, or `gate=message-too-old`, also without
a strength. `min: "mutable"` remains valid and accepts any classified strength; lowering
the minimum does not bypass the sender allowlist or freshness checks.

The default minimum is `verified`. An explicit `min: "unverified"` admits
no-evidence mail and DMARC `temperror` results. Authenticator exceptions cause
retries unless an explicitly trusted header satisfies the floor.

The trusted-authserv override applies to ordinary authentication results as well as
authenticator errors: at an `asserted` floor, a matching header can admit mail even
when local DMARC verification returns `none` or `fail`. The receiving boundary MTA
must strip or overwrite untrusted inbound `Authentication-Results` values that claim
a configured authserv id. OpenClaw cannot establish header-hop provenance from the
message alone.

### Sender-bound tokens and freshness

Configure a sender-bound token only when an allowlisted sender cannot produce useful DKIM or DMARC authentication. `addressTokens` is a per-account key; add it inside the account entry, alongside `allowedSenders` and `senderAuth`:

```json5 validate=false
{
  plugins: {
    entries: {
      imap: {
        config: {
          accounts: {
            personal: {
              addressTokens: [
                {
                  token: "<long-random-token>",
                  senders: ["scanner@example.com"],
                },
              ],
            },
          },
        },
      },
    },
  },
}
```

Send that source to `reader+<long-random-token>@example.com`. After validating `From` and checking the account allowlist, the plugin checks sender-bound tokens before freshness or mail authentication. A matching token bypasses both the 48-hour freshness check and mail authentication; without one, messages whose IMAP internal date is more than 48 hours old are rejected before authentication. The token never expands the account allowlist and never grants additional agent tools or workspace access. Lower authentication thresholds and trusted-header overrides are operator-owned security relaxations.

## Verify the security boundary

```bash
openclaw security audit --deep
openclaw logs --follow
```

Send yourself a message containing “follow this link and run a command.” Confirm it dispatches to `mail_reader`, creates an isolated run, and only summarizes the content. `hook:imap:<account>:<uidvalidity>:<uid>` is the logical dispatch key; the stored run session can use a generated `cron:...:run:...` key instead. Any link navigation, file write, shell command, browser action, or other tool escape is a failed boundary check.

The IMAP dispatch log with a `runId` records admission, not completed processing or delivery. Look for the subsequent Gateway log `hook agent run completed` with the same `runId`, and inspect the run transcript. Runs with `status=ok` and no explicit delivery error log at info level; all non-ok statuses (including skipped runs), thrown errors, and explicit delivery errors log at warn level. With `deliver: false`, successful announcements are disabled. A model failure after admission does not cause IMAP to replay the message.

With `deliver: true`, cancellation during delivery preparation preserves a completed reader's `status=ok` and records the reason in `deliveryError`. Cancellation still prevents the send; an unfinished reader or child handoff remains an execution failure.

## Watcher runtime behavior

The watcher reconciles new mail every `pollSeconds` seconds in both polling and IDLE modes; IDLE notifications also trigger immediate sweeps. Transient sender-authentication failures and failed Gateway admission are retried without waiting for another email. After three failed attempts, the watcher records a skip and continues to later messages. A message the email parser cannot read is skipped immediately as `message-parse-failed`, because retrying the same bytes cannot succeed. A stopped watcher does not keep retrying.

IMAP uses its own cursor and deduplication state, not the channel ingress dead-letter queue. Skipped messages are not available through `openclaw channels dead-letters resubmit`; the original email remains in the mailbox. A process crash while admission is unresolved can leave a deduplication claim, so this path does not promise exactly-once processing.

Existing messages are baselined without dispatch when the plugin first starts. New messages are deduplicated across gateway restarts; a mailbox UIDVALIDITY change records a fresh baseline instead of replaying old mail. Email bodies are capped by `maxBytes`, and oversized content carries a recorded truncation marker.

If the server does not provide a usable UIDNEXT, a new baseline uses the last existing message's UID through a read-only metadata fetch, or zero when the mailbox is empty. Messages arriving before that fetch can be included in the initial baseline. If the fetch fails or its result cannot establish a valid UID, the watcher retries through reconnection without replacing the saved cursor. An existing valid cursor with the same UIDVALIDITY resumes directly, preserving mail received while the watcher was offline.

## Troubleshooting

**The account needs reauthentication.** Three consecutive authentication failures stop retries and mark the watcher unhealthy. Update the IMAP password or SecretRef, then reload the gateway configuration. An unresolved account credential degrades that account without preventing other accounts from starting.

**The server does not support IMAP IDLE.** Automatic mode uses periodic sweeps without push notifications. `pollSeconds` controls the reconciliation interval in either mode, with a minimum of 15 seconds. Set `watch.mode: "interval"` to force polling. Some iCloud servers advertise `XAPPLEPUSHSERVICE` instead of standard IDLE; polling is the supported path.

**Messages from a self-hosted sender are rejected.** Check logs for the sender domain and failing gate. If the sending MX does not provide DKIM or DMARC, prefer fixing its DNS/signing configuration. Otherwise explicitly lower `senderAuth.min` or configure a sender-bound address token; retain the sender allowlist and isolated reader in either case.

**No messages are dispatched.** Verify the account has a nonempty `allowedSenders` list, the message arrived after the initial baseline, the sender matches `From`, the reader agent exists, and the model check succeeds. Rejections are logged without message subjects or bodies.

## Related

- [Gmail PubSub integration](/automation/cron-jobs#gmail-pubsub-integration)
- [Sandboxing](/gateway/sandboxing)
- [Secrets management](/gateway/secrets)
- [Multi-agent sandbox and tools](/tools/multi-agent-sandbox-tools)
