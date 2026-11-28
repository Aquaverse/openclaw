import { describe, expect, it } from "vitest";
import type { ChannelPlugin } from "../../channels/plugins/types.public.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { resolveMessageTarget } from "./message-action-routing.js";
import { createAlwaysConfiguredPluginConfig } from "./message-action-runner.test-helpers.js";

describe("resolveMessageTarget", () => {
  it("resolves an exact Slack-style #channel name before treating it as an id", async () => {
    const plugin: ChannelPlugin = {
      ...createChannelTestPluginBase({
        id: "slack",
        capabilities: { chatTypes: ["channel"] },
        config: createAlwaysConfiguredPluginConfig(),
      }),
      messaging: {
        targetResolver: {
          looksLikeId: (value) => value.startsWith("#") || value.startsWith("C"),
        },
      },
      directory: {
        listGroupsLive: async () => [{ id: "C0CHB0G0Z7V", name: "nexus-test", kind: "group" }],
      },
    };
    const args: Record<string, unknown> = { to: "#nexus-test" };

    await resolveMessageTarget({
      cfg: {},
      channel: "slack",
      action: "send",
      args,
      plugin,
    });

    expect(args.to).toBe("C0CHB0G0Z7V");
  });
});
