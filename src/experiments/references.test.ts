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
  generateBriefCandidates: async () => { throw new Error('not used'); },
  jevScores: async () => ({}),
  describeCandidates: async (buffers: Buffer[]) => buffers.map((_, i) => ({ id: `c${i}`, description: `candidate ${i}` })),
  classify: async () => ({ value: 'c0', confidence: 0.9 }),
});
test('selects original slides deterministically across variants and rotates sources', () => {
  const { e, videos } = fixture();
  expect(selectSlideReference(e, 0, videos)?.path).toBe('w/a/slides/00.jpg');
  expect(selectSlideReference(e, 1, videos)?.path).toBe('w/b/slides/01.jpg');
  expect(selectSlideReference(e, 7, videos)?.path).toBe('w/b/slides/02.jpg');
  expect(selectSlideReference(e, 1, [...videos].reverse())).toEqual(selectSlideReference(e, 1, videos));
});
test('rejects missing sources, missing originals and foreign keys', () => {
  const { e, videos } = fixture();
  expect(() => selectSlideReference(e, 0, [])).toThrow('reference_source_not_found');
  for (const raw of [{ slideshowKeys: [] }, { slideshowKeys: ['other/a/slides/00.jpg'] }, { slideshowKeys: ['w/a/slides/../00.jpg'] }, { recreationKeys: ['other/a/recreate/00.jpg'] }, { slideshowKeys: ['w/a/slides/00.jpg'], recreationKeys: ['other/a/recreate/00.jpg'] }]) {
    videos[0]!.rawJson = JSON.stringify(raw);
    expect(() => selectSlideReference(e, 0, videos)).toThrow();
  }
});
test('accepts own-workspace recreated decks as slide references', () => {
  const { e, videos } = fixture();
  videos[0]!.rawJson = JSON.stringify({ recreationKeys: ['w/a/recreate/00.jpg', 'w/a/recreate/01.jpg'] });
  expect(selectSlideReference(e, 0, videos)?.path).toBe('w/a/recreate/00.jpg');
});
test('video-only sources anchor style with the source thumbnail', () => {
  const { e, videos } = fixture();
  for (const v of videos) { v.mediaStatus = 'stored'; v.durationSec = 30; v.rawJson = '{}'; }
  const anchor = selectSlideReference(e, 0, videos);
  expect(anchor).toMatchObject({ kind: 'thumb', videoId: 'a', path: 'w/a.jpg' });
  expect(anchor?.url).toContain('assets.example.test');
});
test('hook variants render once from the baseline frame instead of fanning out new faces', async () => {
  const { e, videos } = fixture();
  process.env.OPENROUTER_API_KEY = 'test-only';
  e.instructions = { ...e.instructions, variables: ['hook'], mode: 'controlled', goal: 'g', direction: 'do not change faces' };
  e.variants = [
    { id: 'base', revision: 1, baselineId: null, changedVariables: [], frozenBrief: e.variants[0]!.frozenBrief, slides: [{ index: 0, status: 'pending', url: null, path: null }, { index: 1, status: 'done', url: 'https://assets.example.test/base.jpg', path: 'base.jpg' }] },
    { id: 'hookv', revision: 1, baselineId: 'base', changedVariables: [{ name: 'hook', value: 'New hook' }], frozenBrief: e.variants[0]!.frozenBrief, slides: [] },
  ] as never;
  const calls: unknown[] = [];
  const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'hookv', index: 1 } as Task, deps(videos, calls));
  const result = await prepared.execute() as { fanout: { requested: number; rendered: number }; reference: { kind: string } };
  expect(calls).toHaveLength(1);
  const request = calls[0] as { referenceUrl?: string; prompt: string };
  expect(request.referenceUrl).toBe('https://assets.example.test/base.jpg');
  expect(request.prompt.toLowerCase()).toContain('locked frame');
  expect(result.fanout).toMatchObject({ requested: 1, rendered: 1 });
  expect(result.reference.kind).toBe('baseline');
});
test('prepare attaches the original image to exactly one render and saves provenance', async () => {
  const { e, videos } = fixture();
  process.env.OPENROUTER_API_KEY = 'test-only';
  const calls: unknown[] = [];
  const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'v', index: 1 } as Task, deps(videos, calls));
  expect(calls).toHaveLength(0);
  const result = await prepared.execute();
  expect(calls).toHaveLength(3);
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
  expect(urls).toEqual(['https://assets.example.test/w/b/slides/01.jpg', 'https://assets.example.test/w/b/slides/01.jpg', 'https://assets.example.test/w/b/slides/01.jpg', 'https://assets.example.test/w/b/slides/01.jpg', 'https://assets.example.test/w/b/slides/01.jpg', 'https://assets.example.test/w/b/slides/01.jpg']);
});
test('Jev picks the winning fan-out candidate and the rest are discarded', async () => {
  const uploads: string[] = [];
  const renders: string[] = [];
  process.env.OPENROUTER_API_KEY = 'test-only';
  const { e, videos } = fixture();
  const deps = {
    findSources: async () => videos,
    generateImage: async () => { const id = `cand${renders.length}`; renders.push(id); return { buffer: Buffer.alloc(600 + renders.length), contentType: 'image/jpeg', costUsd: 0 }; },
    upload: async (opts: { body: Buffer }) => { uploads.push(String(opts.body.length)); return { path: 'stored', sizeBytes: opts.body.length }; },
    generateBriefCandidates: async () => { throw new Error('not used'); },
    jevScores: async () => ({}),
    describeCandidates: async (buffers: Buffer[]) => buffers.map((_, i) => ({ id: `c${i}`, description: `candidate ${i}` })),
    classify: async () => ({ value: 'c1', confidence: 0.82, probabilities: { c0: 0.1, c1: 0.8, c2: 0.1 } }),
  };
  const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'v', index: 0 } as Task, deps);
  const result = await prepared.execute() as { fanout: { rendered: number; chosen: number; judge: { choice: string } }; url: string };
  expect(renders).toHaveLength(3);
  expect(result.fanout).toMatchObject({ rendered: 3, chosen: 1, judge: [{ choice: 'c1' }] });
  expect(uploads).toHaveLength(1);
  expect(uploads[0]).toBe('602');
});
test('judge failure falls back to the first candidate instead of losing the render', async () => {
  const uploads: string[] = [];
  const renders: string[] = [];
  process.env.OPENROUTER_API_KEY = 'test-only';
  const { e, videos } = fixture();
  const deps = {
    findSources: async () => videos,
    generateImage: async () => { const id = `cand${renders.length}`; renders.push(id); return { buffer: Buffer.alloc(600 + renders.length), contentType: 'image/jpeg', costUsd: 0 }; },
    upload: async (opts: { body: Buffer }) => { uploads.push(String(opts.body.length)); return { path: 'stored', sizeBytes: opts.body.length }; },
    generateBriefCandidates: async () => { throw new Error('not used'); },
    jevScores: async () => ({}),
    describeCandidates: async () => { throw new Error('grok down'); },
    classify: async () => { throw new Error('typesafe down'); },
  };
  const prepared = await prepare(e, { id: 't', kind: 'slide', target: 'v', index: 0 } as Task, deps);
  const result = await prepared.execute() as { fanout: { rendered: number; chosen: number; judge: { error?: string } } };
  expect(renders).toHaveLength(3);
  expect(result.fanout.rendered).toBe(3);
  expect(result.fanout.chosen).toBe(0);
  expect(JSON.stringify(result.fanout.judge)).toContain('grok down');
  expect(uploads).toHaveLength(1);
});
