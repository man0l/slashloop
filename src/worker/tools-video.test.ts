import { describe, expect, mock, test } from 'bun:test';

mock.module('../db.js', () => ({
  db: {},
  dbDialect: () => 'postgres',
  effectiveDatabaseUrl: () => '',
  initStorePostgres: () => {},
  initStoreD1Http: () => {},
}));

import { processToolsJob, type ToolsJobDeps } from './tools-jobs.js';
import {
  classifyVideoError,
  hookUserMessage,
  HOOK_INPUT_WORDS,
  HOOK_MAX_TOKENS,
  MAX_AUDIO_SECONDS,
  parseHook,
  parseVideoPayload,
  parseWhisperResponse,
  runVideoLookup,
  transcribeWithWhisper,
  VIDEO_ESTIMATE_BYTES,
  type VideoDeps,
  type VideoPayload,
  type WhisperOutput,
} from './tools-video.js';

const NOW = new Date('2026-10-27T12:00:00Z');
const URL_OK = 'https://www.tiktok.com/@some.creator/video/7412345678901234567';
const PAYLOAD: VideoPayload = { videoUrl: URL_OK, videoId: '7412345678901234567', caption: 'a caption' };

const WHISPER_FIXTURE = {
  success: true,
  result: {
    text: ' Stop scrolling. Here are three ways to save money. ',
    transcription_info: { language: 'en', duration: 31.46 },
    segments: [
      { start: 0, end: 1.24, text: ' Stop scrolling. ' },
      { start: 1.24, end: 4.98, text: ' Here are three ways to save money. ' },
      { start: 5, end: 5.5, text: '   ' },
    ],
  },
};

const WHISPER_OUT: WhisperOutput = {
  text: 'Stop scrolling. Here are three ways to save money.',
  language: 'en',
  durationSec: 31.5,
  segments: [{ start: 0, end: 1.2, text: 'Stop scrolling.' }],
};

describe('parseVideoPayload', () => {
  test('accepts a canonical watch URL whose id matches videoId', () => {
    expect(parseVideoPayload({ videoUrl: URL_OK, videoId: PAYLOAD.videoId, caption: ' hi ' })).toEqual({ ...PAYLOAD, caption: 'hi' });
  });

  test('rejects foreign hosts, id mismatch, non-numeric ids and missing fields', () => {
    const id = PAYLOAD.videoId;
    for (const bad of [
      { videoUrl: 'https://evil.example/@a/video/' + id, videoId: id },
      { videoUrl: 'https://www.tiktok.com.evil.example/@a/video/' + id, videoId: id },
      { videoUrl: 'http://www.tiktok.com/@a/video/' + id, videoId: id },
      { videoUrl: URL_OK, videoId: '7412345678901234568' },
      { videoUrl: URL_OK, videoId: 'abc' },
      { videoUrl: URL_OK },
      { videoId: id },
      { videoUrl: `${URL_OK}?x=1`, videoId: id },
    ]) {
      expect(parseVideoPayload(bad)).toBeNull();
    }
  });

  test('caps the caption', () => {
    expect(parseVideoPayload({ ...PAYLOAD, caption: 'x'.repeat(2000) })!.caption).toHaveLength(500);
  });
});

describe('classifyVideoError', () => {
  const named = (name: string, message = '') => Object.assign(new Error(message), { name });
  test('maps the scraper failures to callback codes', () => {
    expect(classifyVideoError(named('TrafficCapExceededError'))).toBe('budget');
    expect(classifyVideoError(named('SlideshowPostError', 'photo'))).toBe('slideshow');
    expect(classifyVideoError(new Error('exceeds the SCRAPER_PROXY_MAX_VIDEO_MB ceiling'))).toBe('too_long');
    expect(classifyVideoError(new Error('TikTok returned no playable URL for this video'))).toBe('not_found');
    expect(classifyVideoError(new Error('TikTok watch page had no playable video (http=404, rehydrate=true) — the post may be deleted'))).toBe('not_found');
    expect(classifyVideoError(new Error('TikTok watch page had no playable video (http=429, rehydrate=false) — the post'))).toBe('blocked');
    expect(classifyVideoError(new Error('captcha challenge'))).toBe('blocked');
    expect(classifyVideoError(new Error('Workers AI answered 500'))).toBe('error');
  });
});

describe('parseWhisperResponse', () => {
  test('keeps trimmed segments with timestamps, language and duration', () => {
    expect(parseWhisperResponse(WHISPER_FIXTURE)).toEqual({
      text: 'Stop scrolling. Here are three ways to save money.',
      language: 'en',
      durationSec: 31.5,
      segments: [
        { start: 0, end: 1.2, text: 'Stop scrolling.' },
        { start: 1.2, end: 5, text: 'Here are three ways to save money.' },
      ],
    });
  });

  test('unusable envelopes are null; missing duration falls back to the last segment', () => {
    expect(parseWhisperResponse(null)).toBeNull();
    expect(parseWhisperResponse({ success: false, result: {} })).toBeNull();
    expect(parseWhisperResponse({ success: true })).toBeNull();
    const r = parseWhisperResponse({ success: true, result: { segments: [{ start: 0, end: 7.25, text: 'hi' }] } });
    expect(r).toMatchObject({ text: 'hi', language: null, durationSec: 7.3 });
  });
});

describe('transcribeWithWhisper', () => {
  test('POSTs base64 audio to the whisper-large-v3-turbo endpoint with the bearer token', async () => {
    let seen: { url: string; init: any } | null = null;
    const out = await transcribeWithWhisper(Buffer.from('audio-bytes'), { accountId: 'acct1', apiToken: 'tok' }, {
      fetch: async (url, init) => {
        seen = { url, init };
        return { status: 200, json: async () => WHISPER_FIXTURE };
      },
    });
    expect(out.language).toBe('en');
    expect(seen!.url).toBe('https://api.cloudflare.com/client/v4/accounts/acct1/ai/run/@cf/openai/whisper-large-v3-turbo');
    expect(seen!.init.headers.authorization).toBe('Bearer tok');
    expect(JSON.parse(seen!.init.body).audio).toBe(Buffer.from('audio-bytes').toString('base64'));
  });

  test('non-2xx and empty results throw', async () => {
    const creds = { accountId: 'a', apiToken: 't' };
    await expect(transcribeWithWhisper(Buffer.from('x'), creds, { fetch: async () => ({ status: 500, json: async () => ({}) }) })).rejects.toThrow('500');
    await expect(transcribeWithWhisper(Buffer.from('x'), creds, { fetch: async () => ({ status: 200, json: async () => ({ success: true }) }) })).rejects.toThrow('no transcription');
  });
});

describe('hook', () => {
  const GOOD = {
    hook: 'Stop scrolling.',
    hookType: 'Claim',
    firstSeconds: 'Promises three money-saving tips.',
    whyItWorks: 'Pattern interrupt plus a numbered promise.',
  };

  test('parses model JSON; an unknown hookType becomes other', () => {
    expect(parseHook(GOOD)).toEqual({ ...GOOD, hookType: 'claim' });
    expect(parseHook({ ...GOOD, hookType: 'mystery' })!.hookType).toBe('other');
  });

  test('unusable shapes are null', () => {
    for (const bad of [null, 'text', [], {}, { hook: '   ' }, { hook: 5 }]) expect(parseHook(bad)).toBeNull();
  });

  test('the model sees at most the first 1,500 words and the caption', () => {
    const msg = hookUserMessage(Array.from({ length: 4000 }, (_, i) => `w${i}`).join(' '), 'cap');
    expect(msg).toContain('## Caption\ncap');
    const body = msg.split('## Transcript\n')[1]!;
    expect(body.split(' ')).toHaveLength(HOOK_INPUT_WORDS);
    expect(body.endsWith(`w${HOOK_INPUT_WORDS - 1}`)).toBe(true);
  });

  test('hook token budget leaves room for the model to reason before the JSON', () => {
    expect(HOOK_MAX_TOKENS).toBeGreaterThanOrEqual(2_000);
  });
});

function videoHarness(over: Partial<VideoDeps> = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  let cleaned: string | null = null;
  const deps: VideoDeps = {
    workspaceId: 'ws-tools',
    now: () => NOW,
    assertBudget: async (n) => { calls.push(`budget:${n}`); },
    makeTempDir: async () => '/tmp/slashloop-tools-video-abc',
    download: async () => { calls.push('download'); return { bytes: 4_200_000, slideshow: false }; },
    probeDuration: async () => 31,
    extractAudio: async (_i, o) => { calls.push('ffmpeg'); return o; },
    readFile: async (p) => { calls.push(`read:${p}`); return Buffer.from('a'); },
    transcribe: async () => { calls.push('whisper'); return WHISPER_OUT; },
    hook: async () => { calls.push('hook'); return { hook: 'Stop scrolling.', hookType: 'claim', firstSeconds: 'x', whyItWorks: 'y' }; },
    cleanup: async (dir) => { cleaned = dir; return []; },
    log: (l) => logs.push(l),
    ...over,
  };
  return { deps, calls, logs, cleaned: () => cleaned };
}

describe('runVideoLookup', () => {
  test('happy path: budget first, ffmpeg audio to Whisper, hook, bytes reported, temp dir removed', async () => {
    const h = videoHarness();
    const out = await runVideoLookup(PAYLOAD, h.deps);
    expect(out.status).toBe('done');
    if (out.status !== 'done') throw new Error('unreachable');
    expect(out.result).toMatchObject({
      videoId: PAYLOAD.videoId,
      durationSec: 31.5,
      language: 'en',
      bytes: 4_200_000,
      hook: { hook: 'Stop scrolling.', hookType: 'claim' },
    });
    expect(h.calls).toEqual([`budget:${VIDEO_ESTIMATE_BYTES}`, 'download', 'ffmpeg', 'read:/tmp/slashloop-tools-video-abc/audio.mp3', 'whisper', 'hook']);
    expect(h.cleaned()).toBe('/tmp/slashloop-tools-video-abc');
    expect(h.logs[0]).toContain('bytes=4200000');
    expect(h.logs[0]).toContain('whisperSec=31.5');
    expect(h.logs[0]).toContain('tmpLeft=[]');
  });

  test('without ffmpeg the MP4 itself goes to Whisper', async () => {
    const h = videoHarness({ extractAudio: async () => null });
    await runVideoLookup(PAYLOAD, h.deps);
    expect(h.calls).toContain('read:/tmp/slashloop-tools-video-abc/in.mp4');
  });

  test('a failing ffmpeg falls back to the MP4 instead of failing the lookup', async () => {
    const h = videoHarness({ extractAudio: async () => { throw new Error('ffmpeg failed'); } });
    expect((await runVideoLookup(PAYLOAD, h.deps)).status).toBe('done');
    expect(h.calls).toContain('read:/tmp/slashloop-tools-video-abc/in.mp4');
  });

  test('budget refusal downloads nothing and creates no temp dir', async () => {
    const err = Object.assign(new Error('cap'), { name: 'TrafficCapExceededError' });
    let made = false;
    const h = videoHarness({ assertBudget: async () => { throw err; }, makeTempDir: async () => { made = true; return '/x'; } });
    expect(await runVideoLookup(PAYLOAD, h.deps)).toEqual({ status: 'failed', code: 'budget' });
    expect(h.calls).toEqual([]);
    expect(made).toBe(false);
  });

  test('photo slideshow -> slideshow, with no audio work, and the temp dir is still removed', async () => {
    const h = videoHarness({ download: async () => ({ bytes: 0, slideshow: true }) });
    expect(await runVideoLookup(PAYLOAD, h.deps)).toEqual({ status: 'failed', code: 'slideshow' });
    expect(h.calls).not.toContain('whisper');
    expect(h.cleaned()).toBe('/tmp/slashloop-tools-video-abc');
  });

  test('over ten minutes -> too_long, by ffprobe before Whisper and by Whisper duration after', async () => {
    const probed = videoHarness({ probeDuration: async () => MAX_AUDIO_SECONDS + 1 });
    expect(await runVideoLookup(PAYLOAD, probed.deps)).toEqual({ status: 'failed', code: 'too_long' });
    expect(probed.calls).not.toContain('whisper');

    const noProbe = videoHarness({
      probeDuration: async () => null,
      transcribe: async () => ({ ...WHISPER_OUT, durationSec: MAX_AUDIO_SECONDS + 5 }),
    });
    expect(await runVideoLookup(PAYLOAD, noProbe.deps)).toEqual({ status: 'failed', code: 'too_long' });
  });

  test('scraper and Whisper errors map to codes and still clean up', async () => {
    const blocked = videoHarness({ download: async () => { throw new Error('HTTP 429 from TikTok'); } });
    expect(await runVideoLookup(PAYLOAD, blocked.deps)).toEqual({ status: 'failed', code: 'blocked' });
    expect(blocked.cleaned()).not.toBeNull();

    const broken = videoHarness({ transcribe: async () => { throw new Error('Workers AI answered 500'); } });
    expect(await runVideoLookup(PAYLOAD, broken.deps)).toEqual({ status: 'failed', code: 'error' });
    expect(broken.cleaned()).not.toBeNull();
  });

  test('a hook failure or bad hook JSON keeps the transcript and nulls the hook', async () => {
    for (const hook of [async () => { throw new Error('llm down'); }, async () => ({ nope: true })]) {
      const h = videoHarness({ hook });
      const out = await runVideoLookup(PAYLOAD, h.deps);
      expect(out.status).toBe('done');
      if (out.status === 'done') {
        expect(out.result.hook).toBeNull();
        expect(out.result.text).toContain('Stop scrolling');
      }
    }
  });

  test('silent video: empty transcript, no hook call', async () => {
    const h = videoHarness({ transcribe: async () => ({ ...WHISPER_OUT, text: '', segments: [] }) });
    const out = await runVideoLookup(PAYLOAD, h.deps);
    expect(out.status === 'done' && out.result.hook).toBeNull();
    expect(h.calls).not.toContain('hook');
  });

  test('leftovers in the tmp dir are logged', async () => {
    const h = videoHarness({ cleanup: async () => ['slashloop-tools-video-stale'] });
    await runVideoLookup(PAYLOAD, h.deps);
    expect(h.logs[0]).toContain('tmpLeft=[slashloop-tools-video-stale]');
  });
});

describe('processToolsJob tools-video', () => {
  const WS = 'ws-tools';
  const job = (over: Record<string, unknown> = {}) => ({
    id: 'job-12345678',
    kind: 'tools-video',
    workspaceId: WS,
    payloadJson: JSON.stringify({
      videoUrl: URL_OK,
      videoId: PAYLOAD.videoId,
      requestId: 'req-1',
      callbackUrl: 'https://mcp.slashloop.dev/api/tools/internal/result',
      ...over,
    }),
  });

  function harness(video: VideoDeps) {
    const posted: any[] = [];
    const completed: string[] = [];
    const recorded: unknown[] = [];
    const deps: ToolsJobDeps = {
      env: { TOOLS_WORKSPACE_ID: WS, TOOLS_CALLBACK_SECRET: 'shh' } as NodeJS.ProcessEnv,
      now: () => NOW,
      measure: async (fn) => ({ value: await fn(), bytes: 1 }),
      buildLookup: () => { throw new Error('video job never builds the profile lookup'); },
      buildVideo: () => video,
      recordBytes: async (...a) => { recorded.push(a); },
      callback: {
        fetch: async (_u, init) => { posted.push(JSON.parse(init.body)); return { status: 204 }; },
        nowSeconds: () => 1,
        nonce: () => 'n',
        sleep: async () => {},
      },
      completeJob: async (id) => { completed.push(id); },
      failJob: async () => ({}),
    };
    return { deps, posted, completed, recorded };
  }

  test('done: callback carries the transcript result; bytes are not double-recorded', async () => {
    const h = harness(videoHarness().deps);
    const r = await processToolsJob(job(), h.deps);
    expect(r.ok).toBe(true);
    expect(h.posted[0]).toMatchObject({ requestId: 'req-1', status: 'done', result: { videoId: PAYLOAD.videoId, language: 'en', bytes: 4_200_000 } });
    expect(h.recorded).toEqual([]);
    expect(h.completed).toEqual(['job-12345678']);
  });

  test('slideshow is reported as failed/slideshow and does not trip the breaker', async () => {
    const h = harness(videoHarness({ download: async () => ({ bytes: 0, slideshow: true }) }).deps);
    const r = await processToolsJob(job(), h.deps);
    expect(h.posted).toEqual([{ requestId: 'req-1', status: 'failed', code: 'slideshow' }]);
    expect(r.ok).toBe(true);
  });

  test('a payload that is not a canonical TikTok watch URL never reaches the downloader', async () => {
    const v = videoHarness();
    const h = harness(v.deps);
    await processToolsJob(job({ videoUrl: 'https://evil.example/@a/video/' + PAYLOAD.videoId }), h.deps);
    expect(v.calls).toEqual([]);
    expect(h.posted).toEqual([{ requestId: 'req-1', status: 'failed', code: 'not_found' }]);
  });

  test('blocked counts against the kind', async () => {
    const h = harness(videoHarness({ download: async () => { throw new Error('403 waf'); } }).deps);
    const r = await processToolsJob(job(), h.deps);
    expect(r.ok).toBe(false);
  });
});
