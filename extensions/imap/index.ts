import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginServiceContextV2,
} from "openclaw/plugin-sdk/plugin-entry";
import { resolveImapConfig } from "./src/config.js";
import { registerEmailGatewayMethods } from "./src/gateway.js";
import { createImapState } from "./src/state.js";
import { registerEmailTools } from "./src/tools.js";
import { ImapAccountWatcher } from "./src/watcher.js";

const imapConfigSchema = { parse: resolveImapConfig };

export default definePluginEntry({
  id: "imap",
  name: "IMAP email trigger",
  description: "Dispatch authenticated incoming IMAP email to isolated agent sessions.",
  configSchema: imapConfigSchema,
  register(api: OpenClawPluginApi) {
    if (api.registrationMode !== "full" && api.registrationMode !== "tool-discovery") {
      return;
    }
    const currentConfig = () => imapConfigSchema.parse(api.pluginConfig);
    registerEmailTools(api, currentConfig);
    if (api.registrationMode === "tool-discovery") {
      return;
    }
    registerEmailGatewayMethods(api);
    let watchers: ImapAccountWatcher[] = [];
    api.registerService({
      id: "imap-watch",
      apiVersion: 2,
      start(context: OpenClawPluginServiceContextV2) {
        if (context.scheduler.signal.aborted) {
          return;
        }
        const config = imapConfigSchema.parse(api.pluginConfig, (accountId) => {
          context.logger.warn(
            `imap: account=${accountId} unavailable; resolve its IMAP password and reload configuration`,
          );
        });
        const accounts = Object.entries(config.accounts).filter(([, account]) => account.agentId);
        if (!accounts.length) {
          return;
        }
        const state = createImapState(api.runtime);
        watchers = accounts.map(
          ([accountId, account]) =>
            new ImapAccountWatcher({ accountId, account, runtime: api.runtime, state, context }),
        );
        for (const watcher of watchers) {
          watcher.start();
        }
      },
      async stop() {
        const active = watchers;
        watchers = [];
        await Promise.all(active.map((watcher) => watcher.stop()));
      },
    });
  },
});
