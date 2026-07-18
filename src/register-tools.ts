// Shared tool registration for both transports:
//   - stdio  (src/index.ts)     — published as slashloop-mcp on npm
//   - remote (remote/handlers)  — repo host only; imports this module in Stage 2
//
// Stage 2 will pass a per-user context (claims.sub / Supabase client) into
// each register* function so remote sessions are multi-tenant.

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
