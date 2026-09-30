// ---------------------------------------------------------------------------
// Brief Generator — Gemini text-only pass.
// Takes an analysis JSON and optional brand context → UGC/ad brief.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { db } from '../db.js';
import { hasWaitUntil, keepAlive } from '../cf/wait-until.js';
import { BriefDataSchema, type BriefData } from './schema.js';
import type { BriefResult } from './types.js';
import { callModelText } from '../lib/llm.js';
import {
  BRIEF_INLINE_BUDGET_MS,
  failedBriefJson,
  generatingBriefJson,
  raceBudget,
} from './brief-delivery.js';

export class BriefGenerationError extends Error {
  constructor(message: string, readonly briefId: string | null) {
    super(message);
    this.name = 'BriefGenerationError';
  }
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Brief generation failed';
}

const BRIEF_SYSTEM = `You are Gemini, a UGC/ad creative director who turns viral video analyses into actionable creative briefs. Given an analysis, produce a brief a UGC creator can follow.

Output raw JSON only:
{
  "concept": "1 paragraph — the core idea reimagined for the brand",
  "hook": "adapted hook preserving the MECHANISM, not the words",
  "creatorDirection": "tone, setting, delivery style, props",
  "talkingPoints": ["point 1", "point 2", "point 3"],
  "visualBeats": [{"timestampSec": 0, "description": "opening shot"}],
  "whatNotToCopy": ["brand-specific element", "unrepeatable element"],
  "deliverableSpecs": { "length": "15-30 seconds", "format": "vertical 9:16", "platform": "tiktok" }
}`;

export async function generateBrief(
  analysisId: string,
  brandContext?: string,
  model = 'gemini-3.5-flash',
  existingBriefId?: string,
): Promise<BriefResult> {
  const analysis = await db.analysis.findUnique({
    where: { id: analysisId },
    include: { video: { include: { source: { select: { workspaceId: true } } } } },
  });
  if (!analysis) throw new Error(`Analysis not found: ${analysisId}`);

  const brandSection = brandContext ? `\n## Brand Context\n${brandContext}` : '';
  const userMessage = `## Viral Video Analysis\n\n${analysis.analysisJson}\n${brandSection}\n\nGenerate a creative brief.`;

  let briefData!: BriefData;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = await callModelText(BRIEF_SYSTEM, userMessage, model);
    const result = BriefDataSchema.safeParse(parsed);
    if (result.success) { briefData = result.data; break; }
    if (attempt === 0) continue;
    throw new Error(`Brief validation failed after 2 attempts`);
  }

  const briefJson = JSON.stringify(briefData);
  const saved = existingBriefId
    ? await db.brief.update({ where: { id: existingBriefId }, data: { briefJson } })
    : await db.brief.create({ data: { analysisId, briefJson } });

  const workspaceId = analysis.video?.source?.workspaceId;
  if (workspaceId) {
    await db.usageLog.create({ data: { workspaceId, kind: 'ai', provider: 'google', units: 1, costCents: 1, refId: saved.id } }).catch(() => {});
  }

  return { id: saved.id, brief: briefData };
}

export type BriefDelivery =
  | { delivery: 'ready'; result: BriefResult }
  | { delivery: 'generating'; id: string };

async function markBriefFailed(id: string, error: unknown): Promise<void> {
  await db.brief.update({
    where: { id },
    data: { briefJson: failedBriefJson(errorText(error)) },
  }).catch(() => {});
}

/**
 * Reserve a brief id, then generate. The id exists before the model call.
 * When generation exceeds the inline budget, the row stays `generating` and
 * the model call is pinned with waitUntil so the HTTP response can leave
 * with the id instead of dying as a 502.
 */
export async function deliverBrief(opts: {
  analysisId: string;
  workspaceId: string;
  brandContext?: string;
  model?: string;
  budgetMs?: number;
  onLateFailure?: (briefId: string, error: unknown) => Promise<void>;
}): Promise<BriefDelivery> {
  const owned = await db.analysis.findFirst({
    where: { id: opts.analysisId, video: { source: { workspaceId: opts.workspaceId } } },
    select: { id: true },
  });
  if (!owned) throw new BriefGenerationError(`Analysis not found: ${opts.analysisId}`, null);

  const id = randomUUID();
  await db.brief.create({
    data: { id, analysisId: opts.analysisId, briefJson: generatingBriefJson() },
  });

  const work = generateBrief(opts.analysisId, opts.brandContext, opts.model, id).then(
    (result) => ({ ok: true as const, result }),
    (error: unknown) => ({ ok: false as const, error }),
  );

  const raced = await raceBudget(work, opts.budgetMs ?? BRIEF_INLINE_BUDGET_MS);
  if (raced.kind === 'done') {
    if (!raced.value.ok) {
      await markBriefFailed(id, raced.value.error);
      throw new BriefGenerationError(errorText(raced.value.error), id);
    }
    return { delivery: 'ready', result: raced.value.result };
  }

  if (hasWaitUntil()) {
    keepAlive(work.then(async (settled) => {
      if (settled.ok) return;
      try {
        await markBriefFailed(id, settled.error);
        await opts.onLateFailure?.(id, settled.error);
      } catch (err) {
        console.error(`create_brief late failure ${id}: ${errorText(err)}`);
      }
    }));
    return { delivery: 'generating', id };
  }

  const settled = await work;
  if (!settled.ok) {
    await markBriefFailed(id, settled.error);
    throw new BriefGenerationError(errorText(settled.error), id);
  }
  return { delivery: 'ready', result: settled.result };
}