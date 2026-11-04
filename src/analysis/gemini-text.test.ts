import { describe, expect, test } from 'bun:test';
import { determineBasis, assertSlideshowVisuals } from './gemini-text.js';
import type { AnalysisContext } from './types.js';
import { VideoAnalysisDataSchema } from './schema.js';

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

describe('VideoAnalysisDataSchema time offsets', () => {
  const payload = (over: Record<string, unknown> = {}) => ({
    shots: [{ timestampSec: null, durationSec: null, type: 'other', description: 'd', onScreenText: null }],
    onScreenText: [{ timestampSec: null, text: 't', style: null }],
    audioAnalysis: null,
    emotionalArc: [{ timestampSec: null, primaryEmotion: 'joy', intensity: 5, trigger: 'x' }],
    keyMoments: [{ timestampSec: null, role: 'hook', subjectAction: 'a' }],
    hook: { text: 'x', type: 'other', placement: 'on_screen', mechanism: 'y' },
    angle: { type: 'other', description: 'z' },
    storytellingBeats: [0, 1, 2, 3, 4].map(() => ({ type: 'hook', timestampSec: null, description: 'b' })),
    keyMechanisms: ['a'],
    emotionalDrivers: ['b'],
    pacing: { rhythm: 'r', retentionStrategy: 's', cutsPerMinute: null },
    visualTechniques: ['v'],
    audioTechniques: ['none'],
    audienceInsight: { targetDemographic: 't', unspokenDesire: 'u' },
    transferablePatterns: [{ pattern: 'p', description: 'd', adaptationNotes: 'n' }],
    overallAssessment: { summary: 'sum', viralityScore: 7, replicability: 'high' },
    ...over,
  });

  test('null timestampSec on beats/shots/text/moments parses and lands on 0', () => {
    const r = VideoAnalysisDataSchema.safeParse(payload());
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.storytellingBeats.map(b => b.timestampSec)).toEqual([0, 0, 0, 0, 0]);
    expect(r.data.shots?.[0]).toMatchObject({ timestampSec: 0, durationSec: 0 });
    expect(r.data.onScreenText?.[0].timestampSec).toBe(0);
    expect(r.data.emotionalArc?.[0].timestampSec).toBe(0);
    expect(r.data.keyMoments?.[0].timestampSec).toBe(0);
  });

  test('valid timestamps are preserved; negative or non-numeric fall back to 0', () => {
    const r = VideoAnalysisDataSchema.safeParse(payload({
      storytellingBeats: [
        { type: 'hook', timestampSec: 3.5, description: 'a' },
        { type: 'hook', timestampSec: -2, description: 'b' },
        { type: 'hook', timestampSec: '0:07', description: 'c' },
      ],
    }));
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.storytellingBeats.map(b => b.timestampSec)).toEqual([3.5, 0, 0]);
  });
});
