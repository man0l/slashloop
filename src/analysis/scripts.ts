// ---------------------------------------------------------------------------
// Script Generator — Gemini text-only pass.
//
// Turns a viral-video analysis into a ready-to-shoot script for the USER'S
// OWN app, in a format proven to work for app promotion on TikTok. The
// audience is app builders (not UGC clients), so the prompt always asks for
// the user's app to be the subject — an analysis of someone else's video is
// the evidence base, never the content.
//
// Mirrors briefs.ts: one text call, zod-validated with one retry, persisted
// as JSON, usage-logged against the analysis's workspace.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { ScriptDataSchema, SCRIPT_FORMATS, type ScriptData, type ScriptFormat } from './schema.js';
import { callModelText } from '../lib/llm.js';

/** Per-format direction. Kept terse — the model also has the analysis. */
const FORMAT_DIRECTIONS: Record<ScriptFormat, string> = {
  pov_demo:
    'POV-style screen recording: first-person "POV: you found an app that ..." framing. '
    + 'The phone screen IS the video; cuts land on feature reveals.',
  problem_solution:
    'Open on the pain in one relatable sentence, show the app solving it inside 5 seconds, '
    + 'then one proof beat (result, number, or before/after).',
  apps_that_feel_illegal:
    '"Apps that feel illegal to know" energy: fast-paced, slightly conspiratorial tone, '
    + 'the app framed as an unfair advantage. Rapid screen-recording cuts, text overlays doing the talking.',
  build_in_public:
    'Founder voice, face or voiceover over build footage/metrics. Show real progress or numbers, '
    + 'be specific and honest; CTA is follow/waitlist/try it, not hype.',
  listicle:
    'Countdown framing ("3 apps that ...") where the user\'s app is positioned as the best of the list '
    + '(usually last). Each item gets ~4 seconds and one concrete benefit.',
};

const SCRIPT_SYSTEM = `You are Gemini, a short-form scriptwriter who turns proven viral structures into shootable scripts for indie app developers promoting their own apps.

Given a viral video analysis (the EVIDENCE) and the user's app description (the SUBJECT), write a script for their app in the requested format.

Hard rules:
- The script promotes the USER'S APP, not the analyzed video's subject. Borrow structure, pacing and hook mechanics — never the other video's content.
- The hook must work in the first 2 seconds and be written word-for-word.
- Beats must be concrete enough to shoot without further decisions: name what is on screen (screen recording, selfie, b-roll) and what is said.
- Total runtime should fit the requested duration (roughly 2.5 words per second of voiceover).
- The caption is ready to paste; hashtags are niche-relevant, under 1M uses preferred, 3-5 of them.

Output raw JSON only:
{
  "format": "<the requested format id>",
  "hook": "word-for-word opening line",
  "beats": [{"timestampSec": 0, "voiceover": "...", "onScreenText": "...", "visual": "..."}],
  "cta": "closing line + what happens on screen",
  "caption": "ready-to-paste caption",
  "hashtags": ["#tag"],
  "whyThisWorks": "one sentence on why this structure converts for an app"
}`;

export interface GenerateScriptOptions {
  format: ScriptFormat;
  /** The user's app — what it does, for whom. The script's subject. */
  appDescription: string;
  /** Target runtime in seconds (default 20). */
  durationSec?: number;
}

export interface ScriptResult {
  id: string;
  script: ScriptData;
}

export async function generateScript(
  analysisId: string,
  opts: GenerateScriptOptions,
  model = 'gemini-3.5-flash',
): Promise<ScriptResult> {
  const analysis = await db.analysis.findUnique({
    where: { id: analysisId },
    include: { video: { include: { source: { select: { workspaceId: true } } } } },
  });
  if (!analysis) throw new Error(`Analysis not found: ${analysisId}`);

  const durationSec = Math.min(60, Math.max(10, Math.round(opts.durationSec ?? 20)));
  const userMessage = [
    '## Viral Video Analysis (evidence — borrow the structure, not the content)\n',
    analysis.analysisJson,
    `\n## The App (subject of the script)\n${opts.appDescription}`,
    `\n## Format\n${opts.format}: ${FORMAT_DIRECTIONS[opts.format]}`,
    `\nTarget runtime: ${durationSec} seconds.`,
    '\nWrite the script.',
  ].join('\n');

  let script!: ScriptData;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = await callModelText(SCRIPT_SYSTEM, userMessage, model);
    const result = ScriptDataSchema.safeParse(parsed);
    if (result.success) {
      // Trust the caller's format id over whatever the model echoed back.
      script = { ...result.data, format: opts.format };
      break;
    }
    if (attempt === 0) continue;
    throw new Error('Script validation failed after 2 attempts');
  }

  const saved = await db.script.create({
    data: { analysisId, format: opts.format, scriptJson: JSON.stringify(script) },
  });

  const workspaceId = analysis.video?.source?.workspaceId;
  if (workspaceId) {
    await db.usageLog.create({ data: { workspaceId, kind: 'ai', provider: 'google', units: 1, costCents: 1, refId: saved.id } }).catch(() => {});
  }

  return { id: saved.id, script };
}

/** Zod schema reuse for tool-level enum validation. */
export const ScriptFormatSchema = z.enum(SCRIPT_FORMATS);
