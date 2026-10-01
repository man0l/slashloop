// ---------------------------------------------------------------------------
// MCP Tools: Swipe Boards, Ideas, Briefs
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { chunked } from '../store.js';
import { workspaceIdField, resolveToolWorkspace } from './workspace-param.js';
import { BriefGenerationError, deliverBrief, type BriefDelivery } from '../analysis/briefs.js';
import {
  briefFailurePayload,
  briefGeneratingPayload,
  indexLatestBriefs,
  readStoredBrief,
  toBriefListItem,
} from '../analysis/brief-delivery.js';
import {
  deliverScript,
  indexLatestScripts,
  logicalScriptId,
  normalizeScriptDuration,
  readStoredScript,
  ScriptGenerationError,
  scriptFailurePayload,
  scriptGeneratingPayload,
  toScriptListItem,
  type ScriptDelivery,
} from '../analysis/script-delivery.js';
import { CREDIT_COSTS, InsufficientCreditsError, insufficientCreditsPayload, refundCredits } from '../lib/credits.js';
import { mergedAbortSignal, runPreauthed } from '../lib/preauth.js';
import { costBlock, withNextSteps } from '../lib/next-steps.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function reservedBriefId(error: unknown, value: unknown): string | null {
  if (error instanceof BriefGenerationError && error.briefId) return error.briefId;
  if (!value || typeof value !== 'object') return null;
  const delivery = value as Partial<BriefDelivery>;
  if (delivery.delivery === 'generating' && typeof delivery.id === 'string') return delivery.id;
  if (delivery.delivery === 'ready' && delivery.result && typeof delivery.result.id === 'string') return delivery.result.id;
  return null;
}

function reservedScriptId(error: unknown, value: unknown): string | null {
  if (error instanceof ScriptGenerationError && error.scriptId) return error.scriptId;
  if (!value || typeof value !== 'object') return null;
  const delivery = value as Partial<ScriptDelivery>;
  if (delivery.delivery === 'generating' && typeof delivery.id === 'string') return delivery.id;
  if (delivery.delivery === 'ready' && delivery.result && typeof delivery.result.id === 'string') return delivery.result.id;
  return null;
}

function scriptToolError(message: string, scriptId: string | null, creditsRemaining: number | null) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ...scriptFailurePayload({ message, scriptId, creditsRemaining }),
        cost: costBlock(0, {
          ...(creditsRemaining != null ? { remaining: creditsRemaining } : {}),
          note: 'Call failed — pre-auth refunded, nothing charged.',
        }),
      }, null, 2),
    }],
    isError: true as const,
  };
}

function briefToolError(message: string, briefId: string | null, creditsRemaining: number | null) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ...briefFailurePayload({ message, briefId, creditsRemaining }),
        cost: costBlock(0, {
          ...(creditsRemaining != null ? { remaining: creditsRemaining } : {}),
          note: 'Call failed — pre-auth refunded, nothing charged.',
        }),
      }, null, 2),
    }],
    isError: true as const,
  };
}

export function registerCreativeTools(server: McpServer) {

  // ============ BOARDS ============

  server.tool('list_boards',
    'List all swipe file boards.',
    { workspaceId: workspaceIdField },
    async ({ workspaceId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      // No `_count` include: Prisma's D1 adapter fans those into concurrent
      // prepared statements, which hang the binding. Same JSON shape as before.
      const boards = await db.board.findMany({
        where: { workspaceId: workspace.id },
        orderBy: { createdAt: 'desc' },
      });
      const swipeCountByBoard = new Map<string, number>();
      await chunked(boards.map((b) => b.id), async (ids) => {
        const rows = await db.swipeEntry.groupBy({
          by: ['boardId'],
          where: { boardId: { in: ids } },
          _count: { _all: true },
        });
        for (const row of rows) swipeCountByBoard.set(row.boardId, row._count._all);
      });
      const payload = boards.map((b) => ({
        ...b,
        _count: { swipeEntries: swipeCountByBoard.get(b.id) ?? 0 },
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
    });

  server.tool('get_board',
    'Get a swipe board with all its entries.',
    { workspaceId: workspaceIdField, boardId: z.string() },
    async ({ workspaceId, boardId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const board = await db.board.findFirst({
        where: { id: boardId, workspaceId: workspace.id },
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
    { workspaceId: workspaceIdField, name: z.string().describe('Board name') },
    async ({ workspaceId, name }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });

      const board = await db.board.create({ data: { workspaceId: workspace.id, name } });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Board created', board }, null, 2) }] };
    });

  server.tool('save_to_board',
    'Save a video (with optional analysis snapshot) to a swipe board.',
    {
      workspaceId: workspaceIdField,
      boardId: z.string(),
      videoId: z.string(),
      notes: z.string().optional().describe('Free-text notes for this entry'),
    },
    async ({ workspaceId, boardId, videoId, notes }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const board = await db.board.findFirst({ where: { id: boardId, workspaceId: workspace.id }, select: { id: true } });
      if (!board) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Board not found' }) }], isError: true };
      const video = await db.video.findFirst({ where: { id: videoId, source: { workspaceId: workspace.id } }, select: { id: true } });
      if (!video) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Video not found' }) }], isError: true };
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
    { workspaceId: workspaceIdField, boardId: z.string() },
    async ({ workspaceId, boardId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const board = await db.board.findFirst({
        where: { id: boardId, workspaceId: workspace.id },
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
      + 'caption and hashtags. Costs 2 credits. The script id is reserved before the model call and is in every response. '
      + 'An identical replay returns that id and does not charge again. If the response is lost, list_scripts by analysisId. '
      + 'A slow model returns status "generating"; poll get_script.',
    {
      workspaceId: workspaceIdField,
      analysisId: z.string().describe('Analysis ID to base the script on (its structure is borrowed, not its content)'),
      format: z.enum(['pov_demo', 'problem_solution', 'apps_that_feel_illegal', 'build_in_public', 'listicle'])
        .describe('App-promo format. When unsure: problem_solution for utility apps, pov_demo for visually striking ones.'),
      appDescription: z.string().describe('The user\'s app — what it does and for whom. This is what the script promotes.'),
      durationSec: z.number().min(10).max(60).optional().describe('Target runtime in seconds (default 20).'),
    },
    { readOnlyHint: false },
    async ({ workspaceId, analysisId, format, appDescription, durationSec }, extra) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const duration = normalizeScriptDuration(durationSec);
      const scriptId = logicalScriptId({
        workspaceId: workspace.id,
        analysisId,
        format,
        appDescription,
        durationSec: duration,
      });
      let metered;
      try {
        metered = await runPreauthed({
          workspaceId: workspace.id,
          credits: CREDIT_COSTS.generateScript,
          tool: 'generate_script',
          signal: mergedAbortSignal(extra),
          idempotencyKey: scriptId,
          run: () => deliverScript({
            id: scriptId,
            analysisId,
            workspaceId: workspace.id,
            format,
            appDescription,
            durationSec: duration,
            onLateFailure: async () => {
              await refundCredits(workspace.id, CREDIT_COSTS.generateScript, 'generate_script', `${scriptId}:fail`, 'call_failed');
            },
          }),
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        const message = err instanceof Error ? err.message : 'Script generation failed';
        return scriptToolError(message, reservedScriptId(err, null), null);
      }
      if (!metered.ok) {
        const failed = metered.error instanceof Error ? metered.error.message : 'Call aborted';
        return scriptToolError(failed, reservedScriptId(metered.error, metered.value), metered.balance.total);
      }
      const replayed = metered.creditsCharged === 0 || metered.value.replayed;
      if (metered.value.delivery === 'generating') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ...scriptGeneratingPayload({
              id: metered.value.id,
              creditsCharged: metered.creditsCharged,
              creditsRemaining: metered.balance.total,
              replayed,
            }),
            cost: costBlock(metered.creditsCharged, { remaining: metered.balance.total }),
          }, null, 2) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          message: replayed ? `Script already generated (${format}). This replay was not charged.` : `Script generated (${format})`,
          id: metered.value.result.id,
          scriptId: metered.value.result.id,
          status: 'ready',
          replayed,
          script: metered.value.result.script,
          creditsCharged: metered.creditsCharged,
          creditsRemaining: metered.balance.total,
          cost: costBlock(metered.creditsCharged, { remaining: metered.balance.total }),
        }, null, 2) }],
      };
    });

  server.tool('get_script',
    'Get a generated script by ID. status is ready, generating, or failed.',
    { workspaceId: workspaceIdField, scriptId: z.string() },
    async ({ workspaceId, scriptId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const script = await db.script.findFirst({
        where: { id: scriptId, analysis: { video: { source: { workspaceId: workspace.id } } } },
        include: { analysis: { select: { videoId: true } } },
      });
      if (!script) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Script not found' }) }], isError: true };

      const stored = readStoredScript(script.scriptJson);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        id: script.id,
        scriptId: script.id,
        analysisId: script.analysisId,
        videoId: script.analysis?.videoId ?? null,
        format: script.format,
        createdAt: script.createdAt,
        status: stored.status,
        script: stored.status === 'ready' ? stored.script : null,
        ...(stored.status === 'failed' ? { error: stored.error } : {}),
      }, null, 2) }] };
    });

  server.tool('list_scripts',
    'List generated scripts in this workspace, newest first. Free. Use this to recover a script id when generate_script was charged but the response was lost. Filter by analysisId, videoId, or format.',
    {
      workspaceId: workspaceIdField,
      analysisId: z.string().optional(),
      videoId: z.string().optional(),
      format: z.enum(['pov_demo', 'problem_solution', 'apps_that_feel_illegal', 'build_in_public', 'listicle']).optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ workspaceId, analysisId, videoId, format, limit }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const scripts = await db.script.findMany({
        where: {
          ...(analysisId ? { analysisId } : {}),
          ...(format ? { format } : {}),
          analysis: {
            ...(videoId ? { videoId } : {}),
            video: { source: { workspaceId: workspace.id } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          analysisId: true,
          format: true,
          scriptJson: true,
          createdAt: true,
          analysis: { select: { videoId: true } },
        },
      });
      const items = scripts.map((row) => toScriptListItem({
        id: row.id,
        analysisId: row.analysisId,
        format: row.format,
        createdAt: row.createdAt,
        videoId: row.analysis?.videoId ?? null,
        scriptJson: row.scriptJson,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ scripts: items, count: items.length }, null, 2) }] };
    });

  // ============ IDEAS ============

  server.tool('list_ideas',
    'List idea cards. Filter by status. Each card includes briefId/briefStatus and scriptId/scriptStatus for the latest brief and script on its analysis.',
    {
      workspaceId: workspaceIdField,
      status: z.enum(['new', 'briefed', 'tested', 'archived']).optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ workspaceId, status, limit }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
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
      const analysisIds = ideas.flatMap((idea) => idea.analysisId ? [idea.analysisId] : []);
      const refs = analysisIds.length === 0 ? new Map() : indexLatestBriefs(await db.brief.findMany({
        where: { analysisId: { in: analysisIds } },
        select: { id: true, analysisId: true, createdAt: true, briefJson: true },
        orderBy: { createdAt: 'desc' },
      }));
      const scriptRefs = analysisIds.length === 0 ? new Map() : indexLatestScripts(await db.script.findMany({
        where: { analysisId: { in: analysisIds } },
        select: { id: true, analysisId: true, createdAt: true, scriptJson: true },
        orderBy: { createdAt: 'desc' },
      }));
      const withBriefs = ideas.map((idea) => {
        const ref = idea.analysisId ? refs.get(idea.analysisId) : undefined;
        const scriptRef = idea.analysisId ? scriptRefs.get(idea.analysisId) : undefined;
        return {
          ...idea,
          briefId: ref?.briefId ?? null,
          briefStatus: ref?.briefStatus ?? null,
          scriptId: scriptRef?.scriptId ?? null,
          scriptStatus: scriptRef?.scriptStatus ?? null,
        };
      });
      return { content: [{ type: 'text' as const, text: JSON.stringify(withBriefs, null, 2) }] };
    });

  server.tool('get_idea_queue',
    'The posting queue: idea cards ordered by planned post date, grouped into overdue / next7Days / later / '
      + 'unscheduled. This is the "what should I post today" answer — cadence is the #1 growth lever for app-promo '
      + 'accounts. Free.',
    {
      workspaceId: workspaceIdField,
      horizonDays: z.number().min(1).max(60).default(7)
        .describe('Size of the "next" window in days (default 7).'),
    },
    async ({ workspaceId, horizonDays }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
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
      workspaceId: workspaceIdField,
      analysisId: z.string(),
      transferablePattern: z.string().describe('The transferable concept stated generically'),
      whyItWorked: z.string().describe('Why it worked, from the analysis'),
      adaptation: z.string().describe('How to adapt for your brand context'),
      dueAt: z.string().optional().describe('ISO date — when the user plans to POST this. Turns the idea into a posting commitment.'),
    },
    async ({ workspaceId, analysisId, transferablePattern, whyItWorked, adaptation, dueAt }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const analysis = await db.analysis.findFirst({
        where: { id: analysisId, video: { source: { workspaceId: workspace.id } } },
      });
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
      workspaceId: workspaceIdField,
      ideaId: z.string(),
      status: z.enum(['new', 'briefed', 'tested', 'archived']).optional(),
      dueAt: z.string().nullable().optional()
        .describe('New planned post date (ISO), or null to unschedule.'),
    },
    async ({ workspaceId, ideaId, status, dueAt }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const owned = await db.idea.findFirst({
        where: { id: ideaId, video: { source: { workspaceId: workspace.id } } },
        select: { id: true },
      });
      if (!owned) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Idea not found' }) }], isError: true };
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
    'Generate a UGC/ad brief from an analysis. Includes concept, hook, talking points, visual beats, and deliverable specs. Costs 2 credits. The brief id is reserved before the model call and is in every response. If the response is lost, list_briefs by analysisId. A slow model returns status "generating"; poll get_brief.',
    {
      workspaceId: workspaceIdField,
      analysisId: z.string(),
      brandContext: z.string().optional().describe('Brand/product context for adaptation'),
    },
    async ({ workspaceId, analysisId, brandContext }, extra) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const scopedBrief = await db.analysis.findFirst({
        where: { id: analysisId, video: { source: { workspaceId: workspace.id } } },
        select: { id: true },
      });
      if (!scopedBrief) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Analysis not found' }) }], isError: true };
      }
      let metered;
      try {
        metered = await runPreauthed({
          workspaceId: workspace.id,
          credits: CREDIT_COSTS.createBrief,
          tool: 'create_brief',
          signal: mergedAbortSignal(extra),
          run: () => deliverBrief({
            analysisId,
            workspaceId: workspace.id,
            brandContext,
            onLateFailure: async (briefId) => {
              await refundCredits(workspace.id, CREDIT_COSTS.createBrief, 'create_brief', `${briefId}:fail`, 'call_failed');
            },
          }),
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        const briefId = reservedBriefId(err, null);
        const message = err instanceof Error ? err.message : 'Brief generation failed';
        return briefToolError(message, briefId, null);
      }
      if (!metered.ok) {
        const failed = metered.error instanceof Error ? metered.error.message : 'Call aborted';
        return briefToolError(failed, reservedBriefId(metered.error, metered.value), metered.balance.total);
      }
      if (metered.value.delivery === 'generating') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ...briefGeneratingPayload({
              id: metered.value.id,
              creditsCharged: metered.creditsCharged,
              creditsRemaining: metered.balance.total,
            }),
            cost: costBlock(metered.creditsCharged, { remaining: metered.balance.total }),
          }, null, 2) }],
        };
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          message: 'Brief generated',
          id: metered.value.result.id,
          briefId: metered.value.result.id,
          status: 'ready',
          brief: metered.value.result.brief,
          creditsCharged: metered.creditsCharged,
          creditsRemaining: metered.balance.total,
          cost: costBlock(metered.creditsCharged, { remaining: metered.balance.total }),
        }, null, 2) }],
      };
    });

  server.tool('get_brief',
    'Get a brief by ID.',
    { workspaceId: workspaceIdField, briefId: z.string() },
    async ({ workspaceId, briefId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const brief = await db.brief.findFirst({
        where: { id: briefId, analysis: { video: { source: { workspaceId: workspace.id } } } },
        include: { analysis: { select: { videoId: true } }, idea: { select: { id: true } } },
      });
      if (!brief) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Brief not found' }) }], isError: true };

      const stored = readStoredBrief(brief.briefJson);
      return { content: [{ type: 'text' as const, text: JSON.stringify({
        ...brief,
        status: stored.status,
        brief: stored.status === 'ready' ? stored.brief : null,
        ...(stored.status === 'failed' ? { error: stored.error } : {}),
      }, null, 2) }] };
    });

  server.tool('list_briefs',
    'List creative briefs in this workspace, newest first. Free. Use this to recover a brief id when create_brief was charged but the response was lost. Filter by analysisId or videoId.',
    {
      workspaceId: workspaceIdField,
      analysisId: z.string().optional(),
      videoId: z.string().optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ workspaceId, analysisId, videoId, limit }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const briefs = await db.brief.findMany({
        where: {
          ...(analysisId ? { analysisId } : {}),
          analysis: {
            ...(videoId ? { videoId } : {}),
            video: { source: { workspaceId: workspace.id } },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          analysisId: true,
          ideaId: true,
          briefJson: true,
          createdAt: true,
          analysis: { select: { videoId: true } },
        },
      });
      const items = briefs.map((row) => toBriefListItem({
        id: row.id,
        analysisId: row.analysisId,
        ideaId: row.ideaId,
        createdAt: row.createdAt,
        videoId: row.analysis?.videoId ?? null,
        briefJson: row.briefJson,
      }));
      return { content: [{ type: 'text' as const, text: JSON.stringify({ briefs: items, count: items.length }, null, 2) }] };
    });

  server.tool('export_brief',
    'Export a brief as Markdown.',
    { workspaceId: workspaceIdField, briefId: z.string() },
    async ({ workspaceId, briefId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const brief = await db.brief.findFirst({
        where: { id: briefId, analysis: { video: { source: { workspaceId: workspace.id } } } },
      });
      if (!brief) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Brief not found' }) }], isError: true };

      const stored = readStoredBrief(brief.briefJson);
      if (stored.status !== 'ready') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: stored.status === 'generating' ? 'Brief is still generating' : 'Brief is not ready',
            id: brief.id,
            briefId: brief.id,
            status: stored.status,
            ...(stored.status === 'failed' ? { message: stored.error } : {}),
          }) }],
          isError: true,
        };
      }
      const b = stored.brief;
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