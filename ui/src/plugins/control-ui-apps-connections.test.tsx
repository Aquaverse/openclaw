/* @vitest-environment jsdom */

import { beforeEach, expect, it, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { AppsConnections, type AppsConnectionsCopy } from "./control-ui-apps-connections.tsx";

const {
  gatewayRequest,
  gatewayState,
  gatewaySubscribers,
  githubEnsureVerified,
  githubRead,
  githubSync,
  onShowDetail,
  onStartSetup,
  prepareSignIn,
  resetLogin,
  runtimeState,
  startMcpLogin,
} = vi.hoisted(() => ({
  gatewayRequest: vi.fn(),
  gatewayState: {
    snapshot: { client: null, phase: "disconnected", hello: null, sessionKey: "main" } as Record<
      string,
      unknown
    >,
  },
  gatewaySubscribers: new Set<(snapshot: Record<string, unknown>) => void>(),
  githubEnsureVerified: vi.fn(),
  githubRead: vi.fn(() => ({ personal: { state: "disconnected" } })),
  githubSync: vi.fn(),
  onShowDetail: vi.fn(),
  onStartSetup: vi.fn(),
  prepareSignIn: vi.fn(),
  resetLogin: vi.fn(),
  runtimeState: {
    config: {} as Record<string, unknown>,
    patchFromSnapshot: vi.fn(),
  },
  startMcpLogin: vi.fn(async () => null),
}));

vi.mock("../lib/reactive/context.ts", () => ({
  useApplication: () => ({
    gateway: {
      get snapshot() {
        return gatewayState.snapshot;
      },
      subscribe: (listener: (snapshot: Record<string, unknown>) => void) => {
        gatewaySubscribers.add(listener);
        return () => gatewaySubscribers.delete(listener);
      },
    },
    runtimeConfig: {
      state: {},
      ensureLoaded: vi.fn(),
      patchFromSnapshot: runtimeState.patchFromSnapshot,
      subscribe: () => () => undefined,
    },
  }),
}));
vi.mock("../lib/reactive/domain-capabilities.ts", () => ({
  projectRuntimeConfig: () => ({ read: () => ({ state: {} }) }),
}));
vi.mock("../lib/config/config-state-model.ts", () => ({
  currentConfigObject: () => runtimeState.config,
}));
vi.mock("../components/wizard-login-controller.tsx", () => ({
  createWizardLogin: () => ({
    reset: resetLogin,
    runner: { prepareSignIn, startMcpLogin },
  }),
  WizardLogin: () => <div data-surface="fireflies-login" />,
}));
vi.mock("../lib/reactive/domain-github-identity.ts", () => ({
  createGitHubIdentityView: () => ({
    read: githubRead,
    sync: githubSync,
    ensureVerified: githubEnsureVerified,
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
  fireflies: "Fireflies",
  firefliesDescription: "Authorize Fireflies",
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

beforeEach(() => {
  gatewayRequest.mockReset();
  gatewayState.snapshot = {
    client: null,
    phase: "disconnected",
    hello: null,
    sessionKey: "main",
  };
  runtimeState.config = {};
  runtimeState.patchFromSnapshot.mockReset();
  gatewaySubscribers.clear();
  githubEnsureVerified.mockReset();
  githubRead.mockReset();
  githubRead.mockReturnValue({ personal: { state: "disconnected" } });
  githubSync.mockReset();
  prepareSignIn.mockReset();
  resetLogin.mockReset();
  startMcpLogin.mockReset();
  startMcpLogin.mockResolvedValue(null);
});

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

it("authorizes the existing Fireflies MCP without adding another server", async () => {
  runtimeState.config = {
    mcp: {
      servers: {
        fireflies: {
          url: "https://api.fireflies.ai/mcp",
          transport: "streamable-http",
          auth: "oauth",
        },
      },
    },
  };
  gatewayRequest.mockResolvedValue({ groups: [], notices: [] });
  gatewayState.snapshot = {
    client: { request: gatewayRequest },
    phase: "connected",
    sessionKey: "main",
    hello: {
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: { methods: ["tools.effective", "mcp.authLogin"] },
      server: { connId: "test-connection" },
    },
  };
  const view = mountConnections();

  const row = rowByTitle(view.container, "Fireflies");
  expect(row.textContent).toContain("Not connected");
  row.querySelector("button")?.click();

  expect(prepareSignIn).toHaveBeenCalledWith("oauth", "Fireflies");
  expect(startMcpLogin).toHaveBeenCalledWith("fireflies");
  expect(runtimeState.patchFromSnapshot).not.toHaveBeenCalled();
  expect(view.container.querySelectorAll("[data-surface='fireflies-login']")).toHaveLength(1);

  view.unmount();
});

it("offers Fireflies when it is not installed and registers it before authorization", async () => {
  runtimeState.patchFromSnapshot.mockImplementation(async (build) => {
    const request = build(runtimeState.config);
    runtimeState.config = {
      mcp: {
        servers: {
          fireflies: request.options.raw.mcp.servers.fireflies,
        },
      },
    };
    return true;
  });
  gatewayState.snapshot = {
    client: { request: gatewayRequest },
    phase: "connected",
    sessionKey: "main",
    hello: {
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: { methods: ["mcp.authLogin"] },
      server: { connId: "test-connection" },
    },
  };
  const view = mountConnections();

  const row = rowByTitle(view.container, "Fireflies");
  row.querySelector("button")?.click();

  await vi.waitFor(() => {
    expect(runtimeState.patchFromSnapshot).toHaveBeenCalledOnce();
    expect(startMcpLogin).toHaveBeenCalledWith("fireflies");
  });
  expect(prepareSignIn).toHaveBeenCalledWith("oauth", "Fireflies");

  view.unmount();
});

it("lists an authorized Fireflies MCP as one existing connection", async () => {
  runtimeState.config = {
    mcp: {
      servers: {
        fireflies: {
          url: "https://api.fireflies.ai/mcp",
          transport: "streamable-http",
          auth: "oauth",
        },
      },
    },
  };
  gatewayRequest.mockImplementation(async (method: string) => {
    if (method === "mcp.authStatus") {
      return { serverName: "fireflies", state: "authorized" };
    }
    if (method === "tools.effective") {
      return { groups: [], notices: [] };
    }
    throw new Error(`Unexpected method: ${method}`);
  });
  gatewayState.snapshot = {
    client: { request: gatewayRequest },
    phase: "connected",
    sessionKey: "main",
    hello: {
      auth: { role: "operator", scopes: ["operator.read", "operator.admin"] },
      features: { methods: ["tools.effective", "mcp.authStatus", "mcp.authLogin"] },
      server: { connId: "test-connection" },
    },
  };
  const view = mountConnections();

  await vi.waitFor(() => {
    expect(view.container.querySelector(".apps-connections__count")?.textContent?.trim()).toBe("2");
  });
  const cards = [...view.container.querySelectorAll<HTMLElement>(".apps-connections__card")];
  expect(cards.some((card) => card.textContent?.includes("Fireflies"))).toBe(true);
  expect(view.container.textContent).not.toContain("Authorize FirefliesNot connected");
  expect(runtimeState.patchFromSnapshot).not.toHaveBeenCalled();

  view.unmount();
});

it("adopts a GitHub authorization when the profile arrives on a reused gateway snapshot", async () => {
  gatewayState.snapshot = {
    client: { request: gatewayRequest },
    phase: "connected",
    selfUser: undefined,
    sessionKey: "main",
    hello: {
      auth: { role: "operator", scopes: ["operator.read"] },
      server: { connId: "test-connection" },
    },
  };
  const view = mountConnections();

  await vi.waitFor(() => {
    expect(githubSync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connected: true,
        target: { kind: "personal", profileId: "test-connection" },
        statusReadable: true,
      }),
    );
  });

  gatewayState.snapshot.selfUser = { id: "profile-user" };
  for (const listener of gatewaySubscribers) {
    listener(gatewayState.snapshot);
  }

  await vi.waitFor(() => {
    expect(githubSync).toHaveBeenLastCalledWith(
      expect.objectContaining({
        connected: true,
        target: { kind: "personal", profileId: "profile-user" },
        statusReadable: true,
      }),
    );
  });

  view.unmount();
});
