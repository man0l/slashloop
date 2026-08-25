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

/** An opening entry is only usable if it carries its line. One lazy element
 *  (empty/missing hookText) used to fail the ENTIRE versions array — dropping
 *  junk entries before the strict parse lets an otherwise-good draft ship. */
function hasHookLine(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const hookText = (raw as { hookText?: unknown }).hookText;
  return typeof hookText === 'string' && hookText.trim().length > 0;
}

export const HookTestDraftSchema = z.object({
  /** One sentence — why the original's first seconds grabbed attention. */
  insight: z.string().min(1),
  /** Frozen chips: what every version keeps from the original. */
  sameIn: z.array(z.string()).catch([]),
  /** The story shape copied into every version, one line per beat. */
  beats: z.array(z.string()).catch([]),
  versions: z.preprocess(
    (raw) => (Array.isArray(raw) ? raw.filter(hasHookLine) : raw),
    z.array(OpeningSchema).min(2),
  ),
});

export type HookTestDraft = z.infer<typeof HookTestDraftSchema>;

export interface HookTestLock {
  insight?: string;
  sameIn?: string[];
  beats?: string[];
}

const HOOK_TEST_SYSTEM = `You are Gemini, a short-form video strategist running hook tests. Given a viral video analysis, extract ONE transferable insight (why the first seconds grabbed attention) and write 4 alternative OPENINGS for a new video built on that same insight.

Rules:
- Return EXACTLY 4 versions — one per opening type, all four present:
    "recognition" (viewer sees themselves), "specific_number" (a concrete figure does the convincing), "contrarian" (opens against what the viewer believes), "demo_first" (the result/action before any explanation).
- Every version keeps the SAME subject, setting and story shape — ONLY the opening changes. Name what stays constant in "sameIn".
- Each version pairs the spoken/overlay hook TEXT with what the FIRST FRAME literally shows. Every version's "hookText" MUST be non-empty — a version without its line is worse than none.
- Openings must be reproducible without the original creator, brand or assets — no "as you can see", no references to the original video.

Output raw JSON only, in exactly this shape (note: ALL FOUR versions):
{
  "insight": "1 sentence",
  "sameIn": ["face to camera in a kitchen", "phone-screen demos"],
  "beats": ["opening states the tension", "quick proof montage", "payoff + rewatch bait"],
  "versions": [
    {"type": "recognition", "hookText": "...", "firstFrame": "...", "mechanism": "why it works"},
    {"type": "specific_number", "hookText": "...", "firstFrame": "...", "mechanism": "why it works"},
    {"type": "contrarian", "hookText": "...", "firstFrame": "...", "mechanism": "why it works"},
    {"type": "demo_first", "hookText": "...", "firstFrame": "...", "mechanism": "why it works"}
  ]
}`;

/**
 * The lock as prompt text. When a test is re-rolled (or started with an
 * explicit insight), the stored insight/chips/beats are the strategy — the
 * model must serve them, not rediscover one. Without this the lock was merely
 * preserved in the DB while every fresh generation drifted off it.
 */
export function lockSection(lock: HookTestLock | undefined): string {
  if (!lock) return '';
  const parts: string[] = [];
  if (lock.insight) parts.push(`- INSIGHT (locked): ${lock.insight}`);
  if (lock.sameIn?.length) parts.push(`- CONSTANTS (locked): ${lock.sameIn.join('; ')}`);
  if (lock.beats?.length) parts.push(`- STORY SHAPE (locked): ${lock.beats.join(' → ')}`);
  if (parts.length === 0) return '';
  return `\n## Locked frame — HARD CONSTRAINTS\nThis test is locked to the strategy below. Every opening MUST serve this exact insight, keep these constants, and follow this story shape. Echo them back unchanged in your JSON ("insight" and "sameIn"/"beats" fields MUST be these values verbatim).\n${parts.join('\n')}`;
}

/**
 * Generate a hook-test draft (insight + 4 openings) from a video's latest
 * analysis. Throws when the video has no analysis yet — the caller turns that
 * into an analyze_video next-step rather than a dead end.
 */
/**
 * Post-generation cleanup: de-dup opening types (one per type keeps label
 * assignment A–D distinct) and, under a lock, replace the model's echo with
 * the canonical stored values.
 */
export function applyLockedValues(draft: HookTestDraft, lock?: HookTestLock): HookTestDraft {
  const seen = new Set<string>();
  const unique = draft.versions.filter((v) => !seen.has(v.type) && seen.add(v.type)).slice(0, 4);
  const locked = Boolean(lock && (lock.insight || lock.sameIn?.length || lock.beats?.length));
  if (!locked) return { ...draft, versions: unique };
  return {
    insight: lock?.insight || draft.insight,
    sameIn: lock?.sameIn?.length ? lock.sameIn : draft.sameIn,
    beats: lock?.beats?.length ? lock.beats : draft.beats,
    versions: unique,
  };
}

export async function generateHookTestDraft(
  videoId: string,
  opts: { brandContext?: string; model?: string; lock?: HookTestLock } = {},
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
    lockSection(opts.lock),
    `\nGenerate the hook test.`,
  ].join('\n');

  const model = opts.model ?? 'gemini-3.5-flash';
  let draft!: HookTestDraft;
  let lastIssues = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    // Attempt 2 carries the validator's complaints — a blind retry resends
    // the byte-identical prompt and deterministically reproduces the same
    // failure (the original bug: the model kept copying the one-version
    // example, min(2) failed twice).
    const corrective = lastIssues
      ? `\n## Correction required\nYour previous response failed schema validation:\n${lastIssues}\nReturn ONLY corrected raw JSON — exactly four versions, every "hookText" non-empty.`
      : '';
    const parsed = await callModelText(HOOK_TEST_SYSTEM, userMessage + corrective, model);
    const result = HookTestDraftSchema.safeParse(parsed);
    if (result.success) { draft = result.data; break; }
    lastIssues = result.error.issues
      .slice(0, 5)
      .map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    if (attempt === 0) continue;
    console.error(`[hook-tests] validation failed twice for video ${videoId}:\n${lastIssues}`);
    throw new Error(`Hook test validation failed after 2 attempts (${lastIssues.split('\n')[0]})`);
  }

  return applyLockedValues(draft, opts.lock);
}
