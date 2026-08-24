import { describe, expect, test } from 'bun:test';
import { tiktokVideoIdFromUrl } from './posts.js';
import { pickSound } from '../normalizers.js';

describe('tiktokVideoIdFromUrl', () => {
  test('reads watch and photo URLs', () => {
    expect(tiktokVideoIdFromUrl('https://www.tiktok.com/@me/video/7656450385845996830')).toBe('7656450385845996830');
    expect(tiktokVideoIdFromUrl('https://www.tiktok.com/@me/photo/1234567890123456789')).toBe('1234567890123456789');
  });

  test('returns null when there is no id', () => {
    expect(tiktokVideoIdFromUrl('https://www.tiktok.com/@me')).toBeNull();
  });
});

describe('pickSound', () => {
  test('reads clockworks musicMeta', () => {
    expect(pickSound({ musicMeta: { musicId: 'abc', musicName: 'original sound', musicAuthor: 'me' } }))
      .toEqual({ id: 'abc', title: 'original sound', author: 'me' });
  });

  test('reads web item music', () => {
    expect(pickSound({ music: { id: '9', title: 'trend', authorName: 'bob' } }))
      .toEqual({ id: '9', title: 'trend', author: 'bob' });
  });

  test('empty when no music fields', () => {
    expect(pickSound({ videoMeta: {} })).toBeNull();
  });
});
