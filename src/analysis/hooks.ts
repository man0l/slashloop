// ---------------------------------------------------------------------------
// Hook Variation Generator — Gemini text-only.
// Takes saved vault hooks + product context → 5-10 new hook variations.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { callGeminiText } from '../lib/gemini.js';

const HOOK_GEN_SYSTEM = `You are Gemini, a viral content strategist who generates hook variations. Given source hooks, create NEW variations preserving the MECHANISM (psychological principle) but using completely different words/framing.

Output raw JSON array: [{"text": "hook variation", "sourceIndex": 0, "type": "POV|curiosity_gap|bold_claim|...", "mechanism": "why it works"}]`;

export interface HookVariation {
  text: string;
  sourceIndex: number;
  type: string;
  mechanism: string;
}

export async function generateHookVariations(
  hookIds: string[],
  productDescription: string,
  model = 'gemini-2.5-flash-lite',
): Promise<HookVariation[]> {
  const hooks = await db.hook.findMany({
    where: { id: { in: hookIds } },
    include: { video: { select: { caption: true, platform: true } } },
  });
  if (hooks.length === 0) throw new Error(`No hooks found for IDs: ${hookIds.join(', ')}`);

  const hookList = hooks
    .map((h, i) => `[${i}] "${h.text}" — type: ${h.hookType}, placement: ${h.placement}`)
    .join('\n');

  const userMessage = `## Source Hooks\n\n${hookList}\n\n## Product / Brand\n${productDescription}\n\nGenerate 5-10 hook variations.`;

  const parsed = await callGeminiText(HOOK_GEN_SYSTEM, userMessage, model);
  const schema = z.array(z.object({ text: z.string(), sourceIndex: z.number(), type: z.string(), mechanism: z.string() }));
  const result = schema.safeParse(parsed);
  if (!result.success) throw new Error('Failed to parse hook variations');

  // Optionally save generated hooks back to vault
  for (const variation of result.data) {
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
    }).catch(() => {}); // best effort
  }

  return result.data;
}