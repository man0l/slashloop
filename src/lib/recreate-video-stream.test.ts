import { describe, expect, test } from 'bun:test';
import {
  advanceRecreateVideoJob, parseRecreatePayload,
  failRecreateVideoJob, driveVideoRecreateJob, RECREATE_STEP_LEASE_MS,
  type RecreateVideoDeps,
} from './recreate-video-stream.js';

const VIDEO = {
  id: 'v-1',
  caption: 'Official PSL ratings with @PSL App',
  creatorHandle: 'noir3783',
  mediaKey: 'media/v-1.mp4',
  mediaStatus: 'stored',
  durationSec: 13,
  rawJson: null,
  geminiFileUri: null,
  geminiFileName: null,
  geminiFileExpiresAt: null,
  workspaceId: 'ws-1',
};

function freshJob(payload: Record<string, unknown> = { mode: 'video' }) {
  return {
    id: 'job-1',
    videoId: 'v-1',
    workspaceId: 'ws-1',
    opId: 'op-1',
    preAuthCredits: 2,
    payloadJson: JSON.stringify(payload),
  };
}

const PLAN = {
  plan: {
    slides: [
      { tSec: 0.5, description: 'fade', overlayText: 'fades look better bro' },
      { tSec: 4.5, description: 'shaggy', overlayText: null },
      { tSec: 10, description: 'curly', overlayText: null },
    ],
  },
  model: 'gemini-3.5-flash',
  source: 'gemini' as const,
};

/** Build fake deps + a tick() that advances the state machine one phase. */
function makeWorld(overrides: Partial<RecreateVideoDeps> = {}) {
  const calls = {
    streamCopy: [] as string[],
    streamThumbnails: [] as number[],
    generate: [] as string[],
    putSlides: [] as string[],
    stamped: null as string[] | null,
    completed: 0,
    completedPayload: null as Record<string, unknown> | null,
    failed: [] as string[],
    refunded: 0,
    streamDeleted: [] as string[],
    saves: 0,
  };
  let payloadJson = JSON.stringify({ mode: 'video' });
  let job = freshJob();

  const deps: RecreateVideoDeps = {
    loadVideo: async () => ({ ...VIDEO }),
    signMediaUrl: async () => 'https://r2.signed/v-1.mp4',
    planSlides: async () => PLAN,
    streamCopy: async (url, videoId) => { calls.streamCopy.push(`${url}|${videoId}`); return 'uid-9'; },
    streamStatus: async () => ({ ready: true, state: 'ready', thumbnailUrl: 'https://customer-abc.cloudflarestream.com/uid-9/thumbnails/thumbnail.jpg' }),
    streamThumbnail: async (_uid, tSec) => { calls.streamThumbnails.push(tSec); return new Uint8Array(2048).fill(2); },
    streamDelete: async (uid) => { calls.streamDeleted.push(uid); },
    generateSlide: async (prompt) => { calls.generate.push(prompt); return { bytes: new Uint8Array(4096).fill(3), contentType: 'image/jpeg', costUsd: 0.01 }; },
    putSlide: async (_ws, _vid, index) => { const k = `ws-1/v-1/recreate/${String(index).padStart(2, '0')}.jpg`; calls.putSlides.push(k); return k; },
    stampKeys: async (_videoId, keys) => { calls.stamped = keys; },
    savePayload: async (_jobId, p) => { calls.saves++; payloadJson = JSON.stringify(p); },
    complete: async (_jobId, p) => {
      calls.completed++;
      // mirror completeJob's payload rewrite
      calls.completedPayload = JSON.parse(JSON.stringify({ ...p, phase: 'done' }));
    },
    fail: async (_jobId, message) => { calls.failed.push(message); return { terminal: true }; },
    refund: async () => { calls.refunded++; },
    ...overrides,
  };

  async function tick() {
    job = { ...job, payloadJson };
    await advanceRecreateVideoJob(job, deps);
  }

  return { deps, calls, tick, get payload(): Record<string, unknown> { return JSON.parse(payloadJson); } };
}

describe('advanceRecreateVideoJob', () => {
  test('walks the full journey across ticks: plan → copy → wait → slides → done', async () => {
    const w = makeWorld();

    await w.tick(); // plan
    expect(w.payload.phase).toBe('copy');
    expect(w.payload.planSource).toBe('gemini');
    expect(w.payload.plan).toHaveLength(3);

    await w.tick(); // copy
    expect(w.payload.phase).toBe('wait');
    expect(w.payload.streamUid).toBe('uid-9');
    expect(w.calls.streamCopy[0]).toBe('https://r2.signed/v-1.mp4|v-1'); // url|videoId — the tag the retention sweep keys on

    await w.tick(); // wait → ready
    expect(w.payload.phase).toBe('slides');
    expect(w.payload.thumbBase).toContain('/uid-9/thumbnails/thumbnail.jpg');

    await w.tick(); // slide 1
    await w.tick(); // slide 2
    expect(w.payload.phase).toBe('slides');
    expect(w.payload.slideIndex).toBe(2);
    expect(w.payload.keys).toHaveLength(2);

    await w.tick(); // slide 3 → finalize inside the same tick
    expect(w.calls.completed).toBe(1);
    expect(w.calls.stamped).toHaveLength(3);
    expect(w.calls.streamThumbnails).toEqual([0.5, 4.5, 10]);
    expect(w.calls.generate).toHaveLength(3);
    // finalize completes the job with the full payload — it never savePayloads
    expect(w.calls.completedPayload!.costUsd).toBeCloseTo(0.03);
    expect(w.calls.completedPayload!.keys).toHaveLength(3);
    expect(w.calls.completedPayload!.phase).toBe('done');
    expect(w.calls.streamDeleted).toEqual(['uid-9']); // billing stops
    // the recreation prompt demands overlay removal, never keeps text
    expect(w.calls.generate[0]).toContain('Remove every trace of burned-in text');
  });

  test('wait phase writes nothing while Stream is still processing', async () => {
    const w = makeWorld({ streamStatus: async () => ({ ready: false, state: 'processing', thumbnailUrl: null }) });
    await w.tick(); // plan
    await w.tick(); // copy
    const savesBefore = w.calls.saves;
    await w.tick(); // wait, not ready
    expect(w.calls.saves).toBe(savesBefore);
    expect(w.payload.phase).toBe('wait');
  });

  test('falls back to interval frames when the Gemini plan fails', async () => {
    const w = makeWorld({ planSlides: async () => { throw new Error('gemini down'); } });
    await w.tick();
    expect(w.payload.phase).toBe('copy');
    expect(w.payload.planSource).toBe('fallback-interval');
    expect((w.payload.plan as unknown[]).length).toBeGreaterThanOrEqual(3);
  });

  test('a job interrupted after the last slide finalizes on the next tick', async () => {
    const w = makeWorld();
    // Jump straight to a "slides done but not finalized" payload.
    const done = {
      mode: 'video', phase: 'slides', streamUid: 'uid-9',
      thumbBase: 'https://thumb', slideIndex: 3, costUsd: 0.03,
      plan: PLAN.plan.slides,
      keys: ['k/0.jpg', 'k/1.jpg', 'k/2.jpg'],
    };
    w.tick; // eslint-disable-line @typescript-eslint/no-unused-expressions
    const job = { ...freshJob(done), payloadJson: JSON.stringify(done) };
    await advanceRecreateVideoJob(job, w.deps);
    expect(w.calls.completed).toBe(1);
    expect(w.calls.stamped).toHaveLength(3);
  });

  test('step failure fails the job, cleans up Stream and refunds once terminal', async () => {
    const w = makeWorld({ streamThumbnail: async () => { throw new Error('thumbnail 503'); } });
    await w.tick(); // plan
    await w.tick(); // copy
    await w.tick(); // wait → slides
    await expect(w.tick()).rejects.toThrow('thumbnail 503');

    const job = { ...freshJob({ mode: 'video', phase: 'slides', streamUid: 'uid-9', plan: PLAN.plan.slides, thumbBase: 'x' }), workspaceId: 'ws-1' } as Parameters<typeof failRecreateVideoJob>[0];
    await failRecreateVideoJob(job, w.deps, 'thumbnail 503');
    expect(w.calls.failed[0]).toContain('thumbnail 503');
    expect(w.calls.refunded).toBe(1);
    expect(w.calls.streamDeleted).toEqual(['uid-9']);
  });
});

describe('driveVideoRecreateJob', () => {
  test('runs the whole pipeline in one call — no tick waiting', async () => {
    const w = makeWorld();
    await driveVideoRecreateJob(freshJob() as never, w.deps, Date.now() + 30_000, { waitPollMs: 1 });
    expect(w.calls.completed).toBe(1);
    expect(w.calls.stamped).toHaveLength(3);
    expect(w.calls.streamThumbnails).toEqual([0.5, 4.5, 10]);
    expect(w.calls.streamDeleted).toEqual(['uid-9']);
  });
});

describe('driveVideoRecreateJob', () => {
  test('runs the whole pipeline in one call — no tick waiting', async () => {
    const w = makeWorld();
    await driveVideoRecreateJob(freshJob() as never, w.deps, Date.now() + 30_000, { waitPollMs: 1 });
    expect(w.calls.completed).toBe(1);
    expect(w.calls.stamped).toHaveLength(3);
    expect(w.calls.streamThumbnails).toEqual([0.5, 4.5, 10]);
    expect(w.calls.streamDeleted).toEqual(['uid-9']);
  });

  test('a safety-rejected slide is skipped, not fatal', async () => {
    const w = makeWorld();
    let rejected = 0;
    const deps: RecreateVideoDeps = {
      ...w.deps,
      generateSlide: async (prompt) => {
        if (rejected++ === 1) throw new Error('OpenRouter image error 400: safety_violations=[sexual]');
        return { bytes: new Uint8Array(4096).fill(3), contentType: 'image/jpeg', costUsd: 0.01 };
      },
    };
    await driveVideoRecreateJob(freshJob() as never, deps, Date.now() + 30_000, { waitPollMs: 1 });
    expect(w.calls.completed).toBe(1);
    expect(w.calls.stamped).toHaveLength(2); // 2 delivered + 1 skipped
    expect(w.calls.failed).toHaveLength(0);
    expect(w.calls.refunded).toBe(0);
  });

  test('all slides rejected still fails the job', async () => {
    const w = makeWorld();
    const deps: RecreateVideoDeps = {
      ...w.deps,
      generateSlide: async () => { throw new Error('OpenRouter image error 400: safety_violations'); },
    };
    await expect(driveVideoRecreateJob(freshJob() as never, deps, Date.now() + 30_000, { waitPollMs: 1 }))
      .rejects.toThrow('nothing to deliver');
    expect(w.calls.completed).toBe(0);
  });
});

describe('parseRecreatePayload', () => {
  test('survives garbage payloads', () => {
    expect(parseRecreatePayload('not json')).toEqual({ mode: 'video' });
    expect(parseRecreatePayload('{"mode":"video","phase":"copy"}').phase).toBe('copy');
  });

  test('lease constant is below the drain tick so progress resumes promptly', () => {
    expect(RECREATE_STEP_LEASE_MS).toBeLessThan(120_000);
  });
});
