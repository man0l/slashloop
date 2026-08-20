import { describe, expect, test } from 'bun:test';
import {
  CREATOR_PREVIEW_OUTLIER_MIN,
  creatorHandleWhere,
  emptyCreatorPreview,
  toPreviewVideo,
  trackedCreatorSourceId,
} from './creator-preview.js';

describe('creatorHandleWhere', () => {
  test('matches the handle with and without a leading @', () => {
    expect(creatorHandleWhere('@Maker')).toEqual({
      OR: [
        { creatorHandle: { equals: 'maker', mode: 'insensitive' } },
        { creatorHandle: { equals: '@maker', mode: 'insensitive' } },
      ],
    });
  });

  test('empty / punctuation-only handles are unmatchable', () => {
    expect(creatorHandleWhere('')).toBeNull();
    expect(creatorHandleWhere('@@@')).toBeNull();
  });
});

describe('trackedCreatorSourceId', () => {
  const sources = [
    { id: 's-kw', query: 'sauna' },
    { id: 's-cr', query: '@Maker' },
  ];

  test('finds a tracked creator ignoring @ and case', () => {
    expect(trackedCreatorSourceId(sources, 'maker')).toBe('s-cr');
    expect(trackedCreatorSourceId(sources, '@MAKER')).toBe('s-cr');
  });

  test('returns null when the handle is not a tracked creator', () => {
    expect(trackedCreatorSourceId(sources, 'other')).toBeNull();
  });
});

describe('toPreviewVideo', () => {
  test('flattens a scored row into the hover-card shape', () => {
    const postedAt = new Date('2026-01-02T00:00:00Z');
    expect(
      toPreviewVideo({
        id: 'v1',
        caption: 'hello',
        url: 'https://tiktok.com/@maker/v/1',
        views: 1200,
        postedAt,
        thumbnailUrl: 'https://cdn/t.jpg',
        thumbKey: null,
        score: { outlierScore: 8.2 },
      }),
    ).toEqual({
      id: 'v1',
      thumbUrl: 'https://cdn/t.jpg',
      views: 1200,
      outlierScore: 8.2,
      caption: 'hello',
      postedAt: postedAt.getTime(),
      url: 'https://tiktok.com/@maker/v/1',
    });
  });

  test('unscored videos carry a null outlierScore', () => {
    expect(
      toPreviewVideo({
        id: 'v2',
        caption: '',
        url: 'https://t/2',
        views: 0,
        postedAt: new Date(0),
        thumbnailUrl: '',
        thumbKey: null,
        score: null,
      }).outlierScore,
    ).toBeNull();
  });
});

describe('emptyCreatorPreview', () => {
  test('is the hover card for a handle with no library rows', () => {
    expect(emptyCreatorPreview('maker')).toEqual({
      handle: 'maker',
      trackedSourceId: null,
      videoCount: 0,
      outlierCount: 0,
      followers: null,
      medianViews: null,
      outliers: [],
      recent: [],
    });
  });
});

describe('CREATOR_PREVIEW_OUTLIER_MIN', () => {
  test('matches the Gallery dropdown\'s first ≥ Nx step', () => {
    expect(CREATOR_PREVIEW_OUTLIER_MIN).toBe(2);
  });
});
