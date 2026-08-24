import { describe, expect, test } from 'bun:test';
import { pickSound } from '../normalizers.js';

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
