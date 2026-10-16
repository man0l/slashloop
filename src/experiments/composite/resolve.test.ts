import { describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { resolveCompositeSource, type CompositeResolveDeps, type DeckJob } from './resolve.js';
import { deckFingerprint } from './options.js';
import { ExperimentError } from '../schema.js';

const keys = Array.from({ length: 4 }, (_, i) => `ws/v1/recreate/0${i}.jpg`);
const video = (raw: Record<string, unknown>, over: Partial<Video> = {}) =>
  ({ id: 'v1', platform: 'tiktok', externalId: 'e', rawJson: JSON.stringify(raw), ...over }) as unknown as Video;
const shots = ['short ramus ❌', 'tall ramus ✅', 'short ramus ❌', 'tall ramus ✅'].map((t, i) => ({ timestampSec: i, description: 'face', onScreenText: t }));

function deps(over: Partial<CompositeResolveDeps> & { job?: DeckJob | null } = {}) {
  const enqueued: Array<{ fp: string; key: string }> = [];
  const d: CompositeResolveDeps = {
    latestAnalysisJson: async () => ({ shots, onScreenText: [] }),
    activeExperimentIds: async () => [],
    latestDeckJob: async () => over.job ?? null,
    enqueue: async (_ws, _v, fp, _r, key) => { enqueued.push({ fp, key }); return { id: 'job-1' }; },
    ...over,
  };
  return { d, enqueued };
}
const code = async (p: Promise<unknown>) => { try { await p; return null; } catch (e) { return e instanceof ExperimentError ? e.code : String(e); } };

describe('resolveCompositeSource (SLA-868)', () => {
  test('a video with a finished AI Recreate deck is left alone', async () => {
    const { d, enqueued } = deps();
    const v = video({ recreationKeys: keys });
    expect(await resolveCompositeSource('ws', v, {}, d)).toBe(v);
    expect(enqueued).toEqual([]);
  });
  test('an explicit composite request replaces an AI Recreate deck: queues the render', async () => {
    const { d, enqueued } = deps();
    expect(await code(resolveCompositeSource('ws', video({ recreationKeys: keys }), {}, d, { replaceAiDeck: true }))).toBe('composite_deck_pending');
    expect(enqueued).toHaveLength(1);
  });
  test('replacing an AI Recreate deck is refused while an unfinished experiment reads it', async () => {
    const busy = deps({ activeExperimentIds: async () => ['exp-1'] });
    expect(await code(resolveCompositeSource('ws', video({ recreationKeys: keys }), {}, busy.d, { replaceAiDeck: true }))).toBe('composite_deck_in_use');
    expect(busy.enqueued).toEqual([]);
  });
  test('a video that is not photo-annotation falls through to the existing eligibility error path', async () => {
    const { d, enqueued } = deps({ latestAnalysisJson: async () => ({ shots: shots.map(s => ({ ...s, onScreenText: 'hello' })), onScreenText: [] }) });
    const v = video({});
    expect(await resolveCompositeSource('ws', v, {}, d)).toBe(v);
    expect(enqueued).toEqual([]);
  });
  test('no deck yet: queues the render once and reports it pending, without charging', async () => {
    const { d, enqueued } = deps();
    expect(await code(resolveCompositeSource('ws', video({}), {}, d))).toBe('composite_deck_pending');
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]!.fp).toBe(deckFingerprint('v1', {}));
  });
  test('a render already queued or running is not queued again', async () => {
    const { d, enqueued } = deps({ job: { id: 'j0', status: 'running', lastError: null } });
    expect(await code(resolveCompositeSource('ws', video({}), {}, d))).toBe('composite_deck_pending');
    expect(enqueued).toEqual([]);
  });
  test('a failed render is retried under a fresh dedupe key and the error is surfaced', async () => {
    const { d, enqueued } = deps({ job: { id: 'j0', status: 'failed', lastError: 'library_too_small' } });
    const err = await resolveCompositeSource('ws', video({}), {}, d).catch(e => e as ExperimentError);
    expect((err as ExperimentError).message).toContain('library_too_small');
    expect(enqueued[0]!.key).toContain('j0');
  });
  test('a matching deck is ready: the video is returned', async () => {
    const fingerprint = deckFingerprint('v1', {});
    const { d, enqueued } = deps();
    const v = video({ recreationKeys: keys, recreationModel: 'composite', compositeDeck: { fingerprint, faceIds: [] } });
    expect(await resolveCompositeSource('ws', v, {}, d)).toBe(v);
    expect(enqueued).toEqual([]);
  });
  test('a different deck is refused while an unfinished experiment still reads the current one', async () => {
    const stamped = video({ recreationKeys: keys, compositeDeck: { fingerprint: 'old' } });
    const busy = deps({ activeExperimentIds: async () => ['exp-1'] });
    expect(await code(resolveCompositeSource('ws', stamped, { seed: 'new' }, busy.d))).toBe('composite_deck_in_use');
    expect(busy.enqueued).toEqual([]);
    const idle = deps();
    expect(await code(resolveCompositeSource('ws', stamped, { seed: 'new' }, idle.d))).toBe('composite_deck_pending');
    expect(idle.enqueued).toHaveLength(1);
  });
});
