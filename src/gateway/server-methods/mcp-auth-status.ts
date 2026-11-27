import {
  ErrorCodes,
  errorShape,
  validateMcpAuthStatusParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { operatorMcpOAuthIdentity } from "../../agents/mcp-oauth-identity.js";
import { readMcpOAuthCredentialsStatus } from "../../agents/mcp-oauth.js";
import { getGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { resolveOperatorMcpOAuthConnection } from "../../plugins/mcp-auth-status.js";
import { respondUnavailableOnThrow } from "./response.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export const mcpAuthStatusHandlers: GatewayRequestHandlers = {
  "mcp.authStatus": async ({ params, respond, context }) => {
    if (!assertValidParams(params, validateMcpAuthStatusParams, "mcp.authStatus", respond)) {
      return;
    }
    const connection = resolveOperatorMcpOAuthConnection({
      config: context.getRuntimeConfig(),
      metadata: getGatewayPluginMetadataSnapshot(),
      serverName: params.serverName,
    });
    if (!connection) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "This MCP server has no shared operator OAuth sign-in.",
        ),
      );
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const status = await readMcpOAuthCredentialsStatus(
        operatorMcpOAuthIdentity(params.serverName, connection.config.url),
      );
      respond(true, { serverName: params.serverName, ...status });
    });
  },
};
