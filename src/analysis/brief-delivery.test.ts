import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  briefFailurePayload,
  briefGeneratingPayload,
  failedBriefJson,
  generatingBriefJson,
  indexLatestBriefs,
  readStoredBrief,
  raceBudget,
  toBriefListItem,
} from './brief-delivery.js';

const readyJson = JSON.stringify({
  concept: 'Reveal the feature with no intro',
  hook: 'Open on the finished feature',
  creatorDirection: 'Deadpan, locked-off phone',
  talkingPoints: ['Show the result first'],
  visualBeats: [{ timestampSec: 0, description: 'Finished feature, no face' }],
  whatNotToCopy: ['The original product'],
  deliverableSpecs: { length: '15-30 seconds', format: 'vertical 9:16', platform: 'tiktok' },
});

describe('readStoredBrief', () => {
  test('parses a completed brief', () => {
    const stored = readStoredBrief(readyJson);
    expect(stored.status).toBe('ready');
    if (stored.status === 'ready') expect(stored.brief.concept).toContain('feature');
  });

  test('distinguishes a reserved row from a failure', () => {
    expect(readStoredBrief(generatingBriefJson()).status).toBe('generating');
    const failed = readStoredBrief(failedBriefJson('model down'));
    expect(failed).toEqual({ status: 'failed', error: 'model down' });
  });

  test('does not throw on garbage', () => {
    expect(readStoredBrief('not-json').status).toBe('unreadable');
    expect(readStoredBrief('{"concept":1}').status).toBe('unreadable');
  });
});

describe('raceBudget', () => {
  test('returns the value when work finishes inside the budget', async () => {
    const raced = await raceBudget(Promise.resolve('brief-1'), 1_000);
    expect(raced).toEqual({ kind: 'done', value: 'brief-1' });
  });

  test('returns budget when work is still running', async () => {
    let release: (value: string) => void = () => {};
    const work = new Promise<string>((resolve) => { release = resolve; });
    const raced = await raceBudget(work, 15);
    expect(raced.kind).toBe('budget');
    release('later');
    expect(await work).toBe('later');
  });

  test('rejects when work fails before the budget', async () => {
    await expect(raceBudget(Promise.reject(new Error('gemini down')), 1_000)).rejects.toThrow('gemini down');
  });
});

describe('recovery index', () => {
  test('keeps the newest brief per analysis', () => {
    const refs = indexLatestBriefs([
      { id: 'old', analysisId: 'a', createdAt: '2026-09-30T10:00:00.000Z', briefJson: readyJson },
      { id: 'new', analysisId: 'a', createdAt: '2026-09-30T11:00:00.000Z', briefJson: generatingBriefJson() },
      { id: 'other', analysisId: 'b', createdAt: '2026-09-30T09:00:00.000Z', briefJson: readyJson },
    ]);
    expect(refs.get('a')).toEqual({ briefId: 'new', briefStatus: 'generating' });
    expect(refs.get('b')?.briefId).toBe('other');
  });

  test('list item exposes the id and hides the full json', () => {
    const item = toBriefListItem({
      id: 'b1',
      analysisId: 'a',
      ideaId: null,
      videoId: 'v',
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
      briefJson: readyJson,
    });
    expect(item.id).toBe('b1');
    expect(item.concept).toContain('feature');
    expect(item).not.toHaveProperty('briefJson');
  });
});

describe('create_brief payloads', () => {
  test('a failure that reserved a row still returns that id', () => {
    const body = briefFailurePayload({ message: 'validation failed', briefId: 'b1', creditsRemaining: 10 });
    expect(body.id).toBe('b1');
    expect(body.briefId).toBe('b1');
    expect(body.creditsCharged).toBe(0);
  });

  test('a slow generation returns the reserved id instead of holding the request', () => {
    const body = briefGeneratingPayload({ id: 'b2', creditsCharged: 2, creditsRemaining: 8 });
    expect(body.id).toBe('b2');
    expect(body.status).toBe('generating');
    expect(body.recovery.args.briefId).toBe('b2');
  });

  test('the create_brief handler does not rethrow once the call has started', () => {
    const src = readFileSync(new URL('../tools/creative.ts', import.meta.url), 'utf8');
    const start = src.indexOf("server.tool('create_brief'");
    const end = src.indexOf("server.tool('get_brief'");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(src.slice(start, end)).not.toContain('throw ');
  });
});
