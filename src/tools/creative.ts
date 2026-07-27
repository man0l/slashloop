// ---------------------------------------------------------------------------
// MCP Tools: Swipe Boards, Ideas, Briefs
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { generateBrief } from '../analysis/briefs.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, insufficientCreditsPayload, creditBalance } from '../lib/credits.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerCreativeTools(server: McpServer) {

  // ============ BOARDS ============

  server.tool('list_boards',
    'List all swipe file boards.',
    {},
    async () => {
      const workspace = await requireWorkspace();
      const boards = await db.board.findMany({
        where: { workspaceId: workspace.id },
        include: { _count: { select: { swipeEntries: true } } },
        orderBy: { createdAt: 'desc' },
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(boards, null, 2) }] };
    });

  server.tool('get_board',
    'Get a swipe board with all its entries.',
    { boardId: z.string() },
    async ({ boardId }) => {
      const board = await db.board.findUnique({
        where: { id: boardId },
        include: {
          swipeEntries: {
            include: {
              video: { select: { id: true, url: true, thumbnailUrl: true, creatorHandle: true, caption: true, platform: true, views: true, postedAt: true, score: true } },
            },
            orderBy: { savedAt: 'desc' },
          },
        },
      });
      if (!board) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Board not found' }) }], isError: true };

      return { content: [{ type: 'text' as const, text: JSON.stringify(board, null, 2) }] };
    });

  server.tool('create_board',
    'Create a new swipe file board.',
    { name: z.string().describe('Board name') },
    async ({ name }) => {
      const workspace = await requireWorkspace();

      const board = await db.board.create({ data: { workspaceId: workspace.id, name } });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Board created', board }, null, 2) }] };
    });

  server.tool('save_to_board',
    'Save a video (with optional analysis snapshot) to a swipe board.',
    {
      boardId: z.string(),
      videoId: z.string(),
      notes: z.string().optional().describe('Free-text notes for this entry'),
    },
    async ({ boardId, videoId, notes }) => {
      // Get analysis snapshot if available
      const analysis = await db.analysis.findFirst({ where: { videoId }, select: { analysisJson: true, analysisBasis: true } });

      const entry = await db.swipeEntry.upsert({
        where: { boardId_videoId: { boardId, videoId } },
        create: {
          boardId,
          videoId,
          analysisSnapshotJson: analysis?.analysisJson ?? '{}',
          notes: notes ?? '',
        },
        update: {
          analysisSnapshotJson: analysis?.analysisJson ?? '{}',
          notes: notes ?? undefined,
          savedAt: new Date(),
        },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Saved to board', entryId: entry.id }) }] };
    });

  server.tool('export_board',
    'Export a swipe board as Markdown for client deliverables.',
    { boardId: z.string() },
    async ({ boardId }) => {
      const board = await db.board.findUnique({
        where: { id: boardId },
        include: {
          swipeEntries: {
            include: { video: { select: { url: true, creatorHandle: true, caption: true, platform: true, views: true, score: true } } },
            orderBy: { savedAt: 'desc' },
          },
        },
      });
      if (!board) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Board not found' }) }], isError: true };

      let md = `# ${board.name}\n\n`;
      md += `*Exported ${new Date().toISOString().split('T')[0]} — ${board.swipeEntries.length} entries*\n\n---\n\n`;

      for (const entry of board.swipeEntries) {
        const v = entry.video;
        md += `## @${v.creatorHandle} (${v.platform})\n`;
        md += `**Views**: ${v.views?.toLocaleString() ?? 'N/A'} | Score: ${v.score?.outlierScore?.toFixed(1) ?? 'N/A'}x\n`;
        md += `**URL**: ${v.url}\n\n`;
        md += `> ${v.caption?.slice(0, 200) ?? 'No caption'}\n\n`;
        if (entry.notes) md += `**Notes**: ${entry.notes}\n\n`;
        md += `---\n\n`;
      }

      return { content: [{ type: 'text' as const, text: md }] };
    });

  // ============ IDEAS ============

  server.tool('list_ideas',
    'List idea cards. Filter by status.',
    {
      status: z.enum(['new', 'briefed', 'tested', 'archived']).optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ status, limit }) => {
      const ideas = await db.idea.findMany({
        where: { status: status ?? undefined },
        include: {
          video: { select: { id: true, url: true, creatorHandle: true, caption: true, platform: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(ideas, null, 2) }] };
    });

  server.tool('create_idea',
    'Create an idea card from an analyzed video. Ideas bridge research and production.',
    {
      analysisId: z.string(),
      transferablePattern: z.string().describe('The transferable concept stated generically'),
      whyItWorked: z.string().describe('Why it worked, from the analysis'),
      adaptation: z.string().describe('How to adapt for your brand context'),
    },
    async ({ analysisId, transferablePattern, whyItWorked, adaptation }) => {
      const analysis = await db.analysis.findUnique({ where: { id: analysisId } });
      if (!analysis) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Analysis not found' }) }], isError: true };

      const idea = await db.idea.create({
        data: { videoId: analysis.videoId, analysisId, transferablePattern, whyItWorked, adaptation },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Idea created', idea }, null, 2) }] };
    });

  server.tool('update_idea_status',
    'Update an idea card status (new → briefed → tested → archived).',
    {
      ideaId: z.string(),
      status: z.enum(['new', 'briefed', 'tested', 'archived']),
    },
    async ({ ideaId, status }) => {
      const idea = await db.idea.update({ where: { id: ideaId }, data: { status } }).catch(() => null);
      if (!idea) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Idea not found' }) }], isError: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Idea updated', ideaId: idea.id, status: idea.status }) }] };
    });

  // ============ BRIEFS ============

  server.tool('create_brief',
    'Generate a UGC/ad brief from an analysis. Includes concept, hook, talking points, visual beats, and deliverable specs. Costs 2 credits.',
    {
      analysisId: z.string(),
      brandContext: z.string().optional().describe('Brand/product context for adaptation'),
    },
    async ({ analysisId, brandContext }) => {
      const workspace = await requireWorkspace();
      const opId = randomUUID();
      try {
        await debitCredits(workspace.id, CREDIT_COSTS.createBrief, 'create_brief', `${opId}:preauth`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        throw err;
      }

      try {
        const result = await generateBrief(analysisId, brandContext);
        const balance = await creditBalance(workspace.id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: 'Brief generated',
            id: result.id,
            brief: result.brief,
            creditsCharged: CREDIT_COSTS.createBrief,
            creditsRemaining: balance.total,
          }, null, 2) }],
        };
      } catch (err) {
        const balance = await refundCredits(workspace.id, CREDIT_COSTS.createBrief, 'create_brief', `${opId}:fail`, 'call_failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Brief generation failed',
            message: (err as Error).message,
            creditsCharged: 0,
            creditsRemaining: balance.total,
          }) }],
          isError: true,
        };
      }
    });

  server.tool('get_brief',
    'Get a brief by ID.',
    { briefId: z.string() },
    async ({ briefId }) => {
      const brief = await db.brief.findUnique({
        where: { id: briefId },
        include: { analysis: { select: { videoId: true } }, idea: { select: { id: true } } },
      });
      if (!brief) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Brief not found' }) }], isError: true };

      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...brief, brief: JSON.parse(brief.briefJson) }, null, 2) }] };
    });

  server.tool('export_brief',
    'Export a brief as Markdown.',
    { briefId: z.string() },
    async ({ briefId }) => {
      const brief = await db.brief.findUnique({ where: { id: briefId } });
      if (!brief) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Brief not found' }) }], isError: true };

      const b = JSON.parse(brief.briefJson);
      let md = `# Creative Brief\n\n`;
      md += `## Concept\n${b.concept}\n\n`;
      md += `## Hook\n${b.hook}\n\n`;
      md += `## Creator Direction\n${b.creatorDirection}\n\n`;
      md += `## Talking Points\n${b.talkingPoints.map((p: string, i: number) => `${i + 1}. ${p}`).join('\n')}\n\n`;
      md += `## Visual Beats\n`;
      for (const beat of b.visualBeats) md += `- **${beat.timestampSec}s**: ${beat.description}\n`;
      md += `\n## What NOT to Copy\n${b.whatNotToCopy.map((c: string) => `- ${c}`).join('\n')}\n\n`;
      md += `## Deliverable Specs\n- Length: ${b.deliverableSpecs.length}\n- Format: ${b.deliverableSpecs.format}\n- Platform: ${b.deliverableSpecs.platform}\n`;

      return { content: [{ type: 'text' as const, text: md }] };
    });
}