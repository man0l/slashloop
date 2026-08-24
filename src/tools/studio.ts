// MCP tools for Studio — the "my app" loop, read-only over data the scraper
// already pulled. Your week comes back from the isSelf creator source's feed;
// the benchmark compares that account to every other tracked creator. Nothing
// here logs or marks anything by hand: empty states resolve to track-your-
// account or resync, never to manual entry.

import { z } from 'zod/v4';
import { requireWorkspace } from '../context.js';
import { withNextSteps, scraperCostLabel, refreshCreditLabel } from '../lib/next-steps.js';
import { buildWeeklyRetro } from '../lib/posts.js';
import { buildBenchmark } from '../lib/benchmark.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerStudioTools(server: McpServer) {
  server.tool('get_weekly_retro',
    'This week\'s posts from the workspace isSelf creator source, scored against that creator\'s median. Free. No manual log — refresh the self source if it is empty.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      const retro = await buildWeeklyRetro(workspace);
      // The only two empty states, and the single move each one needs:
      // no account yet → track it; account but no videos → one bootstrap
      // pull. Neither ever asks the user to type in what they posted.
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps(retro, [
          retro.needsAccount ? {
            label: 'Track your own account',
            tool: 'create_source',
            args: { platform: 'tiktok', sourceType: 'creator', isSelf: true },
            why: 'Studio reads your TikTok feed once it is a tracked source — add your @handle and the first refresh fills the retro.',
          } : null,
          retro.needsResync && retro.selfSourceId ? {
            label: `Resync @${retro.selfHandle}`,
            tool: 'refresh_source',
            args: { sourceId: retro.selfSourceId },
            cost: `${scraperCostLabel(20)} + ${refreshCreditLabel(20)} (worst case)`,
            spendsMoney: true,
            why: 'Your account is tracked but holds no videos yet — one bootstrap pull scores everything against your median.',
          } : null,
        ]), null, 2) }],
      };
    });

  server.tool('get_benchmark',
    'Compare the isSelf account to every other creator the workspace tracks: median views, posts this week / 30 days, outlier mix. Free. Uses already-scraped videos — no flags or extra setup.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      const bench = await buildBenchmark(workspace);
      return { content: [{ type: 'text' as const, text: JSON.stringify(bench, null, 2) }] };
    });
}
