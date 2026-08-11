import { describe, expect, test } from 'bun:test';
import { canonicalKey, normalizeQuery } from './canonical-query.js';

describe('normalizeQuery', () => {
  test('strips @ and lowercases creators', () => {
    expect(normalizeQuery('creator', '@BuildingWithLiz_')).toBe('buildingwithliz_');
    expect(normalizeQuery('creator', 'BuildingWithLiz_')).toBe('buildingwithliz_');
  });

  test('strips # and lowercases hashtags', () => {
    expect(normalizeQuery('hashtag', '#BuildInPublic')).toBe('buildinpublic');
    expect(normalizeQuery('hashtag', 'buildinpublic')).toBe('buildinpublic');
  });

  test('lowercases keywords without stripping mid-string symbols', () => {
    expect(normalizeQuery('keyword', 'How To Ascend')).toBe('how to ascend');
  });
});

describe('canonicalKey', () => {
  test('same handle with different decoration maps to one key', () => {
    expect(canonicalKey('tiktok', 'creator', '@Foo')).toBe(canonicalKey('tiktok', 'creator', 'foo'));
  });

  test('platform and type stay distinct', () => {
    expect(canonicalKey('tiktok', 'creator', 'foo')).not.toBe(canonicalKey('tiktok', 'hashtag', 'foo'));
    expect(canonicalKey('tiktok', 'creator', 'foo')).not.toBe(canonicalKey('reels', 'creator', 'foo'));
  });
});
