#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Slashloop — MCP Server
// Exposes all viral content research tools via the Model Context Protocol.
// Transport: stdio (for MCP clients: Cursor, Claude Desktop, etc.)
// ---------------------------------------------------------------------------

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerSourceTools } from './tools/sources.js';
import { registerFeedTools } from './tools/feed.js';
import { registerVideoTools } from './tools/video.js';
import { registerHookTools } from './tools/hooks.js';
import { registerCreativeTools } from './tools/creative.js';
import { registerSettingsTools } from './tools/settings.js';

// ---- Create server ----

const server = new McpServer({
  name: 'slashloop',
  version: '1.0.0',
  description: 'Viral content research MCP server. Monitors TikTok, Instagram Reels, and YouTube Shorts for outlier videos, runs AI analysis, and converts winners into hooks, ideas, and creative briefs.',
});

// ---- Register all tool groups ----

registerSourceTools(server);
registerFeedTools(server);
registerVideoTools(server);
registerHookTools(server);
registerCreativeTools(server);
registerSettingsTools(server);

// ---- List of all registered tools (for documentation) ----
// Sources (6):  list_sources, get_source, create_source, update_source, delete_source, refresh_source
// Feed (3):     get_feed, discover_search, get_outlier_summary
// Video (3):    get_video, analyze_video, get_video_transcript
// Hooks (3):    list_hooks, extract_hook, generate_hook_variations
// Creative(11): list_boards, get_board, create_board, save_to_board, export_board,
//               list_ideas, create_idea, update_idea_status,
//               create_brief, get_brief, export_brief
// Settings(6):  get_usage, get_settings, update_settings, get_refresh_logs,
//               run_auto_analyze, get_apify_spend_status
// Total: 32 tools across 6 modules

// ---- Start ----

async function main() {
  console.error('[slashloop] Starting MCP server...');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[slashloop] MCP server running on stdio');
  console.error('[slashloop] 32 tools registered across 6 modules');
}

main().catch((err) => {
  console.error('[slashloop] Fatal error:', err);
  process.exit(1);
});