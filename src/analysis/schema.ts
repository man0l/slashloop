// ---------------------------------------------------------------------------
// Shared Zod schemas — the contract.
// Every backend MUST emit JSON matching VideoAnalysisData.
// Fields a backend cannot populate → null, never a different shape.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';

// ---- Enums ----

export const HOOK_TYPES = [
  'POV', 'curiosity_gap', 'bold_claim', 'pattern_interrupt', 'question',
  'us_vs_them', 'social_proof', 'transformation', 'listicle', 'challenge', 'testimonial',
] as const;

export const ANGLE_TYPES = [
  'transformation', 'myth_busting', 'us_vs_them', 'insider_secret', 'social_proof',
  'educational', 'entertainment', 'emotional', 'FOMO', 'authority',
] as const;

export const BEAT_TYPES = [
  'hook', 'setup', 'conflict', 'escalation', 'reveal', 'proof', 'cta', 'callback', 'twist',
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
  type: z.enum(['talking_head', 'b_roll', 'product_closeup', 'text_overlay', 'split_screen', 'transition', 'reaction', 'demonstration', 'other'] as const),
  description: z.string(),
  onScreenText: z.string().nullable().describe('Text visible in frame, null if none'),
});

export const OnScreenTextEntrySchema = z.object({
  timestampSec: z.number().min(0),
  text: z.string(),
  style: z.enum(['overlay', 'subtitle', 'caption_packed', 'title_card', 'watermark'] as const).nullable(),
});

export const AudioAnalysisSchema = z.object({
  speechDetected: z.boolean(),
  speechType: z.enum(['direct_address', 'voiceover', 'conversation', 'none'] as const).nullable(),
  musicDescription: z.string().describe('Type of music or trending sound, if detected'),
  soundEffects: z.array(z.string()).describe('Notable sound effects'),
  tone: z.string().describe('Overall audio mood/atmosphere'),
});

export const EmotionalArcPointSchema = z.object({
  timestampSec: z.number().min(0),
  primaryEmotion: z.string(),
  intensity: z.number().min(1).max(10),
  trigger: z.string().describe('What in the video triggers this emotion'),
});

// ---- Strategic analysis sub-schemas ----

export const HookSchema = z.object({
  text: z.string().describe('Exact hook text or visual description'),
  type: z.enum(HOOK_TYPES),
  placement: z.enum(['spoken', 'on_screen', 'visual', 'audio', 'text_overlay'] as const),
  mechanism: z.string().describe('Why this hook works psychologically'),
});

export const AngleSchema = z.object({
  type: z.enum(ANGLE_TYPES),
  description: z.string(),
});

export const StorytellingBeatSchema = z.object({
  type: z.enum(BEAT_TYPES),
  timestampSec: z.number().min(0),
  description: z.string(),
});

export const PacingSchema = z.object({
  rhythm: z.string(),
  retentionStrategy: z.string(),
  cutsPerMinute: z.number().nullable().describe('Estimated edit pace'),
});

export const AudienceInsightSchema = z.object({
  targetDemographic: z.string(),
  unspokenDesire: z.string(),
});

export const TransferablePatternSchema = z.object({
  pattern: z.string(),
  description: z.string(),
  adaptationNotes: z.string(),
});

export const OverallAssessmentSchema = z.object({
  summary: z.string(),
  viralityScore: z.number().min(1).max(10),
  replicability: z.enum(REPLICABILITY),
});

// ---- Master schema ----

export const VideoAnalysisDataSchema = z.object({
  // --- Video-native observation fields (Gemini / frames) ---
  shots: z.array(ShotSchema).nullable().describe('Individual shots with timestamps. null if text-only analysis.'),
  onScreenText: z.array(OnScreenTextEntrySchema).nullable().describe('Text visible in the video. null if unavailable.'),
  audioAnalysis: AudioAnalysisSchema.nullable().describe('Audio breakdown. null if no audio available.'),
  emotionalArc: z.array(EmotionalArcPointSchema).nullable().describe('Emotion shifts over time. null if cannot determine from available data.'),

  // --- Strategic fields (all backends) ---
  hook: HookSchema,
  angle: AngleSchema,
  storytellingBeats: z.array(StorytellingBeatSchema),
  keyMechanisms: z.array(z.string()).min(1),
  emotionalDrivers: z.array(z.string()).min(1),
  pacing: PacingSchema,
  visualTechniques: z.array(z.string()),
  audioTechniques: z.array(z.string()),
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