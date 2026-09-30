// ---------------------------------------------------------------------------
// MCP Tools: Hook Vault + Hook Generator
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { workspaceIdField, resolveToolWorkspace } from './workspace-param.js';
import {
  deliverHookVariations,
  HOOK_BATCH_TYPE,
  hookFailurePayload,
  hookGeneratingPayload,
  HookGenerationError,
  logicalHookBatchId,
  toHookBatchListItem,
  type HookDelivery,
} from '../analysis/hook-delivery.js';
import { CREDIT_COSTS, InsufficientCreditsError, insufficientCreditsPayload, refundCredits } from '../lib/credits.js';
import { mergedAbortSignal, runPreauthed } from '../lib/preauth.js';
import { costBlock } from '../lib/next-steps.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

function reservedBatchId(error: unknown, value: unknown): string | null {
  if (error instanceof HookGenerationError && error.batchId) return error.batchId;
  if (!value || typeof value !== 'object') return null;
  const delivery = value as Partial<HookDelivery>;
  if (delivery.delivery === 'generating' && typeof delivery.id === 'string') return delivery.id;
  if (delivery.delivery === 'ready' && typeof delivery.id === 'string') return delivery.id;
  return null;
}

function hookToolError(message: string, batchId: string | null, creditsRemaining: number | null) {
  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({
        ...hookFailurePayload({ message, batchId, creditsRemaining }),
        cost: costBlock(0, {
          ...(creditsRemaining != null ? { remaining: creditsRemaining } : {}),
          note: 'Call failed — pre-auth refunded, nothing charged.',
        }),
      }, null, 2),
    }],
    isError: true as const,
  };
}

export function registerHookTools(server: McpServer) {

  // ---- list_hooks ----
  server.tool('list_hooks',
    'Browse the Hook Vault. Filter by hook type, niche, origin, or search text.',
    {
      workspaceId: workspaceIdField,
      hookType: z.string().optional(),
      nicheTag: z.string().optional(),
      origin: z.enum(['extracted', 'generated']).optional(),
      // D1 50-byte LIKE/GLOB limit: cap user input so `contains` below never exceeds it.
      search: z.string().max(50).optional(),
      limit: z.number().min(1).max(100).default(30),
    },
    async ({ workspaceId, hookType, nicheTag, origin, search, limit }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const where: any = { video: { source: { workspaceId: workspace.id } } };
      // Batch rows are the generate_hook_variations reservation, not vault hooks.
      if (hookType) where.hookType = hookType;
      else where.hookType = { not: HOOK_BATCH_TYPE };
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
      workspaceId: workspaceIdField,
      analysisId: z.string().describe('Analysis ID (must be from a video+transcript or frames+transcript analysis)'),
    },
    async ({ workspaceId, analysisId }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const analysis = await db.analysis.findFirst({
        where: { id: analysisId, video: { source: { workspaceId: workspace.id } } },
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
    'Generate new hook variations from saved vault hooks. Preserves the MECHANISM of the original, not the words. '
      + 'Costs 2 credits. The batch id is reserved before the model call and is in every response. An identical '
      + 'replay returns that id and does not charge again. If the response is lost, list_hook_variations returns '
      + 'that id. A slow model returns status "generating"; call this tool again with the same arguments to poll.',
    {
      workspaceId: workspaceIdField,
      hookIds: z.array(z.string()).min(1).max(5).describe('1-5 hook IDs from the vault to vary'),
      productDescription: z.string().describe('Your product/niche/offer description for contextual adaptation'),
    },
    { readOnlyHint: false },
    async ({ workspaceId, hookIds, productDescription }, extra) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const ownedHooks = await db.hook.findMany({
        where: { id: { in: hookIds }, video: { source: { workspaceId: workspace.id } } },
        select: { id: true },
      });
      if (ownedHooks.length !== hookIds.length) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Hook not found' }) }], isError: true };
      }
      const batchId = logicalHookBatchId({
        workspaceId: workspace.id,
        hookIds,
        productDescription,
      });
      let metered;
      try {
        metered = await runPreauthed({
          workspaceId: workspace.id,
          credits: CREDIT_COSTS.generateHookVariations,
          tool: 'generate_hook_variations',
          signal: mergedAbortSignal(extra),
          idempotencyKey: batchId,
          run: () => deliverHookVariations({
            id: batchId,
            workspaceId: workspace.id,
            hookIds,
            productDescription,
            onLateFailure: async () => {
              await refundCredits(
                workspace.id,
                CREDIT_COSTS.generateHookVariations,
                'generate_hook_variations',
                `${batchId}:fail`,
                'call_failed',
              );
            },
          }),
        });
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        const message = err instanceof Error ? err.message : 'Hook generation failed';
        return hookToolError(message, reservedBatchId(err, null), null);
      }
      if (!metered.ok) {
        const failed = metered.error instanceof Error ? metered.error.message : 'Call aborted';
        return hookToolError(failed, reservedBatchId(metered.error, metered.value), metered.balance.total);
      }
      const replayed = metered.creditsCharged === 0 || metered.value.replayed;
      if (metered.value.delivery === 'generating') {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            ...hookGeneratingPayload({
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
          message: replayed
            ? `${metered.value.variations.length} hook variations already generated. This replay was not charged.`
            : `${metered.value.variations.length} hook variations generated and saved to vault`,
          id: metered.value.id,
          batchId: metered.value.id,
          status: 'ready',
          replayed,
          variations: metered.value.variations,
          note: 'Variations are saved to the Hook Vault with origin="generated".',
          creditsCharged: metered.creditsCharged,
          creditsRemaining: metered.balance.total,
          cost: costBlock(metered.creditsCharged, { remaining: metered.balance.total }),
        }, null, 2) }],
      };
    });

  // ---- list_hook_variations ----
  server.tool('list_hook_variations',
    'List generate_hook_variations batches in this workspace, newest first. Free. Use this to recover a batch id and its variations when generate_hook_variations was charged but the response was lost. Filter by batchId.',
    {
      workspaceId: workspaceIdField,
      batchId: z.string().optional().describe('Reserved batch id from generate_hook_variations'),
      limit: z.number().min(1).max(100).default(30),
    },
    { readOnlyHint: true },
    async ({ workspaceId, batchId, limit }) => {
      const workspace = await resolveToolWorkspace({ workspaceId });
      const rows = await db.hook.findMany({
        where: {
          hookType: HOOK_BATCH_TYPE,
          ...(batchId ? { id: batchId } : {}),
          video: { source: { workspaceId: workspace.id } },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: {
          id: true,
          videoId: true,
          analysisId: true,
          text: true,
          createdAt: true,
        },
      });
      const batches = rows.map((row) => toHookBatchListItem(row));
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ batches, count: batches.length }, null, 2) }],
      };
    });
}