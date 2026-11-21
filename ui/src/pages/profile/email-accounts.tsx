import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { createMemo, createSignal, For, onCleanup, onSettled, Show } from "solid-js";
import { hasOperatorAdminAccess } from "../../app/operator-access.ts";
import { InlineAlert } from "../../components/solid/inline-alert.tsx";
import {
  SettingsRow,
  SettingsSection,
  SettingsStatus,
  SettingsValue,
} from "../../components/solid/settings-ui.tsx";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { t } from "../../lib/reactive/i18n.ts";

type Draft = {
  id?: string;
  email: string;
  password: string;
  user: string;
  from: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  smtpSecurity: "starttls" | "tls";
};

const emptyDraft = (): Draft => ({
  email: "",
  password: "",
  user: "",
  from: "",
  imapHost: "",
  imapPort: "993",
  smtpHost: "",
  smtpPort: "587",
  smtpSecurity: "starttls",
});

function configuredAccounts(config: Record<string, unknown> | null) {
  const plugins = asOptionalRecord(config?.plugins);
  const entries = asOptionalRecord(plugins?.entries);
  const imap = asOptionalRecord(entries?.imap);
  const pluginConfig = asOptionalRecord(imap?.config);
  return asOptionalRecord(pluginConfig?.accounts) ?? {};
}

function passwordSecretName(value: unknown): string | undefined {
  const ref = asOptionalRecord(asOptionalRecord(value)?.password);
  return ref?.source === "store" && typeof ref.id === "string" ? ref.id : undefined;
}

function draftAccount(draft: Draft, password: unknown) {
  const imapPort = Number(draft.imapPort);
  const smtpPort = Number(draft.smtpPort);
  if (!draft.email.includes("@") || !draft.from.includes("@")) {
    throw new Error(t("profilePage.email.invalidEmail"));
  }
  if (!draft.user.trim() || !draft.imapHost.trim() || !draft.smtpHost.trim()) {
    throw new Error(t("profilePage.email.missingFields"));
  }
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
    throw new Error(t("profilePage.email.invalidPort"));
  }
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    throw new Error(t("profilePage.email.invalidPort"));
  }
  return {
    email: draft.email.trim(),
    from: draft.from.trim(),
    host: draft.imapHost.trim(),
    port: imapPort,
    secure: true,
    user: draft.user.trim(),
    password,
    mailbox: "INBOX",
    smtp: {
      host: draft.smtpHost.trim(),
      port: smtpPort,
      security: draft.smtpSecurity,
    },
  };
}

function draftFromAccount(id: string, value: unknown): Draft {
  const account = asOptionalRecord(value);
  const smtp = asOptionalRecord(account?.smtp);
  return {
    id,
    email: typeof account?.email === "string" ? account.email : "",
    password: "",
    user: typeof account?.user === "string" ? account.user : "",
    from: typeof account?.from === "string" ? account.from : "",
    imapHost: typeof account?.host === "string" ? account.host : "",
    imapPort: typeof account?.port === "number" ? String(account.port) : "993",
    smtpHost: typeof smtp?.host === "string" ? smtp.host : "",
    smtpPort: typeof smtp?.port === "number" ? String(smtp.port) : "587",
    smtpSecurity: smtp?.security === "tls" ? "tls" : "starttls",
  };
}

export function EmailAccounts() {
  const context = useApplication();
  const [revision, setRevision] = createSignal(0, { ownedWrite: true });
  const [draft, setDraft] = createSignal<Draft | null>(null, { ownedWrite: true });
  const [busy, setBusy] = createSignal<"test" | "save" | "delete" | null>(null, {
    ownedWrite: true,
  });
  const [error, setError] = createSignal<string | null>(null, { ownedWrite: true });
  const [tested, setTested] = createSignal<string | null>(null, { ownedWrite: true });
  const stop = context.runtimeConfig.subscribe(() => setRevision((value) => value + 1));
  onCleanup(stop);
  onSettled(() => void context.runtimeConfig.ensureLoaded());

  const config = () => {
    revision();
    return currentConfigObject(context.runtimeConfig.state);
  };
  const accounts = createMemo(() => Object.entries(configuredAccounts(config())));
  const canConfigure = createMemo(
    () =>
      context.runtimeConfig.canPatch === true &&
      hasOperatorAdminAccess(context.gateway.snapshot.hello?.auth ?? null),
  );
  const fingerprint = (value: Draft) =>
    JSON.stringify({ ...value, password: value.password.length });
  const update = (patch: Partial<Draft>) => {
    const current = draft();
    if (!current) {
      return;
    }
    const next = { ...current, ...patch };
    if (patch.email !== undefined && !current.id) {
      const [local, domain] = patch.email.split("@");
      next.user = local ?? "";
      next.from = patch.email;
      next.imapHost = domain ? `mail.${domain}` : "";
      next.smtpHost = domain ? `mail.${domain}` : "";
    }
    setDraft(next);
    setTested(null);
    setError(null);
  };

  async function test() {
    const current = draft();
    const client = context.gateway.snapshot.client;
    if (!current || !client || !current.password) {
      setError(t("profilePage.email.passwordRequired"));
      return;
    }
    try {
      setBusy("test");
      setError(null);
      await client.request("email.testConnection", {
        account: draftAccount(current, current.password),
      });
      setTested(fingerprint(current));
    } catch (cause) {
      setTested(null);
      setError(formatUiError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function save() {
    const current = draft();
    const client = context.gateway.snapshot.client;
    if (!current || !client || tested() !== fingerprint(current)) {
      setError(t("profilePage.email.testFirst"));
      return;
    }
    const old = current.id ? configuredAccounts(config())[current.id] : undefined;
    const oldSecret = passwordSecretName(old);
    const secretName = `OPENCLAW_EMAIL_${crypto.randomUUID().replaceAll("-", "").toUpperCase()}`;
    let staged = false;
    try {
      setBusy("save");
      setError(null);
      await client.request("secrets.store.set", {
        name: secretName,
        value: current.password,
        kind: "secret",
        allowedHosts: [],
      });
      staged = true;
      const id = current.id ?? `mail_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
      const currentAccounts = configuredAccounts(config());
      const saved = await context.runtimeConfig.patchFromSnapshot(() => ({
        options: {
          note: current.id ? "Update email account" : "Add email account",
          raw: {
            plugins: {
              entries: {
                imap: {
                  enabled: true,
                  config: {
                    accounts: {
                      ...currentAccounts,
                      [id]: draftAccount(current, {
                        source: "store",
                        provider: "default",
                        id: secretName,
                      }),
                    },
                  },
                },
              },
            },
          },
        },
      }));
      if (!saved) {
        throw new Error(t("profilePage.email.saveFailed"));
      }
      staged = false;
      if (oldSecret && oldSecret !== secretName) {
        await client.request("secrets.store.delete", { name: oldSecret }).catch(() => undefined);
      }
      setDraft(null);
      setTested(null);
    } catch (cause) {
      setError(formatUiError(cause));
    } finally {
      if (staged) {
        await client.request("secrets.store.delete", { name: secretName }).catch(() => undefined);
      }
      setBusy(null);
    }
  }

  async function remove(id: string, value: unknown) {
    const client = context.gateway.snapshot.client;
    if (!client) {
      return;
    }
    try {
      setBusy("delete");
      setError(null);
      const saved = await context.runtimeConfig.patchFromSnapshot(() => ({
        options: {
          note: "Remove email account",
          raw: { plugins: { entries: { imap: { config: { accounts: { [id]: null } } } } } },
        },
      }));
      if (!saved) {
        throw new Error(t("profilePage.email.deleteFailed"));
      }
      const secret = passwordSecretName(value);
      if (secret) {
        await client.request("secrets.store.delete", { name: secret }).catch(() => undefined);
      }
    } catch (cause) {
      setError(formatUiError(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div data-component="email-accounts">
      <SettingsSection
        title={t("profilePage.email.title")}
        description={t("profilePage.email.description")}
        actions={
          <Show when={!draft()}>
            <button class="btn btn--sm" onClick={() => setDraft(emptyDraft())}>
              {t("profilePage.email.add")}
            </button>
          </Show>
        }
      >
        <Show when={error()}>
          <InlineAlert tone="danger" role="alert">
            {error()}
          </InlineAlert>
        </Show>
        <Show when={!draft() && accounts().length === 0}>
          <SettingsRow title={t("profilePage.email.empty")} />
        </Show>
        <Show when={!draft() && canConfigure()}>
          <For each={accounts()}>
            {([id, value]) => {
              const account = asOptionalRecord(value);
              return (
                <SettingsRow
                  title={typeof account?.email === "string" ? account.email : id}
                  description={typeof account?.host === "string" ? account.host : undefined}
                  control={
                    <span class="settings-row__actions">
                      <SettingsStatus kind="ok" label={t("profilePage.email.connected")} />
                      <button
                        class="btn btn--sm"
                        disabled={busy() !== null || !canConfigure()}
                        onClick={() => setDraft(draftFromAccount(id, value))}
                      >
                        {t("profilePage.email.edit")}
                      </button>
                      <button
                        class="btn btn--sm btn--danger"
                        disabled={busy() !== null || !canConfigure()}
                        onClick={() => void remove(id, value)}
                      >
                        {t("common.delete")}
                      </button>
                    </span>
                  }
                />
              );
            }}
          </For>
        </Show>
        <Show when={draft()}>
          {(current) => (
            <div class="email-account-form">
              <label>
                {t("profilePage.email.address")}
                <input
                  class="settings-input"
                  type="email"
                  value={current().email}
                  onInput={(event) => update({ email: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.password")}
                <input
                  class="settings-input"
                  type="password"
                  value={current().password}
                  onInput={(event) => update({ password: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.username")}
                <input
                  class="settings-input"
                  value={current().user}
                  onInput={(event) => update({ user: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.from")}
                <input
                  class="settings-input"
                  type="email"
                  value={current().from}
                  onInput={(event) => update({ from: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.imapHost")}
                <input
                  class="settings-input"
                  value={current().imapHost}
                  onInput={(event) => update({ imapHost: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.imapPort")}
                <input
                  class="settings-input"
                  inputmode="numeric"
                  value={current().imapPort}
                  onInput={(event) => update({ imapPort: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.smtpHost")}
                <input
                  class="settings-input"
                  value={current().smtpHost}
                  onInput={(event) => update({ smtpHost: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.smtpPort")}
                <input
                  class="settings-input"
                  inputmode="numeric"
                  value={current().smtpPort}
                  onInput={(event) => update({ smtpPort: event.currentTarget.value })}
                />
              </label>
              <label>
                {t("profilePage.email.smtpSecurity")}
                <select
                  class="settings-input"
                  value={current().smtpSecurity}
                  onChange={(event) =>
                    update({ smtpSecurity: event.currentTarget.value as Draft["smtpSecurity"] })
                  }
                >
                  <option value="starttls">STARTTLS</option>
                  <option value="tls">SSL/TLS</option>
                </select>
              </label>
              <SettingsValue
                value={
                  tested() === fingerprint(current())
                    ? t("profilePage.email.testPassed")
                    : t("profilePage.email.testRequired")
                }
              />
              <div class="email-account-form__actions">
                <button
                  class="btn btn--sm"
                  disabled={busy() !== null}
                  onClick={() => {
                    setDraft(null);
                    setError(null);
                  }}
                >
                  {t("common.cancel")}
                </button>
                <button class="btn btn--sm" disabled={busy() !== null} onClick={() => void test()}>
                  {busy() === "test" ? t("profilePage.email.testing") : t("profilePage.email.test")}
                </button>
                <button
                  class="btn btn--sm primary"
                  disabled={busy() !== null || tested() !== fingerprint(current())}
                  onClick={() => void save()}
                >
                  {busy() === "save" ? t("profilePage.email.saving") : t("common.save")}
                </button>
              </div>
            </div>
          )}
        </Show>
      </SettingsSection>
    </div>
  );
}
