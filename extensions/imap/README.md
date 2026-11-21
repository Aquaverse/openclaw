# Email (IMAP/SMTP)

Let new email trigger a restricted OpenClaw reader agent. The plugin watches an
existing IMAP mailbox, checks allowed senders and sender authentication, and
starts an isolated session for each accepted message. It can also list folders,
search and read mail on demand, save plain-text drafts over IMAP, and send
approved plain-text messages over SMTP. It does not process the mailbox's
existing messages on first startup.

The `email_accounts` tool lists or searches configured accounts by account id,
email address, login username, or email prefix without returning passwords. The
mailbox, search, read, draft, and send tools automatically use the account when exactly one is
configured. With multiple accounts, they accept an exact account id, full email
address, login username, or email prefix; ambiguous matches return the candidate
account ids and addresses so the user can choose.

The `email_mailboxes` tool lists exact folder paths and their standard roles.
`email_search` performs server-side IMAP search in the Inbox by default, or in
another listed folder, and supports free text, sender, recipient, subject,
unread, starred, and date filters. `email_read` accepts the same folder path
because IMAP UIDs are scoped to a mailbox.

`email_draft` appends an RFC 822 message to the mailbox that advertises the
standard `\\Drafts` role and marks it `\\Draft`. It never opens an SMTP
connection and does not send the message. Recipients and subject are optional,
so an unfinished composition can be saved and completed later in the user's
mail client. The provider must advertise or allow ImapFlow to identify a Drafts
mailbox.

Sent messages are archived in the account's IMAP mailbox by default. The
plugin discovers the mailbox that advertises the standard `\\Sent` special-use
flag, or uses the configured Sent mailbox override. If SMTP succeeds but the
IMAP append fails, the send result reports that partial success and does not
retry the SMTP delivery.

## Get started

Prepare a restricted reader agent with an authenticated model and working
sandbox. Configure the mailbox credentials, sender allowlist, authentication
policy, and reader agent under the plugin's account settings, then enable IMAP.

Passwords must resolve to strings. Malformed credentials are rejected; an unresolved
secret reference leaves only its account unavailable while other accounts can start.

Follow the [IMAP setup guide](https://docs.openclaw.ai/automation/imap) for the
reader configuration, credential storage, and verification steps.
