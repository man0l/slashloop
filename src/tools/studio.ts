// MCP tools for the "my app" loop: log what you posted, read this week's
// retro, compare your account to flagged competitors.

import { z } from 'zod/v4';
import { requireWorkspace } from '../context.js';
import { withNextSteps } from '../lib/next-steps.js';
import { logPostForWorkspace, listPostsForWorkspace, buildWeeklyRetro } from '../lib/posts.js';
import { buildBenchmark } from '../lib/benchmark.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerStudioTools(server: McpServer) {
  server.tool('log_post',
    'Record a TikTok you actually published so the weekly retro can score it against your median. Free. Pass the watch URL; optionally which outlier you remade and the hook variation you used.',
    {
      url: z.string().url().describe('TikTok watch URL of the post you published'),
      postedAt: z.string().optional().describe('ISO timestamp. Default: now.'),
      hookVariation: z.string().optional().describe('Which hook you used, in a few words'),
      notes: z.string().optional(),
      ideaId: z.string().optional().describe('Idea this post came from — marks it tested'),
      outlierVideoId: z.string().optional().describe('Library video you remade'),
    },
    async (input) => {
      const workspace = await requireWorkspace();
      const result = await logPostForWorkspace(workspace, input);
      if (!result.ok) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error, message: result.message }) }], isError: true };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps(
          { message: 'Post logged', post: result.post },
          [{ label: 'See this week\'s retro', tool: 'get_weekly_retro' }],
        ), null, 2) }],
      };
    });

  server.tool('list_posts',
    'List TikToks you logged via log_post, newest first. Free.',
    { limit: z.number().min(1).max(100).optional() },
    async ({ limit }) => {
      const workspace = await requireWorkspace();
      const posts = await listPostsForWorkspace(workspace, limit ?? 50);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ posts, count: posts.length }, null, 2) }] };
    });

  server.tool('get_weekly_retro',
    'This week\'s retro: logged posts matched to your scraped videos, scored against your creator median. Free. Mark a source as isSelf first.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      const retro = await buildWeeklyRetro(workspace);
      return { content: [{ type: 'text' as const, text: JSON.stringify(retro, null, 2) }] };
    });

  server.tool('get_benchmark',
    'Compare your account (isSelf) to competitor creators: median views, posts this week / 30 days, outlier mix. Free. Uses already-scraped videos.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      const bench = await buildBenchmark(workspace);
      return { content: [{ type: 'text' as const, text: JSON.stringify(bench, null, 2) }] };
    });
}
