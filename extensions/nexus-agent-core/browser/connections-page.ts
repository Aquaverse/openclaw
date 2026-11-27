import type { ControlUiView } from "openclaw/plugin-sdk/control-ui";
import { resolveLang, tr } from "../src/i18n.js";

export const NEXUS_CONNECTIONS_PAGE_ID = "nexus-connections";

export function createConnectionsPage(): ControlUiView {
  return (container, initial) => {
    let context = initial;
    const props = () => {
      const lang = resolveLang(context.host.locale);
      return {
        title: tr(lang, "connections.title"),
        subtitle: tr(lang, "connections.subtitle"),
        copy: {
          myConnections: tr(lang, "connections.mine"),
          capabilities: tr(lang, "connections.capabilities"),
          companyCatalog: tr(lang, "connections.companyCatalog"),
          mail: tr(lang, "connections.mail"),
          mailDescription: tr(lang, "connections.mailDescription"),
          slack: tr(lang, "connections.slack"),
          slackDescription: tr(lang, "connections.slackDescription"),
          github: tr(lang, "connections.github"),
          githubDescription: tr(lang, "connections.githubDescription"),
          whatsapp: tr(lang, "connections.whatsapp"),
          whatsappDescription: tr(lang, "connections.whatsappDescription"),
          telegram: tr(lang, "connections.telegram"),
          telegramDescription: tr(lang, "connections.telegramDescription"),
          moreChannels: tr(lang, "connections.moreChannels"),
          moreChannelsDescription: tr(lang, "connections.moreChannelsDescription"),
          connected: tr(lang, "connections.connected"),
          notConnected: tr(lang, "connections.notConnected"),
          connect: tr(lang, "connections.connect"),
          add: tr(lang, "connections.add"),
          manage: tr(lang, "connections.manage"),
          view: tr(lang, "connections.view"),
          select: tr(lang, "connections.select"),
          multipleAccounts: tr(lang, "connections.multipleAccounts"),
          selectChannel: tr(lang, "connections.selectChannel"),
          lastSynced: tr(lang, "connections.lastSynced"),
          providedByAskPepio: tr(lang, "connections.providedByAskPepio"),
          disconnect: tr(lang, "connections.disconnect"),
          saveToSent: tr(lang, "connections.saveToSent"),
        },
        presented: context.presented,
      };
    };
    const mounted = initial.host.components.mountAppsConnections(container, props());
    return {
      update(next) {
        context = next;
        mounted.update(props());
      },
      dispose: () => mounted.dispose(),
    };
  };
}
