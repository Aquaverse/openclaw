/* @vitest-environment jsdom */
import { expect, it, onTestFinished, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { i18n } from "../../i18n/index.ts";
import { registerProfileEnglish } from "../../i18n/locales/en-profile.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EmailAccounts } from "./email-accounts.tsx";
import { createConnectedContext } from "./profile-page.test-support.tsx";

registerProfileEnglish();

function setInput(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

it("tests both mail protocols before storing the password and account config", async () => {
  let testAttempts = 0;
  const request = vi.fn(async (method: string) => {
    if (method === "email.testConnection") {
      testAttempts += 1;
      if (testAttempts === 1) {
        throw new Error(
          "IMAP connection to mail.example.com:993 failed: [AUTHENTICATIONFAILED] Invalid username or password",
        );
      }
      return { imap: "ok", smtp: "ok" };
    }
    if (method === "secrets.store.set" || method === "secrets.store.delete") {
      return { ok: true };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const harness = createConnectedContext(request as GatewayBrowserClient["request"]);
  harness.emitHello(
    gatewayHelloForMethods(
      ["config.get", "config.patch", "email.testConnection", "secrets.store.set"],
      ["operator.admin"],
    ),
  );
  let built: unknown;
  const patchFromSnapshot = vi.fn(async (build) => {
    built = build({ plugins: { entries: { imap: { config: { accounts: {} } } } } });
    return true;
  });
  Object.assign(harness.context.runtimeConfig, {
    canPatch: true,
    state: {
      configForm: null,
      configSnapshot: { sourceConfig: { plugins: { entries: {} } } },
    },
    patchFromSnapshot,
  });
  expect(currentConfigObject(harness.context.runtimeConfig.state as never)).not.toBeNull();
  const provider = createSolidApplicationContextProvider(harness.context);
  const view = mountSolid(() => <EmailAccounts saveSentCopyLabel="Save to Sent folder" />, {
    wrapper: provider.wrapper,
  });
  try {
    const add = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add email",
    );
    expect(add).toBeDefined();
    add!.click();
    await waitForSolid(() =>
      expect(view.container.querySelector<HTMLInputElement>('input[type="email"]')).not.toBeNull(),
    );
    const saveToSent = view.container.querySelector<HTMLInputElement>('[role="switch"]');
    expect(saveToSent?.checked).toBe(true);
    expect(saveToSent?.getAttribute("aria-label")).toBe("Save to Sent folder");
    const email = view.container.querySelector<HTMLInputElement>('input[type="email"]')!;
    const password = view.container.querySelector<HTMLInputElement>('input[type="password"]')!;
    setInput(email, "person@example.com");
    await waitForSolid(() => expect(email.value).toBe("person@example.com"));
    setInput(password, "fixture-password");
    await waitForSolid(() => expect(password.value).toBe("fixture-password"));
    const reveal = view.container.querySelector<HTMLButtonElement>(".oc-sensitive-toggle")!;
    expect(reveal.getAttribute("aria-pressed")).toBe("false");
    reveal.click();
    await waitForSolid(() =>
      expect(
        view.container.querySelector<HTMLInputElement>("#email-account-password"),
      ).toMatchObject({ type: "text", value: "fixture-password" }),
    );
    const test = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Test connection",
    );
    test!.click();
    await waitForSolid(() =>
      expect(view.container.textContent).toContain(
        "IMAP connection to mail.example.com:993 failed: [AUTHENTICATIONFAILED] Invalid username or password",
      ),
    );
    test!.click();
    await waitForSolid(() => expect(view.container.textContent).toContain("connections succeeded"));
    const save = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Save",
    );
    expect(save).toMatchObject({ disabled: false });
    save!.click();
    await waitForSolid(() => expect(patchFromSnapshot).toHaveBeenCalledOnce());
    const raw = (built as { options: { raw: Record<string, unknown> } }).options.raw as {
      plugins: {
        entries: { imap: { enabled: boolean; config: { accounts: Record<string, unknown> } } };
      };
    };
    const entries = Object.entries(raw.plugins.entries.imap.config.accounts);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.[0]).toMatch(/^mail_/u);
    expect(entries[0]?.[1]).toMatchObject({
      email: "person@example.com",
      host: "mail.example.com",
      user: "person",
      saveSentCopy: true,
      smtp: { host: "mail.example.com", port: 587, security: "starttls" },
      password: expect.objectContaining({ source: "store", provider: "default" }),
    });
    expect(request).toHaveBeenCalledWith(
      "secrets.store.set",
      expect.objectContaining({
        name: expect.stringMatching(/^OPENCLAW_EMAIL_[A-F0-9]{32}$/u),
        value: "fixture-password",
      }),
    );
    const savedAccount = entries[0]![1] as { password: { id: string } };
    expect(savedAccount.password.id).toMatch(/^OPENCLAW_EMAIL_[A-F0-9]{32}$/u);
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "email.testConnection",
      "email.testConnection",
      "secrets.store.set",
    ]);
  } finally {
    view.unmount();
  }
});

it("loads the Simplified Chinese email account copy", async () => {
  onTestFinished(() => i18n.setLocale("en"));
  await i18n.setLocale("zh-CN");

  expect(i18n.t("profilePage.email.title")).toBe("邮箱账户");
  expect(i18n.t("profilePage.email.testPassed")).toBe("IMAP 和 SMTP 连接成功。");
  expect(i18n.t("profilePage.email.saveFailed")).toBe("无法保存邮箱账户。");
  expect(i18n.t("profilePage.email.saveSentCopy")).toBe("在已发送中保存副本");
});
