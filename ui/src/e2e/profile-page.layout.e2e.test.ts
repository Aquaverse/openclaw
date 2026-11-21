import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "playwright/test";
import { it } from "vitest";
import {
  takeControlUiScreenshotFrame,
  takeControlUiViewportScreenshot,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Profile account status layout" });
const profile = {
  id: "11111111-1111-4111-8111-111111111111",
  displayName: "Profile reader",
  avatarMime: null,
  mergedInto: null,
  createdAt: 1,
  updatedAt: 2,
  emails: ["reader@example.test"],
  githubIdentity: null,
  hasAvatar: false,
};

suite.define(() => {
  it("shows Sent-copy controls when adding an email account", async () => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1440, height: 1000 } },
      async ({ page }) => {
        const config = {
          plugins: { entries: { imap: { enabled: true, config: { accounts: {} } } } },
        };
        await installMockGateway(page, {
          presenceUsers: [{ self: true, id: profile.id, name: profile.displayName }],
          methodResponses: {
            "users.self": { profile },
            "config.get": {
              raw: JSON.stringify(config),
              hash: "email-settings-fixture",
              appliedConfigHash: "email-settings-fixture",
              config,
              resolved: config,
              sourceConfig: config,
            },
          },
        });
        await page.goto(new URL("/settings/profile", suite.server.baseUrl).href);
        const surface = page.locator('[data-component="email-accounts"]');
        const add = surface.getByRole("button", { name: "Add email" });
        await expect(add).toBeVisible();

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const before = await takeControlUiScreenshotFrame(page, surface, [add], {
            animations: "disabled",
            fullPage: true,
          });
          await writeFile(path.join(suite.artifactDir, "email-sent-copy-before.png"), before.png);
        }

        await add.click();
        const saveSentCopy = surface.getByRole("switch", { name: "Save a copy in Sent" });
        const sentMailbox = surface.getByRole("textbox", { name: "Sent mailbox override" });
        await expect(saveSentCopy).toBeChecked();
        await expect(sentMailbox).toHaveAttribute(
          "placeholder",
          "Auto-detect standard Sent mailbox",
        );

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          await sentMailbox.scrollIntoViewIfNeeded();
          const after = await takeControlUiViewportScreenshot(page, surface, [
            saveSentCopy,
            sentMailbox,
          ]);
          await writeFile(path.join(suite.artifactDir, "email-sent-copy-after.png"), after);
        }
      },
    );
  });

  it.each([
    { name: "unavailable", accounts: [] },
    {
      name: "linked",
      accounts: [{ accountId: "default", available: true, senderIds: ["123456789012345678"] }],
    },
  ])("keeps mobile account geometry when Discord becomes $name", async ({ accounts }) => {
    await suite.withPage(
      { locale: "en-US", viewport: { width: 390, height: 844 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          presenceUsers: [{ self: true, id: profile.id, name: profile.displayName }],
          heldMethods: ["users.channelIdentity"],
          methodResponses: { "users.self": { profile } },
        });
        await page.goto(new URL("/settings/profile", suite.server.baseUrl).href);
        await expect(
          page.getByRole("textbox", { name: "Display name", exact: true }),
        ).toBeEnabled();
        await gateway.waitForRequest("users.channelIdentity");
        await page.evaluate(() => document.fonts.ready.then(() => undefined));
        const row = page.locator(".settings-row").filter({
          has: page.locator(".settings-row__title", { hasText: "Discord account" }),
        });
        const control = row.locator(".settings-row__control");
        await expect(row.getByRole("button", { name: "Connect Discord" })).toHaveAttribute(
          "aria-busy",
          "true",
        );
        const pendingRow = await row.boundingBox();
        const pendingControl = await control.boundingBox();
        expect(pendingRow).not.toBeNull();
        expect(pendingControl).not.toBeNull();

        await gateway.resolveDeferred("users.channelIdentity", { status: "ready", accounts });
        await expect(row.getByRole("button")).not.toHaveAttribute("aria-busy", "true");
        await expect(row).toContainText(
          accounts.length ? "Verified" : "Ask an admin to enable it.",
        );
        expect(await row.boundingBox()).toEqual(pendingRow);
        expect(await control.boundingBox()).toEqual(pendingControl);
      },
    );
  });
});
