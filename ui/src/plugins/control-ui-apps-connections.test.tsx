/* @vitest-environment jsdom */

import { expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { AppsConnections, type AppsConnectionsCopy } from "./control-ui-apps-connections.tsx";

const { onShowDetail, onStartSetup } = vi.hoisted(() => ({
  onShowDetail: vi.fn(),
  onStartSetup: vi.fn(),
}));

vi.mock("../lib/reactive/context.ts", () => ({
  useApplication: () => ({
    gateway: {
      snapshot: { client: null, phase: "disconnected", hello: null },
      subscribe: () => () => undefined,
    },
    runtimeConfig: { ensureLoaded: vi.fn() },
  }),
}));
vi.mock("../lib/reactive/domain-capabilities.ts", () => ({
  projectRuntimeConfig: () => ({ read: () => ({ state: {} }) }),
}));
vi.mock("../lib/config/config-state-model.ts", () => ({
  currentConfigObject: () => ({}),
}));
vi.mock("../lib/reactive/domain-github-identity.ts", () => ({
  createGitHubIdentityView: () => ({
    read: () => ({ personal: { state: "disconnected" } }),
    sync: vi.fn(),
    ensureVerified: vi.fn(),
  }),
}));
vi.mock("../pages/profile/email-accounts.tsx", () => ({
  configuredEmailAccounts: () => ({}),
  EmailAccounts: (props: { initialAction?: string; saveSentCopyLabel?: string }) => (
    <div
      data-surface="email"
      data-initial-action={props.initialAction ?? "manage"}
      data-save-sent-label={props.saveSentCopyLabel}
    >
      Email accounts
    </div>
  ),
}));
vi.mock("../features/github-connections/github-connections.tsx", () => ({
  GitHubConnections: () => <div data-surface="github">GitHub account</div>,
}));
vi.mock("../components/solid/channel-icon.tsx", () => ({
  ChannelIcon: (props: { channelId: string }) => <span data-channel-icon={props.channelId} />,
}));
vi.mock("../pages/channels/view.tsx", () => ({
  ChannelConnectionOverlays: () => <div data-surface="channel-overlays" />,
  resolveChannelLabel: (_props: unknown, channel: string) =>
    ({ slack: "Slack", whatsapp: "WhatsApp", telegram: "Telegram", discord: "Discord" })[channel] ??
    channel,
  resolveChannelOrder: () => ["slack", "whatsapp", "telegram", "discord"],
}));
vi.mock("../pages/channels/channels-page.tsx", () => ({
  ChannelsPage: (props: { render: (channels: unknown) => unknown }) => (
    <>
      {props.render({
        channels: {
          channelsSnapshot: {
            ts: 1,
            channelOrder: ["slack", "whatsapp", "telegram", "discord"],
            channelLabels: {},
            channels: { slack: { configured: true }, whatsapp: {}, telegram: {}, discord: {} },
            channelAccounts: {},
            channelDefaultAccountId: {},
          },
        },
        presentation: { pluginIconUrls: {} },
        onShowDetail,
        onStartSetup,
      })}
    </>
  ),
}));

const copy: AppsConnectionsCopy = {
  myConnections: "My connections",
  capabilities: "Capabilities",
  companyCatalog: "Company catalog",
  mail: "Mail",
  mailDescription: "Manage email accounts",
  slack: "Slack",
  slackDescription: "Connect Slack",
  github: "GitHub",
  githubDescription: "Manage my GitHub connection",
  whatsapp: "WhatsApp",
  whatsappDescription: "Connect WhatsApp",
  telegram: "Telegram",
  telegramDescription: "Connect Telegram",
  moreChannels: "More channels",
  moreChannelsDescription: "Select another channel",
  connected: "Connected",
  notConnected: "Not connected",
  connect: "Connect",
  add: "Add",
  manage: "Manage",
  view: "View",
  select: "Select",
  multipleAccounts: "Multiple accounts supported",
  selectChannel: "Select a channel",
  lastSynced: "Last synced",
  providedByAskPepio: "provided by Ask Pepio",
  disconnect: "Disconnect…",
  saveToSent: "Save to Sent folder",
};

function mountConnections() {
  return mountSolid(() => (
    <AppsConnections
      title="Apps & connections"
      subtitle="Connected capabilities"
      copy={copy}
      presented={true}
    />
  ));
}

function rowByTitle(container: HTMLElement, title: string) {
  const rows = [...container.querySelectorAll<HTMLElement>(".apps-connections__row")];
  const row = rows.find(
    (candidate) => candidate.querySelector(".apps-connections__row-title")?.textContent === title,
  );
  expect(row, `row ${title}`).toBeDefined();
  return row!;
}

it("counts and lists the one connected Slack account", () => {
  onShowDetail.mockClear();
  const view = mountConnections();

  expect(view.container.querySelector(".apps-connections__count")?.textContent?.trim()).toBe("1");
  const card = view.container.querySelector(".apps-connections__card");
  expect(card?.textContent).toContain("Slack");
  expect(card?.textContent).toContain("Connected");
  expect(card?.textContent).toContain("Last synced");
  expect(card?.textContent).toContain("provided by Ask Pepio");
  expect(card?.querySelector("button")?.textContent).toContain("Disconnect…");
  card?.querySelector("button")?.click();
  expect(onShowDetail).toHaveBeenCalledWith("slack");
  expect(view.container.querySelectorAll(".apps-connections__catalog-chevron")).toHaveLength(0);
  expect(rowByTitle(view.container, "Mail").querySelector("button")?.textContent).toContain("Add");
  expect(view.container.textContent).not.toContain("Connect Slack");

  view.unmount();
});

it("opens mail and channel setup in the current page", async () => {
  onStartSetup.mockClear();
  const view = mountConnections();

  rowByTitle(view.container, "Mail").querySelector("button")?.click();
  await vi.waitFor(() => {
    expect(
      view.container.querySelector("[data-surface='email']")?.getAttribute("data-initial-action"),
    ).toBe("add");
    expect(
      view.container.querySelector("[data-surface='email']")?.getAttribute("data-save-sent-label"),
    ).toBe("Save to Sent folder");
  });

  rowByTitle(view.container, "WhatsApp").querySelector("button")?.click();
  expect(onStartSetup).toHaveBeenCalledWith("whatsapp");
  expect(view.container.textContent).not.toContain("Channel setup");
  expect(view.container.textContent).not.toContain("How channels work");
  expect(view.container.textContent).not.toContain("Direct-message");

  view.unmount();
});

it("expands the channel selector inline and starts the selected channel setup", async () => {
  onStartSetup.mockClear();
  const view = mountConnections();

  rowByTitle(view.container, "More channels").querySelector("button")?.click();
  await vi.waitFor(() => expect(view.container.textContent).toContain("Select a channel"));
  rowByTitle(view.container, "Discord").querySelector("button")?.click();
  expect(onStartSetup).toHaveBeenCalledWith("discord");

  view.unmount();
});
