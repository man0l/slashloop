// Shared tool registration for the remote HTTP MCP (remote/handlers.ts).
// Tools are scoped per-user via runWithUser (JWT sub) -> requireWorkspace().

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/sources.js';
import { registerFeedTools } from './tools/feed.js';
import { registerVideoTools } from './tools/video.js';
import { registerHookTools } from './tools/hooks.js';
import { registerCreativeTools } from './tools/creative.js';
import { registerSettingsTools } from './tools/settings.js';

/** Register the full product tool surface (32 tools). */
export function registerAllTools(server: McpServer) {
  registerSourceTools(server);
  registerFeedTools(server);
  registerVideoTools(server);
  registerHookTools(server);
  registerCreativeTools(server);
  registerSettingsTools(server);
}
