import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BriefDataSchema } from './schema.js';
import { modelJson } from '../lib/llm.js';
import {
  failedScriptJson,
  generatingScriptJson,
  indexLatestScripts,
  logicalScriptId,
  normalizeScriptDuration,
  readStoredScript,
  toScriptListItem,
} from './script-delivery.js';

const ready = {
  format: 'problem_solution',
  hook: 'Your notes app is the bottleneck',
  beats: [
    { timestampSec: 0, voiceover: 'Open on the mess', visual: 'selfie' },
    { timestampSec: 3, voiceover: 'Then the app', visual: 'screen recording' },
    { timestampSec: 8, voiceover: 'The proof', visual: 'before and after' },
  ],
  cta: 'Link in bio',
  caption: 'The app that files itself',
  hashtags: ['#buildinpublic'],
  whyThisWorks: 'Pain then proof',
};

describe('readStoredScript', () => {
  test('parses a finished script and the reservation sentinels', () => {
    const stored = readStoredScript(JSON.stringify(ready));
    expect(stored.status).toBe('ready');
    expect(readStoredScript(generatingScriptJson('2026-09-30T11:00:00.000Z'))).toEqual({
      status: 'generating',
      since: '2026-09-30T11:00:00.000Z',
    });
    expect(readStoredScript(failedScriptJson('model down'))).toEqual({ status: 'failed', error: 'model down' });
    expect(readStoredScript('not-json').status).toBe('unreadable');
  });

  test('list item keeps the id and drops the body', () => {
    const item = toScriptListItem({
      id: 's1',
      analysisId: 'a',
      format: 'pov_demo',
      createdAt: new Date('2026-09-30T11:00:00.000Z'),
      videoId: 'v',
      scriptJson: JSON.stringify(ready),
    });
    expect(item.id).toBe('s1');
    expect(item.hook).toContain('notes app');
    expect(item).not.toHaveProperty('scriptJson');
    expect(JSON.stringify(item)).not.toContain('before and after');
  });
});

describe('logicalScriptId', () => {
  const base = {
    workspaceId: 'w',
    analysisId: 'a',
    format: 'problem_solution',
    appDescription: 'A notes app for founders',
    durationSec: 20,
  };

  test('identical inputs share an id, and whitespace does not mint a new one', () => {
    const id = logicalScriptId(base);
    expect(id).toBe(logicalScriptId({ ...base, appDescription: '  A notes app   for founders  ' }));
    expect(logicalScriptId({ ...base, format: 'pov_demo' })).not.toBe(id);
    expect(normalizeScriptDuration(undefined)).toBe(20);
    expect(normalizeScriptDuration(9)).toBe(10);
  });

  test('keeps the newest script per analysis', () => {
    const refs = indexLatestScripts([
      { id: 'old', analysisId: 'a', createdAt: '2026-09-30T10:00:00.000Z', scriptJson: JSON.stringify(ready) },
      { id: 'new', analysisId: 'a', createdAt: '2026-09-30T11:00:00.000Z', scriptJson: generatingScriptJson() },
    ]);
    expect(refs.get('a')).toEqual({ scriptId: 'new', scriptStatus: 'generating' });
  });
});

describe('model envelope', () => {
  test('a brief schema rejects the token envelope and accepts modelJson', () => {
    const brief = {
      concept: 'Reveal the feature',
      hook: 'Open on the feature',
      creatorDirection: 'Deadpan',
      talkingPoints: ['Show the result'],
      visualBeats: [{ timestampSec: 0, description: 'Feature, no face' }],
      whatNotToCopy: ['The original product'],
      deliverableSpecs: { length: '15-30 seconds', format: 'vertical 9:16', platform: 'tiktok' },
    };
    const envelope = { parsed: brief, inputTokens: 3, outputTokens: 4 };
    expect(BriefDataSchema.safeParse(envelope).success).toBe(false);
    expect(BriefDataSchema.safeParse(modelJson(envelope)).success).toBe(true);
  });

  test('brief and script generation validate modelJson, not the envelope', () => {
    for (const file of ['briefs.ts', 'scripts.ts', 'hooks.ts']) {
      const src = readFileSync(new URL(`./${file}`, import.meta.url), 'utf8');
      expect(src).toContain('modelJson(');
      expect(src).not.toMatch(/safeParse\(parsed\)/);
    }
  });
});

test('generate_script is annotated as a write and debits on the logical id', () => {
  const src = readFileSync(new URL('../tools/creative.ts', import.meta.url), 'utf8');
  const start = src.indexOf("server.tool('generate_script'");
  const end = src.indexOf("server.tool('get_script'");
  const body = src.slice(start, end);
  expect(body).toContain('readOnlyHint: false');
  expect(body).toContain('idempotencyKey: scriptId');
  expect(body).toContain('logicalScriptId');
  expect(src).toContain("server.tool('list_scripts'");
  expect(src).toContain('scriptId: scriptRef?.scriptId ?? null');
});
