/* @vitest-environment jsdom */

import type { ControlUiComponentHandle } from "openclaw/plugin-sdk/control-ui";
import { expect, it, vi } from "vitest";
import { createConnectionsPage } from "./connections-page.ts";

it("mounts the host-owned connections surface and follows locale and presentation updates", () => {
  const update = vi.fn();
  const dispose = vi.fn();
  const mountAppsConnections = vi.fn(
    () => ({ update, dispose }) as ControlUiComponentHandle<unknown>,
  );
  const host = {
    locale: "en-US",
    components: { mountAppsConnections },
  };
  const container = document.createElement("div");
  const controller = new AbortController();
  const context = (presented: boolean) =>
    ({
      host,
      signal: controller.signal,
      props: {},
      presented,
      mountDefault: () => () => undefined,
    }) as never;

  const mounted = createConnectionsPage()(container, context(true));
  expect(mountAppsConnections).toHaveBeenCalledWith(container, {
    title: "Apps & connections",
    subtitle:
      "Manage your accounts, messaging channels, and the connections your assistant can use.",
    copy: {
      myConnections: "My connections",
      capabilities: "Capabilities",
      companyCatalog: "Company catalog",
      mail: "Mail",
      mailDescription: "Manage email accounts and mail access.",
      slack: "Slack",
      slackDescription: "Connect Slack workspaces and messages.",
      github: "GitHub",
      githubDescription: "Manage my GitHub connection.",
      whatsapp: "WhatsApp",
      whatsappDescription: "Connect a WhatsApp messaging channel.",
      telegram: "Telegram",
      telegramDescription: "Connect Telegram bots and messages.",
      moreChannels: "More channels",
      moreChannelsDescription: "Select another available messaging channel.",
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
    },
    presented: true,
  });

  host.locale = "zh-CN";
  mounted?.update?.(context(false));
  expect(update).toHaveBeenCalledWith({
    title: "应用与连接",
    subtitle: "管理你的账户、消息频道，以及智能助理可以使用的连接。",
    copy: {
      myConnections: "我的连接",
      capabilities: "工作能力",
      companyCatalog: "企业目录",
      mail: "邮箱",
      mailDescription: "管理邮箱账户和收发邮件能力。",
      slack: "Slack",
      slackDescription: "连接 Slack 工作区和消息。",
      github: "GitHub",
      githubDescription: "管理我的 GitHub 连接。",
      whatsapp: "WhatsApp",
      whatsappDescription: "连接 WhatsApp 消息频道。",
      telegram: "Telegram",
      telegramDescription: "连接 Telegram 机器人和消息。",
      moreChannels: "更多渠道",
      moreChannelsDescription: "选择其他可用的消息渠道。",
      connected: "已连接",
      notConnected: "未连接",
      connect: "连接",
      add: "添加",
      manage: "管理",
      view: "查看",
      select: "选择",
      multipleAccounts: "支持多个账户",
      selectChannel: "选择频道",
      lastSynced: "最近同步",
      providedByAskPepio: "由 Ask Pepio 提供",
      disconnect: "断开…",
      saveToSent: "保存到发件箱",
    },
    presented: false,
  });

  mounted?.dispose?.();
  expect(dispose).toHaveBeenCalledOnce();
});
