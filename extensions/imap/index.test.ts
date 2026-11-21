import assert from "node:assert/strict";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { expect, it, vi } from "vitest";
import plugin from "./index.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

function register(registrationMode: "full" | "tool-discovery" = "full") {
  const registerTool = vi.fn();
  const registerGatewayMethod = vi.fn();
  const registerService = vi.fn();
  const on = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "imap",
      registrationMode,
      pluginConfig: {
        accounts: {
          work: {
            email: "person@example.com",
            from: "person@example.com",
            host: "imap.example.com",
            user: "person",
            password: "fixture-password",
            smtp: { host: "smtp.example.com", port: 587, security: "starttls" },
          },
        },
      },
      registerTool,
      registerGatewayMethod,
      registerService,
      on,
    }),
  );
  return { registerTool, registerGatewayMethod, registerService, on };
}

it("registers email tools, connectivity testing, and the optional watcher service", () => {
  const registered = register();
  expect(registered.registerTool.mock.calls.map(([, options]) => options.name)).toEqual([
    "email_accounts",
    "email_search",
    "email_read",
    "email_send",
  ]);
  expect(registered.registerGatewayMethod).toHaveBeenCalledWith(
    "email.testConnection",
    expect.any(Function),
    { scope: "operator.admin", profileAccess: "required" },
  );
  expect(registered.registerService).toHaveBeenCalledOnce();
});

it("exposes email tools during tool discovery without starting runtime services", () => {
  const registered = register("tool-discovery");
  expect(registered.registerTool.mock.calls.map(([, options]) => options.name)).toEqual([
    "email_accounts",
    "email_search",
    "email_read",
    "email_send",
  ]);
  expect(registered.registerGatewayMethod).not.toHaveBeenCalled();
  expect(registered.registerService).not.toHaveBeenCalled();
});

it("admits every email tool through the manifest ownership contract", () => {
  const fixture = createPluginRegistryFixture();
  registerVirtualTestPlugin({
    ...fixture,
    ...plugin,
    contracts: manifest.contracts,
    register: plugin.register,
  });
  expect(fixture.registry.registry.diagnostics).toEqual([]);
  expect(fixture.registry.registry.tools.flatMap((tool) => tool.names)).toEqual([
    "email_accounts",
    "email_search",
    "email_read",
    "email_send",
  ]);
});

it("loads by default so first-time connection testing is available", () => {
  expect(manifest.enabledByDefault).toBe(true);
  expect(manifest.activation.onStartup).toBe(true);
});

it("requires one-time approval only for sending email", async () => {
  const { on } = register();
  const hook = on.mock.calls.find(([name]) => name === "before_tool_call")?.[1];
  assert(hook, "missing before_tool_call hook");
  expect(hook({ toolName: "email_search", params: { account: "work" } })).toBeUndefined();
  expect(
    hook({
      toolName: "email_send",
      params: { account: "work", to: ["recipient@example.com"], subject: "Status" },
    }),
  ).toMatchObject({
    requireApproval: {
      title: "Send email",
      allowedDecisions: ["allow-once", "deny"],
    },
  });
});
