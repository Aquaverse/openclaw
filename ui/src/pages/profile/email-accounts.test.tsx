/* @vitest-environment jsdom */
import { expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import { currentConfigObject } from "../../lib/config/config-state-model.ts";
import { gatewayHelloForMethods } from "../../test-helpers/gateway-methods.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import { createSolidApplicationContextProvider } from "../../test-helpers/solid-application-context.tsx";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { EmailAccounts } from "./email-accounts.tsx";
import { createConnectedContext } from "./profile-page.test-support.tsx";

function setInput(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

it("tests both mail protocols before storing the password and account config", async () => {
  const request = vi.fn(async (method: string) => {
    if (method === "email.testConnection") {
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
  const view = mountSolid(() => <EmailAccounts />, { wrapper: provider.wrapper });
  try {
    const add = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Add email",
    );
    expect(add).toBeDefined();
    add!.click();
    await waitForSolid(() =>
      expect(view.container.querySelectorAll<HTMLInputElement>("input")).toHaveLength(8),
    );
    const fields = view.container.querySelectorAll<HTMLInputElement>("input");
    setInput(fields[0]!, "person@example.com");
    await waitForSolid(() => expect(fields[0]?.value).toBe("person@example.com"));
    setInput(fields[1]!, "fixture-password");
    await waitForSolid(() => expect(fields[1]?.value).toBe("fixture-password"));
    const test = [...view.container.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Test connection",
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
      smtp: { host: "mail.example.com", port: 587, security: "starttls" },
      password: expect.objectContaining({ source: "store", provider: "default" }),
    });
    expect(request.mock.calls.map(([method]) => method)).toEqual([
      "email.testConnection",
      "secrets.store.set",
    ]);
  } finally {
    view.unmount();
  }
});
