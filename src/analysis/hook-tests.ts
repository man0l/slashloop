// ---------------------------------------------------------------------------
// Hook Test Generator — Gemini text-only pass (feature #7).
// One proven video's analysis → one transferable insight + 4 opening
// variants (recognition / specific number / contrarian / demo-first).
// V1 is text-only: the draft ends at words + first frames; rendering is
// Phase 3. Persists nothing — src/lib/hook-tests.ts owns the objects, so a
// re-roll can regenerate without touching the saved test.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { callModelText } from '../lib/llm.js';

/** The four opening types a v1 test always ships — one variant each. */
export const HOOK_TEST_TYPES = ['recognition', 'specific_number', 'contrarian', 'demo_first'] as const;

export type HookTestType = (typeof HOOK_TEST_TYPES)[number];

const OpeningSchema = z.object({
  type: z.enum(HOOK_TEST_TYPES).catch('recognition'),
  /** The spoken / overlay line for the first seconds. */
  hookText: z.string().min(1),
  /** What the very first frame shows — an opening is audiovisual, not just a sentence. */
  firstFrame: z.string().catch(''),
  mechanism: z.string().catch(''),
});

export const HookTestDraftSchema = z.object({
  /** One sentence — why the original's first seconds grabbed attention. */
  insight: z.string().min(1),
  /** Frozen chips: what every version keeps from the original. */
  sameIn: z.array(z.string()).catch([]),
  /** The story shape copied into every version, one line per beat. */
  beats: z.array(z.string()).catch([]),
  versions: z.array(OpeningSchema).min(2),
});

export type HookTestDraft = z.infer<typeof HookTestDraftSchema>;

const HOOK_TEST_SYSTEM = `You are Gemini, a short-form video strategist running hook tests. Given a viral video analysis, extract ONE transferable insight (why the first seconds grabbed attention) and write 4 alternative OPENINGS for a new video built on that same insight.

Rules:
- Every version keeps the SAME subject, setting and story shape — ONLY the opening changes. Name what stays constant in "sameIn".
- Exactly one version per opening type: "recognition" (viewer sees themselves), "specific_number" (a concrete figure does the convincing), "contrarian" (opens against what the viewer believes), "demo_first" (the result/action before any explanation).
- Each version pairs the spoken/overlay hook TEXT with what the FIRST FRAME literally shows.
- Openings must be reproducible without the original creator, brand or assets — no "as you can see", no references to the original video.

Output raw JSON only:
{
  "insight": "1 sentence",
  "sameIn": ["face to camera in a kitchen", "phone-screen demos", "..."],
  "beats": ["opening states the tension", "quick proof montage", "payoff + rewatch bait"],
  "versions": [
    {"type": "recognition", "hookText": "...", "firstFrame": "...", "mechanism": "why it works"}
  ]
}`;

/**
 * Generate a hook-test draft (insight + 4 openings) from a video's latest
 * analysis. Throws when the video has no analysis yet — the caller turns that
 * into an analyze_video next-step rather than a dead end.
 */
export async function generateHookTestDraft(
  videoId: string,
  opts: { brandContext?: string; model?: string } = {},
): Promise<HookTestDraft> {
  const analysis = await db.analysis.findFirst({
    where: { videoId },
    orderBy: { createdAt: 'desc' },
  });
  if (!analysis) throw new Error(`No analysis found for video ${videoId} — run analyze_video first`);

  const video = await db.video.findUnique({
    where: { id: videoId },
    select: { caption: true, creatorHandle: true },
  });

  const brandSection = opts.brandContext ? `\n## Brand Context\n${opts.brandContext}` : '';
  const userMessage = [
    `## Viral Video Analysis`,
    ``,
    analysis.analysisJson,
    video ? `\n## Original Video\nCreator: @${video.creatorHandle}\nCaption: ${video.caption}` : '',
    brandSection,
    `\nGenerate the hook test.`,
  ].join('\n');

  const model = opts.model ?? 'gemini-3.5-flash';
  let draft!: HookTestDraft;
  for (let attempt = 0; attempt < 2; attempt++) {
    const parsed = await callModelText(HOOK_TEST_SYSTEM, userMessage, model);
    const result = HookTestDraftSchema.safeParse(parsed);
    if (result.success) { draft = result.data; break; }
    if (attempt === 0) continue;
    throw new Error('Hook test validation failed after 2 attempts');
  }

  // One per type was asked for; de-dup defensively so label assignment in the
  // service always lands A-D on distinct openings.
  const seen = new Set<string>();
  const unique = draft.versions.filter((v) => !seen.has(v.type) && seen.add(v.type));
  return { ...draft, versions: unique.slice(0, 4) };
}
