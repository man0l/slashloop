#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Slashloop — MCP Server
// Exposes all viral content research tools via the Model Context Protocol.
// Transport: stdio (for MCP clients: Cursor, Claude Desktop, etc.)
// ---------------------------------------------------------------------------

import './env-defaults.js';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAllTools } from './register-tools.js';

// ---- Create server ----

const server = new McpServer({
  name: 'slashloop',
  version: '1.0.0',
  description: 'Viral content research MCP server. Monitors TikTok, Instagram Reels, and YouTube Shorts for outlier videos, runs AI analysis, and converts winners into hooks, ideas, and creative briefs.',
});

// ---- Register all tool groups (shared with remote MCP once Stage 2 lands) ----

registerAllTools(server);

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

// ---- First-run DB init ----

function ensureDatabase() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl || !dbUrl.startsWith('file:')) {
    console.error('[slashloop] No file: DATABASE_URL set; skipping DB init.');
    return;
  }
  const target = dbUrl.slice('file:'.length);
  if (existsSync(target)) return;
  try {
    mkdirSync(dirname(target), { recursive: true });
    const template = fileURLToPath(new URL('../prisma/empty.db', import.meta.url));
    if (existsSync(template)) {
      copyFileSync(template, target);
      console.error(`[slashloop] Initialized database at ${target}`);
    } else {
      console.error(`[slashloop] No DB template at ${template}. Run: prisma db push`);
    }
  } catch (e) {
    console.error('[slashloop] DB init failed:', e);
  }
}

// ---- Start ----

async function main() {
  ensureDatabase();
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