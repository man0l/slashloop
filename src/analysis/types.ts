// ---------------------------------------------------------------------------
// Types — interfaces and config shapes
// ---------------------------------------------------------------------------

import type { VideoAnalysisData, BriefData } from './schema.js';

// ---- Analysis context (passed to every backend) ----

export interface AnalysisContext {
  videoId: string;
  videoUrl: string;
  thumbnailUrl: string;
  caption: string;
  transcript: string | null;
  transcriptSource: string;
  platform: string;
  creatorHandle: string;
  creatorFollowers: number | null;
  postedAt: string;
  views: number;
  likes: number;
  comments: number;
  shares: number | null;
  saves: number | null;
  durationSec: number | null;
  outlierScore: number | null;
  outlierExplanation: string | null;
  workspaceId: string;
  // Optional: pre-downloaded video file path (required by gemini-native)
  videoFilePath?: string;
  // True when invoked from run_auto_analyze — backends use it to look up
  // batch pricing (Gemini Batch API = 50% discount).
  batch?: boolean;
}

// ---- What every backend returns (before DB storage) ----

export interface AnalysisOutput {
  data: VideoAnalysisData;
  analysisBasis: string;       // from ANALYSIS_BASIS enum
  backend: string;             // gemini-native | gemini-text
  model: string;               // e.g. "gemini-2.5-flash-lite"
  costCents: number;
  provider: string;            // "google"
}

export interface AnalysisResult {
  id: string;
  analysis: VideoAnalysisData;
  analysisBasis: string;
  confidence: 'high' | 'medium' | 'low';
  backend: string;
  model: string;
  costCents: number;
}

export interface BriefResult {
  id: string;
  brief: BriefData;
}

// ---- The interface every backend implements ----

export interface VideoAnalyzer {
  /** Human-readable name for logging */
  readonly name: string;
  /** Backend identifier stored in DB */
  readonly backendId: string;
  /** Provider for usage logging */
  readonly provider: string;

  /**
   * Analyze a video.
   * Must return VideoAnalysisData matching the Zod schema.
   * If the backend cannot observe certain aspects, return null for those fields.
   */
  analyze(ctx: AnalysisContext): Promise<AnalysisOutput>;
}

// ---- Workspace analysis config ----

export interface AnalysisConfig {
  backend: 'gemini-native' | 'gemini-text';
  fallback: 'gemini-native' | 'gemini-text';
  /** Gemini model for both native video and text-only fallback */
  geminiModel:
    | 'gemini-2.5-flash-lite' | 'gemini-2.5-flash' | 'gemini-2.5-pro'
    | 'gemini-3.1-flash-lite' | 'gemini-3.5-flash' | 'gemini-3-pro-preview';
}

export const DEFAULT_CONFIG: AnalysisConfig = {
  backend: 'gemini-native',
  fallback: 'gemini-text',
  geminiModel: 'gemini-3.5-flash',
};

// ---- Cost estimates (cents) per 30s video ----

// Interactive rates apply to one-off analyze_video calls.
// Batch rates apply when called from run_auto_analyze — Gemini's Batch API
// provides a 50% discount on both native and text calls.
// Costs are estimates for a ~30s short; longer videos cost more.
// Legacy 2.5 models are retained for backward compatibility with historical
// DB rows. New work should use 3.x models — 2.5 models are deprecated for
// new Gemini API keys as of mid-2026.
export const COST_ESTIMATES = {
  'gemini-native': {
    'gemini-2.5-flash-lite': 0.2,   // ~$0.002 interactive (legacy)
    'gemini-2.5-flash': 0.5,        // ~$0.005 (legacy)
    'gemini-2.5-pro': 4,            // ~$0.04 (legacy)
    'gemini-3.1-flash-lite': 0.2,   // ~$0.002
    'gemini-3.5-flash': 0.5,        // ~$0.005
    'gemini-3-pro-preview': 4,      // ~$0.04
  },
  'gemini-text': {
    'gemini-2.5-flash-lite': 0.1,   // ~$0.001 — text-only is much cheaper than native video (legacy)
    'gemini-2.5-flash': 0.25,       // ~$0.0025 (legacy)
    'gemini-2.5-pro': 2,            // ~$0.02 (legacy)
    'gemini-3.1-flash-lite': 0.1,   // ~$0.001
    'gemini-3.5-flash': 0.25,       // ~$0.0025
    'gemini-3-pro-preview': 2,      // ~$0.02
  },
} as const;

// Batch rates — 50% Gemini discount on both native and text calls.
// Pass these when computing costCents for analyses invoked from run_auto_analyze.
export const BATCH_COST_ESTIMATES = {
  'gemini-native': {
    'gemini-2.5-flash-lite': 0.1,   // 50% off (legacy)
    'gemini-2.5-flash': 0.25,       // 50% off (legacy)
    'gemini-2.5-pro': 2,            // 50% off (legacy)
    'gemini-3.1-flash-lite': 0.1,   // 50% off
    'gemini-3.5-flash': 0.25,       // 50% off
    'gemini-3-pro-preview': 2,      // 50% off
  },
  'gemini-text': {
    'gemini-2.5-flash-lite': 0.05,  // 50% off the already-cheap text rate (legacy)
    'gemini-2.5-flash': 0.125,      // 50% off (legacy)
    'gemini-2.5-pro': 1,            // 50% off (legacy)
    'gemini-3.1-flash-lite': 0.05,  // 50% off
    'gemini-3.5-flash': 0.125,      // 50% off
    'gemini-3-pro-preview': 1,      // 50% off
  },
} as const;

export type CostTable = typeof COST_ESTIMATES;

export function getCostCents(
  backend: 'gemini-native' | 'gemini-text',
  model: string,
  batch = false,
): number {
  const table = batch ? BATCH_COST_ESTIMATES : COST_ESTIMATES;
  const section = (table as Record<string, Record<string, number>>)[backend];
  if (!section) return 0;
  return section[model] ?? 0;
}

// ---- Basis → confidence mapping ----

export function basisToConfidence(basis: string): 'high' | 'medium' | 'low' {
  switch (basis) {
    case 'video':
    case 'video+transcript':
    case 'frames+transcript':
    case 'transcript+thumbnail':
    case 'transcript-only':
      return 'high';
    case 'frames+caption':
    case 'thumbnail+caption':
      return 'medium';
    case 'caption+metadata-only':
    default:
      return 'low';
  }
}