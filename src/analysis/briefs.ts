// ---------------------------------------------------------------------------
// Brief Generator — Gemini text-only pass.
// Takes an analysis JSON and optional brand context → UGC/ad brief.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { BriefDataSchema, type BriefData } from './schema.js';
import type { BriefResult } from './types.js';
import { callGeminiText } from '../lib/gemini.js';

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
    const parsed = await callGeminiText(BRIEF_SYSTEM, userMessage, model);
    const result = BriefDataSchema.safeParse(parsed);
    if (result.success) { briefData = result.data; break; }
    if (attempt === 0) continue;
    throw new Error(`Brief validation failed after 2 attempts`);
  }

  const saved = await db.brief.create({ data: { analysisId, briefJson: JSON.stringify(briefData) } });

  const workspaceId = analysis.video?.source?.workspaceId;
  if (workspaceId) {
    await db.usageLog.create({ data: { workspaceId, kind: 'ai', provider: 'google', units: 1, costCents: 1, refId: saved.id } }).catch(() => {});
  }

  return { id: saved.id, brief: briefData };
}