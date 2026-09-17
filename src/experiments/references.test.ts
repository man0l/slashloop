import { afterEach, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { prepare, selectSlideReference } from './providers.js';
import type { Experiment, Task } from './schema.js';

const env = { base: process.env.R2_THUMB_PUBLIC_BASE, key: process.env.OPENROUTER_API_KEY };
const restores: Array<() => void> = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  for (const [key, value] of [['R2_THUMB_PUBLIC_BASE', env.base], ['OPENROUTER_API_KEY', env.key]]) {
    if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
  }
});
function fixture() {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  const videos = ['a', 'b'].map(id => ({ id, mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: [0, 1, 2].map(i => `w/${id}/slides/0${i}.jpg`) }) } as Video));
  const brief = { concept: 'Guide', hook: 'New hook', character: 'An artist', visualStyle: 'Editorial', caption: '', cta: '', lockedConstraints: [], slides: [0, 1, 2].map(() => ({ role: 'proof', scene: 'A studio', overlayText: 'New text' })) };
  const e = { id: 'e', workspaceId: 'w', inputs: videos.map(v => ({ videoId: v.id, status: 'ready' })), instructions: { language: 'English', brand: '', audience: '' }, variants: [{ id: 'v', revision: 1, frozenBrief: brief }] } as unknown as Experiment;
  return { e, videos };
}
const deps = (videos: Video[], calls: unknown[] = []) => ({
  findSources: async () => videos,
  generateImage: async (opts: unknown) => { calls.push(opts); return { buffer: Buffer.alloc(600), contentType: 'image/jpeg', costUsd: 0 }; },
  upload: async () => ({ path: 'stored', sizeBytes: 600 }),
});
test('selects original slides deterministically across variants and rotates sources', () => {
  const { e, videos } = fixture();
  expect(selectSlideReference(e, 0, videos)?.path).toBe('w/a/slides/00.jpg');
  expect(selectSlideReference(e, 1, videos)?.path).toBe('w/b/slides/01.jpg');
  expect(selectSlideReference(e, 7, videos)?.path).toBe('w/b/slides/02.jpg');
  expect(selectSlideReference(e, 1, [...videos].reverse())).toEqual(selectSlideReference(e, 1, videos));
});
test('rejects missing sources, missing originals and foreign/recreated keys', () => {
  const { e, videos } = fixture();
  expect(() => selectSlideReference(e, 0, [])).toThrow('reference_source_not_found');
  for (const keys of [[], ['other/a/slides/00.jpg'], ['w/a/recreate/00.jpg'], ['w/a/slides/../00.jpg']]) {
    videos[0]!.rawJson = JSON.stringify({ slideshowKeys: keys });
    expect(() => selectSlideReference(e, 0, videos)).toThrow();
  }
});
test('video-only sources remain text-directed', () => {
  const { e, videos } = fixture();
  for (const v of videos) { v.mediaStatus = 'stored'; v.durationSec = 30; v.rawJson = '{}'; }
  expect(selectSlideReference(e, 0, videos)).toBeNull();
});
test('prepare attaches the original image to exactly one render and saves provenance', async () => {
  const { e, videos } = fixture();
  process.env.OPENROUTER_API_KEY = 'test-only';
  const calls: unknown[] = [];
  const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'v', index: 1 } as Task, deps(videos, calls));
  expect(calls).toHaveLength(0);
  const result = await prepared.execute();
  expect(calls).toHaveLength(1);
  const request = calls[0] as { referenceUrl?: string; prompt: string };
  expect(request.referenceUrl).toBe('https://assets.example.test/w/b/slides/01.jpg');
  expect(request.prompt).toContain('approved brief controls');
  expect(result).toMatchObject({ reference: { videoId: 'b', index: 1, path: 'w/b/slides/01.jpg' } });
});
test('failed slide retries reuse the identical reference', async () => {
  const { e, videos } = fixture();
  process.env.OPENROUTER_API_KEY = 'test-only';
  const calls: unknown[] = [];
  for (let i = 0; i < 2; i++) {
    const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'v', index: 1 } as Task, deps(videos, calls));
    await prepared.execute();
  }
  const urls = calls.map(c => (c as { referenceUrl?: string }).referenceUrl);
  expect(urls).toEqual(['https://assets.example.test/w/b/slides/01.jpg', 'https://assets.example.test/w/b/slides/01.jpg']);
});
