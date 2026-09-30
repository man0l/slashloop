// ---------------------------------------------------------------------------
// Hook Variation Generator — Gemini text-only.
// Takes saved vault hooks + product context → 5-10 new hook variations.
// The MCP tool does not call generateHookVariations. It reserves a batch
// row through deliverHookVariations so a dropped response can be replayed.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { chunked } from '../store.js';
import { callModelText, modelJson } from '../lib/llm.js';

const HOOK_GEN_SYSTEM = `You are Gemini, a viral content strategist who generates hook variations. Given source hooks, create NEW variations preserving the MECHANISM (psychological principle) but using completely different words/framing.

Output raw JSON array: [{"text": "hook variation", "sourceIndex": 0, "type": "POV|curiosity_gap|bold_claim|...", "mechanism": "why it works"}]`;

const variationSchema = z.array(z.object({
  text: z.string(),
  sourceIndex: z.number(),
  type: z.string(),
  mechanism: z.string(),
}));

export interface HookVariation {
  text: string;
  sourceIndex: number;
  type: string;
  mechanism: string;
}

export interface SourceHook {
  id: string;
  text: string;
  hookType: string;
  placement: string;
  videoId: string;
  analysisId: string | null;
  nicheTag: string | null;
  workspaceId: string;
}

/** Chunked: D1 caps bound parameters at ~100. The video read is a join. */
export async function loadSourceHooks(hookIds: string[]): Promise<SourceHook[]> {
  const hooks: SourceHook[] = [];
  await chunked([...new Set(hookIds)], async (chunk) => {
    if (!chunk.length) return;
    const part = await db.hook.findMany({
      where: { id: { in: chunk } },
      include: { video: { select: { source: { select: { workspaceId: true } } } } },
    });
    for (const hook of part) {
      hooks.push({
        id: hook.id,
        text: hook.text,
        hookType: hook.hookType,
        placement: hook.placement,
        videoId: hook.videoId,
        analysisId: hook.analysisId,
        nicheTag: hook.nicheTag,
        workspaceId: hook.video.source.workspaceId,
      });
    }
  });
  return hooks;
}

export async function requestHookVariations(
  hooks: SourceHook[],
  productDescription: string,
  model = 'gemini-3.5-flash',
): Promise<HookVariation[]> {
  const hookList = hooks
    .map((h, i) => `[${i}] "${h.text}" — type: ${h.hookType}, placement: ${h.placement}`)
    .join('\n');
  const userMessage = `## Source Hooks\n\n${hookList}\n\n## Product / Brand\n${productDescription}\n\nGenerate 5-10 hook variations.`;
  const envelope = await callModelText(HOOK_GEN_SYSTEM, userMessage, model);
  const result = variationSchema.safeParse(modelJson(envelope));
  if (!result.success) throw new Error('Failed to parse hook variations');
  return result.data;
}

/**
 * Direct helper. MCP calls deliverHookVariations instead, which reserves
 * one batch id and does not charge a replay.
 */
export async function generateHookVariations(
  hookIds: string[],
  productDescription: string,
  model = 'gemini-3.5-flash',
): Promise<HookVariation[]> {
  const hooks = await loadSourceHooks(hookIds);
  if (hooks.length === 0) throw new Error(`No hooks found for IDs: ${hookIds.join(', ')}`);

  const result = await requestHookVariations(hooks, productDescription, model);

  for (const variation of result) {
    const sourceHook = hooks[variation.sourceIndex];
    if (!sourceHook) continue;
    await db.hook.create({
      data: {
        videoId: sourceHook.videoId,
        text: variation.text,
        hookType: variation.type || sourceHook.hookType,
        placement: sourceHook.placement,
        origin: 'generated',
        nicheTag: sourceHook.nicheTag,
      },
    }).catch(() => {});
  }

  return result;
}
