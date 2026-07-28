// ---------------------------------------------------------------------------
// MCP Tools: Hook Vault + Hook Generator
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { generateHookVariations } from '../analysis/hooks.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, insufficientCreditsPayload, creditBalance } from '../lib/credits.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerHookTools(server: McpServer) {

  // ---- list_hooks ----
  server.tool('list_hooks',
    'Browse the Hook Vault. Filter by hook type, niche, origin, or search text.',
    {
      hookType: z.string().optional(),
      nicheTag: z.string().optional(),
      origin: z.enum(['extracted', 'generated']).optional(),
      search: z.string().optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ hookType, nicheTag, origin, search, limit }) => {
      const where: any = {};
      if (hookType) where.hookType = hookType;
      if (nicheTag) where.nicheTag = nicheTag;
      if (origin) where.origin = origin;
      if (search) where.text = { contains: search };

      const hooks = await db.hook.findMany({
        where,
        include: {
          video: { select: { id: true, url: true, creatorHandle: true, platform: true, views: true } },
          analysis: { select: { analysisBasis: true, backend: true } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          hooks: hooks.map(h => ({
            id: h.id,
            text: h.text,
            hookType: h.hookType,
            placement: h.placement,
            origin: h.origin,
            nicheTag: h.nicheTag,
            video: { id: h.video.id, url: h.video.url, creator: h.video.creatorHandle, platform: h.video.platform, views: h.video.views },
            analysisBasis: h.analysis?.analysisBasis ?? null,
            backend: h.analysis?.backend ?? null,
            createdAt: h.createdAt.toISOString(),
          })),
          count: hooks.length,
        }, null, 2) }],
      };
    });

  // ---- extract_hook ----
  server.tool('extract_hook',
    'Extract a hook from an AI-analyzed video into the Hook Vault. HARD RULE: caption-only analyses cannot produce vault entries.',
    {
      analysisId: z.string().describe('Analysis ID (must be from a video+transcript or frames+transcript analysis)'),
    },
    async ({ analysisId }) => {
      const analysis = await db.analysis.findUnique({
        where: { id: analysisId },
        include: { video: true },
      });
      if (!analysis) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Analysis not found' }) }], isError: true };

      // Hard rule: caption-only analyses cannot produce vault entries
      const blockedBases = ['thumbnail+caption', 'caption+metadata-only'];
      if (blockedBases.includes(analysis.analysisBasis)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'BLOCKED: Cannot extract hook from caption-only analysis.',
            reason: 'The hook extraction rule requires the analysis to be based on video, transcript, or frames. Caption-only analyses cannot verify whether the hook was actually spoken or visible on-screen.',
            analysisBasis: analysis.analysisBasis,
            rule: 'Written post captions are NOT hooks unless the AI explicitly identified them as spoken or on-screen.',
          }) }],
          isError: true,
        };
      }

      const parsed = JSON.parse(analysis.analysisJson);
      const hookData = parsed.hook;
      if (!hookData?.text) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No hook found in analysis JSON' }) }], isError: true };
      }

      // Check for duplicate
      const existing = await db.hook.findFirst({
        where: { videoId: analysis.videoId, text: hookData.text },
      });
      if (existing) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ message: 'Hook already exists in vault', hookId: existing.id }) }] };
      }

      const hook = await db.hook.create({
        data: {
          analysisId: analysis.id,
          videoId: analysis.videoId,
          text: hookData.text,
          hookType: hookData.type,
          placement: hookData.placement ?? 'spoken',
          origin: 'extracted',
          nicheTag: analysis.video.caption.includes('skincare') || analysis.video.caption.includes('skin') ? 'skincare'
            : analysis.video.caption.includes('fitness') || analysis.video.caption.includes('workout') ? 'fitness'
            : null,
        },
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          message: 'Hook extracted to vault',
          hook: { id: hook.id, text: hook.text, type: hook.hookType, placement: hook.placement },
          analysisBasis: analysis.analysisBasis,
        }, null, 2) }],
      };
    });

  // ---- generate_hook_variations ----
  server.tool('generate_hook_variations',
    'Generate new hook variations from saved vault hooks. Preserves the MECHANISM of the original, not the words. Costs 2 credits.',
    {
      hookIds: z.array(z.string()).min(1).max(5).describe('1-5 hook IDs from the vault to vary'),
      productDescription: z.string().describe('Your product/niche/offer description for contextual adaptation'),
    },
    async ({ hookIds, productDescription }) => {
      const workspace = await requireWorkspace();
      const opId = randomUUID();
      try {
        await debitCredits(workspace.id, CREDIT_COSTS.generateHookVariations, 'generate_hook_variations', `${opId}:preauth`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        throw err;
      }

      try {
        const variations = await generateHookVariations(hookIds, productDescription);
        const balance = await creditBalance(workspace.id);

        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            message: `${variations.length} hook variations generated and saved to vault`,
            variations,
            note: 'Variations are automatically saved to the Hook Vault with origin="generated".',
            creditsCharged: CREDIT_COSTS.generateHookVariations,
            creditsRemaining: balance.total,
          }, null, 2) }],
        };
      } catch (err) {
        const balance = await refundCredits(workspace.id, CREDIT_COSTS.generateHookVariations, 'generate_hook_variations', `${opId}:fail`, 'call_failed');
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            error: 'Hook generation failed',
            message: (err as Error).message,
            creditsCharged: 0,
            creditsRemaining: balance.total,
          }) }],
          isError: true,
        };
      }
    });
}