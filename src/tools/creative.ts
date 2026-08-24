// ---------------------------------------------------------------------------
// MCP Tools: Swipe Boards, Ideas, Briefs
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { generateBrief } from '../analysis/briefs.js';
import { generateScript } from '../analysis/scripts.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, insufficientCreditsPayload, creditBalance } from '../lib/credits.js';
import { costBlock, withNextSteps } from '../lib/next-steps.js';
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

  // ============ SCRIPTS ============

  server.tool('generate_script',
    'Turn an analysis into a ready-to-shoot TikTok script for the USER\'S OWN app, in a proven app-promo format '
      + '(pov_demo, problem_solution, apps_that_feel_illegal, build_in_public, listicle). The analyzed video is the '
      + 'evidence base — the script always promotes the user\'s app. Word-for-word hook, beat-by-beat shots, CTA, '
      + 'caption and hashtags. Costs 2 credits.',
    {
      analysisId: z.string().describe('Analysis ID to base the script on (its structure is borrowed, not its content)'),
      format: z.enum(['pov_demo', 'problem_solution', 'apps_that_feel_illegal', 'build_in_public', 'listicle'])
        .describe('App-promo format. When unsure: problem_solution for utility apps, pov_demo for visually striking ones.'),
      appDescription: z.string().describe('The user\'s app — what it does and for whom. This is what the script promotes.'),
      durationSec: z.number().min(10).max(60).optional().describe('Target runtime in seconds (default 20).'),
    },
    async ({ analysisId, format, appDescription, durationSec }) => {
      const workspace = await requireWorkspace();
      const opId = randomUUID();
      try {
        await debitCredits(workspace.id, CREDIT_COSTS.generateScript, 'generate_script', `${opId}:preauth`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        throw err;
      }

      try {
        const result = await generateScript(analysisId, { format, appDescription, durationSec });
        const balance = await creditBalance(workspace.id);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: `Script generated (${format})`,
            id: result.id,
            script: result.script,
            creditsCharged: CREDIT_COSTS.generateScript,
            creditsRemaining: balance.total,
            cost: costBlock(CREDIT_COSTS.generateScript, { remaining: balance.total }),
          }, null, 2) }],
        };
      } catch (err) {
        const balance = await refundCredits(workspace.id, CREDIT_COSTS.generateScript, 'generate_script', `${opId}:fail`, 'call_failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Script generation failed',
            message: (err as Error).message,
            creditsCharged: 0,
            creditsRemaining: balance.total,
            cost: costBlock(0, { remaining: balance.total, note: 'Call failed — pre-auth refunded, nothing charged.' }),
          }) }],
          isError: true,
        };
      }
    });

  server.tool('get_script',
    'Get a generated script by ID.',
    { scriptId: z.string() },
    async ({ scriptId }) => {
      const script = await db.script.findUnique({
        where: { id: scriptId },
        include: { analysis: { select: { videoId: true } } },
      });
      if (!script) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Script not found' }) }], isError: true };

      return { content: [{ type: 'text' as const, text: JSON.stringify({ ...script, script: JSON.parse(script.scriptJson) }, null, 2) }] };
    });

  // ============ IDEAS ============

  server.tool('list_ideas',
    'List idea cards. Filter by status.',
    {
      status: z.enum(['new', 'briefed', 'tested', 'archived']).optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ status, limit }) => {
      const workspace = await requireWorkspace();
      const ideas = await db.idea.findMany({
        // Scoped like every other read — ideas hang off videos, and videos
        // hang off this workspace's sources. Unscoped, one account's ideas
        // leaked into another's list.
        where: { status: status ?? undefined, video: { source: { workspaceId: workspace.id } } },
        include: {
          video: { select: { id: true, url: true, creatorHandle: true, caption: true, platform: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(ideas, null, 2) }] };
    });

  server.tool('get_idea_queue',
    'The posting queue: idea cards ordered by planned post date, grouped into overdue / next7Days / later / '
      + 'unscheduled. This is the "what should I post today" answer — cadence is the #1 growth lever for app-promo '
      + 'accounts. Free.',
    {
      horizonDays: z.number().min(1).max(60).default(7)
        .describe('Size of the "next" window in days (default 7).'),
    },
    async ({ horizonDays }) => {
      const workspace = await requireWorkspace();
      const ideas = await db.idea.findMany({
        where: { status: { not: 'archived' }, video: { source: { workspaceId: workspace.id } } },
        include: {
          video: { select: { id: true, url: true, creatorHandle: true, platform: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      });

      const now = Date.now();
      const horizon = now + horizonDays * 24 * 60 * 60 * 1000;
      const withDue = ideas.map((idea) => {
        const dueMs = idea.dueAt ? idea.dueAt.getTime() : null;
        return {
          id: idea.id,
          transferablePattern: idea.transferablePattern,
          adaptation: idea.adaptation,
          status: idea.status,
          dueAt: idea.dueAt?.toISOString() ?? null,
          // Negative = overdue. Null when unscheduled.
          daysUntilDue: dueMs != null ? Math.round((dueMs - now) / (24 * 60 * 60 * 1000) * 10) / 10 : null,
          video: idea.video,
        };
      });

      const pick = (fn: (d: number | null) => boolean) => withDue.filter(i => fn(i.daysUntilDue))
        .sort((a, b) => (a.daysUntilDue ?? Infinity) - (b.daysUntilDue ?? Infinity));

      const overdue = pick(d => d != null && d < 0);
      const next = pick(d => d != null && d >= 0 && d <= horizonDays);
      const later = pick(d => d != null && d > horizonDays);
      const unscheduled = pick(d => d == null);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          overdue,
          [`next${horizonDays}Days`]: next,
          later,
          unscheduled,
          counts: {
            overdue: overdue.length,
            next: next.length,
            later: later.length,
            unscheduled: unscheduled.length,
          },
          note: 'Recommend ONE thing to post today: the oldest overdue idea, else the earliest scheduled, else the '
            + 'strongest unscheduled one (and offer to schedule it via update_idea_status dueAt).',
        }, [
          unscheduled.length > 0 ? {
            label: 'Schedule an idea',
            tool: 'update_idea_status',
            args: { ideaId: unscheduled[0]!.id, status: unscheduled[0]!.status },
            why: 'Free. Pass dueAt to give it a post date — a dated queue is what keeps cadence honest.',
          } : null,
        ]), null, 2) }],
      };
    });

  server.tool('create_idea',
    'Create an idea card from an analyzed video. Ideas bridge research and production.',
    {
      analysisId: z.string(),
      transferablePattern: z.string().describe('The transferable concept stated generically'),
      whyItWorked: z.string().describe('Why it worked, from the analysis'),
      adaptation: z.string().describe('How to adapt for your brand context'),
      dueAt: z.string().optional().describe('ISO date — when the user plans to POST this. Turns the idea into a posting commitment.'),
    },
    async ({ analysisId, transferablePattern, whyItWorked, adaptation, dueAt }) => {
      const analysis = await db.analysis.findUnique({ where: { id: analysisId } });
      if (!analysis) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Analysis not found' }) }], isError: true };

      const idea = await db.idea.create({
        data: {
          videoId: analysis.videoId, analysisId, transferablePattern, whyItWorked, adaptation,
          ...(dueAt ? { dueAt: new Date(dueAt) } : {}),
        },
      });

      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Idea created', idea }, null, 2) }] };
    });

  server.tool('update_idea_status',
    'Update an idea card status (new → briefed → tested → archived), and/or reschedule its planned post date.',
    {
      ideaId: z.string(),
      status: z.enum(['new', 'briefed', 'tested', 'archived']).optional(),
      dueAt: z.string().nullable().optional()
        .describe('New planned post date (ISO), or null to unschedule.'),
    },
    async ({ ideaId, status, dueAt }) => {
      const idea = await db.idea.update({
        where: { id: ideaId },
        data: {
          ...(status ? { status } : {}),
          ...(dueAt !== undefined ? { dueAt: dueAt === null ? null : new Date(dueAt) } : {}),
        },
      }).catch(() => null);
      if (!idea) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Idea not found' }) }], isError: true };
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Idea updated', ideaId: idea.id, status: idea.status, dueAt: idea.dueAt?.toISOString() ?? null }) }] };
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
            cost: costBlock(CREDIT_COSTS.createBrief, { remaining: balance.total }),
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
            cost: costBlock(0, { remaining: balance.total, note: 'Call failed — pre-auth refunded, nothing charged.' }),
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