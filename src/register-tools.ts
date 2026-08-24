// Shared tool registration for the remote HTTP MCP (remote/handlers.ts).
// Tools are scoped per-user via runWithUser (JWT sub) -> requireWorkspace().

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSourceTools } from './tools/sources.js';
import { registerDiscoverTools } from './tools/discover.js';
import { registerFeedTools } from './tools/feed.js';
import { registerVideoTools } from './tools/video.js';
import { registerHookTools } from './tools/hooks.js';
import { registerCreativeTools } from './tools/creative.js';
import { registerSettingsTools } from './tools/settings.js';
import { registerGalleryApp } from './tools/gallery.js';
import { registerFetchTool } from './tools/fetch.js';
import { registerBaselineTools } from './tools/baselines.js';
import { registerJobTools } from './tools/jobs.js';
import { registerScheduleTools } from './tools/schedule.js';
import { registerStudioTools } from './tools/studio.js';

/** Register the full product tool surface, plus the gallery MCP App (§4). */
export function registerAllTools(server: McpServer) {
  registerSourceTools(server);
  registerDiscoverTools(server);
  registerFeedTools(server);
  registerVideoTools(server);
  registerHookTools(server);
  registerCreativeTools(server);
  registerSettingsTools(server);
  registerGalleryApp(server);
  registerFetchTool(server);
  registerBaselineTools(server);
  registerJobTools(server);
  registerScheduleTools(server);
  registerStudioTools(server);
}
