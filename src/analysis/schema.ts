// ---------------------------------------------------------------------------
// Shared Zod schemas — the contract.
// Every backend MUST emit JSON matching VideoAnalysisData.
// Fields a backend cannot populate → null, never a different shape.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';

// ---- Enums ----
//
// Every enum below that a model FILLS IN carries `.catch(...)`, and the closed
// vocabularies carry an explicit 'other'. This is not defensive styling; it is
// a rule learned twice in production. A single off-list word — `lighting`, then
// `storytellingBeats[].type` — discarded an entire analysis: hook, angle,
// beats, transferable patterns, all of it, after the Gemini call was paid for
// and with the fallback then producing a worse result while reporting success.
//
// A classification the model guesses at must never be able to sink the run. The
// enum still buys a stable vocabulary for the common cases; anything outside it
// lands on 'other' rather than taking the analysis down.

export const HOOK_TYPES = [
  'POV', 'curiosity_gap', 'bold_claim', 'pattern_interrupt', 'question',
  'us_vs_them', 'social_proof', 'transformation', 'listicle', 'challenge', 'testimonial',
  'other',
] as const;

export const ANGLE_TYPES = [
  'transformation', 'myth_busting', 'us_vs_them', 'insider_secret', 'social_proof',
  'educational', 'entertainment', 'emotional', 'FOMO', 'authority', 'other',
] as const;

export const BEAT_TYPES = [
  'hook', 'setup', 'conflict', 'escalation', 'reveal', 'proof', 'cta', 'callback', 'twist',
  'other',
] as const;

export const REPLICABILITY = ['high', 'medium', 'low'] as const;

export const ANALYSIS_BASIS = [
  'video',               // Gemini watched the full video (highest)
  'video+transcript',    // Gemini + separate transcript available
  'frames+transcript',   // GLM text-only with transcript
  'frames+caption',      // GLM text-only with caption only
  'transcript+thumbnail',// GLM text-only with thumbnail
  'transcript-only',
  'thumbnail+caption',
  'caption+metadata-only',
] as const;

export const BACKENDS = ['gemini-native', 'gemini-text'] as const;

// ---- Video-native observation sub-schemas ----

export const ShotSchema = z.object({
  timestampSec: z.number().min(0),
  durationSec: z.number().min(0),
  type: z.enum(['talking_head', 'b_roll', 'product_closeup', 'text_overlay', 'split_screen', 'transition', 'reaction', 'demonstration', 'other'] as const).catch('other'),
  description: z.string().catch(''),
  onScreenText: z.string().nullable().describe('Text visible in frame, null if none'),
});

export const OnScreenTextEntrySchema = z.object({
  timestampSec: z.number().min(0),
  text: z.string().catch(''),
  style: z.enum(['overlay', 'subtitle', 'caption_packed', 'title_card', 'watermark'] as const).nullable().catch(null),
});

export const AudioAnalysisSchema = z.object({
  speechDetected: z.boolean(),
  speechType: z.enum(['direct_address', 'voiceover', 'conversation', 'none'] as const).nullable().catch(null),
  musicDescription: z.string().catch('').describe('Type of music or trending sound, if detected'),
  soundEffects: z.array(z.string()).catch([]).describe('Notable sound effects'),
  tone: z.string().catch('').describe('Overall audio mood/atmosphere'),
});

export const EmotionalArcPointSchema = z.object({
  timestampSec: z.number().min(0),
  primaryEmotion: z.string().catch(''),
  intensity: z.number().min(1).max(10),
  trigger: z.string().catch('').describe('What in the video triggers this emotion'),
});

// ---- Strategic analysis sub-schemas ----

export const HookSchema = z.object({
  text: z.string().catch('').describe('Exact hook text or visual description'),
  type: z.enum(HOOK_TYPES).catch('other'),
  placement: z.enum(['spoken', 'on_screen', 'visual', 'audio', 'text_overlay', 'other'] as const).catch('other'),
  mechanism: z.string().catch('').describe('Why this hook works psychologically'),
});

export const AngleSchema = z.object({
  type: z.enum(ANGLE_TYPES).catch('other'),
  description: z.string().catch(''),
});

export const StorytellingBeatSchema = z.object({
  type: z.enum(BEAT_TYPES).catch('other'),
  timestampSec: z.number().min(0),
  description: z.string().catch(''),
});

export const PacingSchema = z.object({
  rhythm: z.string().catch(''),
  retentionStrategy: z.string().catch(''),
  cutsPerMinute: z.number().nullable().describe('Estimated edit pace'),
});

export const AudienceInsightSchema = z.object({
  targetDemographic: z.string().catch(''),
  unspokenDesire: z.string().catch(''),
});

export const TransferablePatternSchema = z.object({
  pattern: z.string().catch(''),
  description: z.string().catch(''),
  adaptationNotes: z.string().catch(''),
});

export const OverallAssessmentSchema = z.object({
  summary: z.string().catch(''),
  viralityScore: z.number().min(1).max(10),
  replicability: z.enum(REPLICABILITY).catch('medium'),
});

// ---- Recreation ----

/**
 * One moment worth rebuilding, described as a shot-list entry.
 *
 * Deliberately NOT the same as ShotSchema. `shots` is the exhaustive
 * analytical record of what happens; this is the small set (3-6) someone would
 * actually restage, and it carries the production detail a shot needs to be
 * reproduced rather than merely understood. A description like "creator makes
 * an exaggerated fish face" tells you what happened; it does not tell you where
 * the camera was, what the lighting looked like, or where the caption sat.
 *
 * Every field is what a videographer who has not seen the video would have to
 * ask before they could shoot it.
 */
/**
 * An enum that degrades instead of failing.
 *
 * Recreation fields describe a continuum — a model asked for `lighting` will
 * reach for "soft daylight from a window" long before it picks `window` off a
 * list, and it is not wrong to. Under a strict enum that single word discarded
 * the ENTIRE analysis: every other field the model got right, thrown away after
 * the Gemini call was already paid for. Observed on the first real v3 run,
 * where three key moments each failed on `lighting` alone.
 *
 * So these coerce to 'other' rather than reject. The enum still buys a stable
 * vocabulary for the common cases and anything filterable; the free-text fields
 * beside it (subjectAction, setting, wardrobeProps) carry the nuance. A
 * descriptive field must never be able to fail an expensive analysis.
 */
function softEnum<const T extends readonly [string, ...string[]]>(values: T) {
  return z.enum(values).nullable().catch('other' as T[number]);
}

export const KeyMomentSchema = z.object({
  /** Mid-shot, not the cut. See prompts/gemini-observe.v2.md — transition frames are usually motion-blurred. */
  timestampSec: z.number().min(0),
  role: z.enum(['hook', 'setup', 'turn', 'payoff', 'cta', 'other'] as const).catch('other')
    .describe('What this moment does for the video, not what it depicts'),
  framing: softEnum(['extreme_close_up', 'close_up', 'medium', 'wide', 'other'] as const),
  cameraAngle: softEnum(['eye_level', 'low', 'high', 'overhead', 'dutch', 'other'] as const),
  cameraMovement: softEnum(['static', 'handheld', 'pan', 'push_in', 'pull_out', 'whip', 'other'] as const),
  /** Imperative voice — an instruction to perform, not a description of what was performed. */
  subjectAction: z.string().catch(''),
  wardrobeProps: z.string().nullable().catch(null),
  setting: z.string().nullable().catch(null),
  /**
   * Free text, not an enum. Lighting is the field a model most wants to
   * describe rather than classify, and for someone about to reshoot, "soft
   * window light from camera left" is strictly more useful than `window`.
   */
  lighting: z.string().nullable().catch(null),
  textOverlay: z.object({
    text: z.string(),
    position: softEnum(['top', 'center', 'bottom', 'other'] as const),
    style: z.string().nullable().catch(null),
  }).nullable().catch(null).describe('Text on screen at this moment, null if none'),
  transitionIn: softEnum(['cut', 'jump_cut', 'match_cut', 'whip', 'fade', 'none', 'other'] as const),
  audioAtMoment: z.string().nullable().catch(null),
});

// ---- Master schema ----

export const VideoAnalysisDataSchema = z.object({
  // --- Recreation (video-native only; text-only analysis cannot see any of it) ---
  keyMoments: z.array(KeyMomentSchema).nullable().default(null).catch(null)
    .describe('3-6 moments worth restaging, as shot-list entries. null for text-only analysis.'),

  // --- Video-native observation fields (Gemini / frames) ---
  shots: z.array(ShotSchema).nullable().describe('Individual shots with timestamps. null if text-only analysis.'),
  onScreenText: z.array(OnScreenTextEntrySchema).nullable().describe('Text visible in the video. null if unavailable.'),
  audioAnalysis: AudioAnalysisSchema.nullable().describe('Audio breakdown. null if no audio available.'),
  emotionalArc: z.array(EmotionalArcPointSchema).nullable().describe('Emotion shifts over time. null if cannot determine from available data.'),

  // --- Strategic fields (all backends) ---
  hook: HookSchema,
  angle: AngleSchema,
  storytellingBeats: z.array(StorytellingBeatSchema),
  keyMechanisms: z.array(z.string()).min(1).catch(['other']),
  emotionalDrivers: z.array(z.string()).min(1).catch(['other']),
  pacing: PacingSchema,
  visualTechniques: z.array(z.string()).catch([]),
  audioTechniques: z.array(z.string()).catch([]),
  audienceInsight: AudienceInsightSchema,
  transferablePatterns: z.array(TransferablePatternSchema),
  overallAssessment: OverallAssessmentSchema,
  confidenceNotes: z.string().optional(),
});

export type VideoAnalysisData = z.infer<typeof VideoAnalysisDataSchema>;
export type Shot = z.infer<typeof ShotSchema>;
export type OnScreenTextEntry = z.infer<typeof OnScreenTextEntrySchema>;
export type AudioAnalysis = z.infer<typeof AudioAnalysisSchema>;
export type EmotionalArcPoint = z.infer<typeof EmotionalArcPointSchema>;

// ---- Brief schema ----

export const VisualBeatSchema = z.object({
  timestampSec: z.number().min(0),
  description: z.string(),
});

export const DeliverableSpecsSchema = z.object({
  length: z.string(),
  format: z.string(),
  platform: z.string(),
});

export const BriefDataSchema = z.object({
  concept: z.string(),
  hook: z.string(),
  creatorDirection: z.string(),
  talkingPoints: z.array(z.string()).min(1),
  visualBeats: z.array(VisualBeatSchema),
  whatNotToCopy: z.array(z.string()),
  deliverableSpecs: DeliverableSpecsSchema,
});

export type BriefData = z.infer<typeof BriefDataSchema>;

// ---- Scripts (generate_script) ----

/**
 * Proven short-form formats for app promotion. The audience is app builders
 * marketing their own apps, so every format is one that demonstrably works
 * for app demos on TikTok — not generic creator formats.
 */
export const SCRIPT_FORMATS = [
  'pov_demo',
  'problem_solution',
  'apps_that_feel_illegal',
  'build_in_public',
  'listicle',
] as const;

export type ScriptFormat = (typeof SCRIPT_FORMATS)[number];

export const ScriptBeatSchema = z.object({
  timestampSec: z.number().min(0),
  /** What is said (voiceover or on-camera line) at this beat. */
  voiceover: z.string(),
  /** Text overlay to render, if any. */
  onScreenText: z.string().optional(),
  /** What is on screen — screen recording, selfie, b-roll. */
  visual: z.string(),
});

export const ScriptDataSchema = z.object({
  format: z.string(),
  /** The first 2 seconds, word for word. */
  hook: z.string(),
  beats: z.array(ScriptBeatSchema).min(3),
  /** The closing line + what happens on screen for it. */
  cta: z.string(),
  /** Ready-to-paste post caption. */
  caption: z.string(),
  hashtags: z.array(z.string()),
  /** One sentence on why this structure converts for an app. */
  whyThisWorks: z.string(),
});

export type ScriptData = z.infer<typeof ScriptDataSchema>;
// ---- Timestamp sanity ----

/**
 * Clamp every timestamp in an analysis to the video's real duration.
 *
 * Zod cannot express this: the bound is the video's length, which is per-row
 * data the schema never sees, so every timestampSec is only `.min(0)`. A model
 * that drifts past the end therefore validates clean — harmless while these
 * were just numbers to read, wrong the moment they became something we seek to.
 * A key moment at 47s in a 40s video renders a blank frame.
 *
 * Clamps rather than rejects. A drifted timestamp is a slightly wrong frame;
 * discarding the whole analysis over it would throw away everything else the
 * model got right, and the analysis is the expensive part.
 *
 * A small tolerance is allowed past the end before clamping, because durationSec
 * is itself scraped metadata and is routinely off by a frame or two.
 */
export function clampTimestamps<T>(data: T, durationSec: number | null | undefined): T {
  if (!durationSec || durationSec <= 0) return data;
  const max = durationSec + 0.5;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = { ...(node as Record<string, unknown>) };
      for (const [k, v] of Object.entries(out)) {
        if (k === 'timestampSec' && typeof v === 'number') {
          out[k] = Math.min(Math.max(v, 0), max);
        } else if (k === 'durationSec' && typeof v === 'number') {
          // A shot cannot run past the end of the video either.
          out[k] = Math.min(Math.max(v, 0), durationSec);
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return node;
  };

  return walk(data) as T;
}
