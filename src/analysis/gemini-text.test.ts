import { describe, expect, test } from 'bun:test';
import { determineBasis, assertSlideshowVisuals } from './gemini-text.js';
import type { AnalysisContext } from './types.js';

const ctx = (over: Partial<AnalysisContext> = {}): AnalysisContext => ({
  videoId: 'v1',
  videoUrl: 'https://tiktok.com/@x/photo/1',
  thumbnailUrl: 'https://cdn.example/t.jpg',
  caption: 'VERY HIGH TESTOSTERONE',
  transcript: null,
  transcriptSource: 'none',
  platform: 'tiktok',
  creatorHandle: 'creator',
  creatorFollowers: 1000,
  postedAt: '2026-09-01T00:00:00.000Z',
  views: 100_000,
  likes: 10_000,
  comments: 200,
  shares: 50,
  saves: 80,
  durationSec: 0,
  outlierScore: 12,
  outlierExplanation: 'outlier',
  workspaceId: 'ws-1',
  ...over,
});

describe('determineBasis', () => {
  test('two or more attached images is a slideshow, even with a caption', () => {
    expect(determineBasis(ctx(), 2)).toBe('slideshow+caption');
    expect(determineBasis(ctx(), 5)).toBe('slideshow+caption');
  });

  test('a single attached image stays thumbnail+caption', () => {
    expect(determineBasis(ctx(), 1)).toBe('thumbnail+caption');
  });

  test('no images degrades to caption+metadata-only', () => {
    expect(determineBasis(ctx(), 0)).toBe('caption+metadata-only');
  });

  test('transcript plus one image is still transcript+thumbnail, not a slideshow', () => {
    expect(determineBasis(ctx({ transcript: 'hello' }), 1)).toBe('transcript+thumbnail');
  });
});

describe('assertSlideshowVisuals', () => {
  const shot = (description: string) => ({
    timestampSec: 0, durationSec: 0, type: 'other' as const, description, onScreenText: null,
  });
  const moment = (subjectAction: string) => ({
    timestampSec: 0, role: 'hook' as const, framing: null, cameraAngle: null, cameraMovement: null,
    subjectAction, wardrobeProps: null, setting: null, lighting: null, textOverlay: null,
    transitionIn: null, audioAtMoment: null,
  });
  const base = {
    shots: [shot('Face on black, overlay 1'), shot('Same face, overlay 2')],
    onScreenText: null,
    audioAnalysis: null,
    emotionalArc: null,
    keyMoments: [moment('Face camera unsmiling')],
    hook: { text: 'x', type: 'other' as const, placement: 'on_screen' as const, mechanism: 'y' },
    angle: { type: 'other' as const, description: 'z' },
    storytellingBeats: [{ type: 'hook' as const, timestampSec: 0, description: 'open' }],
    keyMechanisms: ['a'],
    emotionalDrivers: ['b'],
    pacing: { rhythm: 'r', retentionStrategy: 's', cutsPerMinute: null },
    visualTechniques: ['v'],
    audioTechniques: ['none'],
    audienceInsight: { targetDemographic: 't', unspokenDesire: 'u' },
    transferablePatterns: [{ pattern: 'p', description: 'd', adaptationNotes: 'n' }],
    overallAssessment: { summary: 'sum', viralityScore: 7, replicability: 'high' as const },
    confidenceNotes: 'notes',
  };

  test('accepts one described shot per slide', () => {
    expect(() => assertSlideshowVisuals(base as any, 2)).not.toThrow();
  });

  test('rejects empty shot descriptions', () => {
    expect(() => assertSlideshowVisuals({
      ...base,
      shots: [shot('ok'), shot('   ')],
    } as any, 2)).toThrow(/missing visual description/);
  });

  test('rejects empty keyMoment subjectAction', () => {
    expect(() => assertSlideshowVisuals({
      ...base,
      keyMoments: [moment('')],
    } as any, 2)).toThrow(/subjectAction/);
  });
});
