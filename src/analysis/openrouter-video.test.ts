// OpenRouter video analyzer: truncation handling and failure diagnostics (SLA-947).
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { OpenRouterVideoAnalyzer } from './openrouter-video.js';

const realFetch = globalThis.fetch;
const realWarn = console.warn;
const env = { ...process.env };

interface Reply { content: string; finish: string }
let replies: Reply[] = [];
let sentMaxTokens: number[] = [];
let warns: string[] = [];

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = 'test-key';
  process.env.OPENROUTER_VIDEO_MODEL = 'qwen/qwen3-vl-235b-a22b-instruct';
  process.env.OPENROUTER_VIDEO_MAX_TOKENS = '1000';
  replies = [];
  sentMaxTokens = [];
  warns = [];
  console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')); };
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    sentMaxTokens.push(JSON.parse(init!.body!).max_tokens);
    const r = replies.shift()!;
    return new Response(JSON.stringify({
      choices: [{ message: { content: r.content }, finish_reason: r.finish }],
      usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0 },
    }), { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.warn = realWarn;
  process.env = { ...env };
});

const ctx = {
  videoId: 'v1', videoUrl: 'https://tiktok.example/v', thumbnailUrl: '', caption: 'c', transcript: null,
  transcriptSource: 'none', platform: 'tiktok', creatorHandle: '@a', creatorFollowers: 1000,
  postedAt: '2026-10-01T00:00:00Z', views: 10, likes: 1, comments: 0, shares: null, saves: null,
  durationSec: 20, outlierScore: null, outlierExplanation: null, workspaceId: 'ws-1',
  storedMediaUrl: 'https://media.example/v.mp4',
} as never;
const analyzer = () => new OpenRouterVideoAnalyzer();

describe('OpenRouterVideoAnalyzer — unparsable output', () => {
  test('logs finish_reason, rawLen and maxTokens on an unparsable failure', async () => {
    const raw = 'I could not analyse this video.';
    replies = [{ content: raw, finish: 'stop' }];
    const err = await analyzer().analyze(ctx).catch((e: Error) => e);
    expect((err as Error).message).toContain('OpenRouter video returned unparsable output');
    expect((err as Error).message).toContain('finish_reason=stop');
    expect((err as Error).message).toContain(`rawLen=${raw.length}`);
    expect((err as Error).message).toContain('maxTokens=1000');
    expect(sentMaxTokens).toEqual([1000]);
  });

  test('finish_reason=length retries once with a doubled budget', async () => {
    replies = [
      { content: '{ "keyMoments": [ { "timestampSec": 0.5, "role": "hook"', finish: 'length' },
      { content: 'still not json', finish: 'stop' },
    ];
    const err = await analyzer().analyze(ctx).catch((e: Error) => e);
    expect(sentMaxTokens).toEqual([1000, 2000]);
    expect(warns.some((w) => w.includes('finish_reason=length') && w.includes('retrying once with maxTokens=2000'))).toBe(true);
    expect((err as Error).message).toContain('maxTokens=2000');
  });

  test('a length-truncated retry is repaired, then left to schema validation', async () => {
    const cut = '{ "keyMoments": [ { "timestampSec": 0.5, "role": "hook" }, { "timestampSec": 3, "ro';
    replies = [
      { content: cut, finish: 'length' },
      { content: cut, finish: 'length' },
    ];
    const err = await analyzer().analyze(ctx).catch((e: Error) => e);
    expect(warns.some((w) => w.includes('repaired truncated JSON'))).toBe(true);
    // The repaired prefix is not a full analysis, so validation — not the
    // JSON parser — is what rejects it, with an actionable message.
    expect((err as Error).message).toContain('failed schema validation');
  });

  test('does not retry when the output was not cut by the token limit', async () => {
    replies = [{ content: '{ "keyMoments": [', finish: 'stop' }];
    await analyzer().analyze(ctx).catch(() => {});
    expect(sentMaxTokens).toEqual([1000]);
  });
});
