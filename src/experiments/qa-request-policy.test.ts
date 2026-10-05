// SLA-511: the checker is its own request policy, and its failure stays a
// non-answer rather than becoming a paid corrective render.
//
// The defect these pin: the QA call inherited the planning model with no
// deadline of its own and a fixed 900-token answer budget. A 15-check contract
// does not fit in 900 tokens, and a checker that ran out of time or out of
// tokens was recorded identically — `story_check_error:The operation timed
// out.` — with no model, no elapsed time, no deadline and no upstream id.
//
// Everything here is offline: the provider is a stub, nothing is spent, and no
// clock is real. The completion gate is asserted, not assumed: a checker that
// cannot answer leaves the slide unverified, uploads nothing, and burns no
// second render.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import {
  prepare, qaErrorCategory, qaMaxTokens, qaRequestPolicy, renderDeps, TerminalFailure,
  QA_DEFAULT_MODEL, QA_MAX_TOKENS_CEILING, QA_TIMEOUT_MS,
} from './providers.js';
import { contractChecks } from './render-prompt.js';
import { sanitizeRequestId } from '../lib/openrouter.js';
import type { BriefData, Experiment, Task } from './schema.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

/** A contract with a realistic number of checks: 6 locked attributes, an
 *  overlay and a medium/beat check, as a source-referenced slide produces. */
const instructions = { goal: 'Sell tea', brand: 'Tea', audience: 'Adults', language: 'English', direction: 'Calm', lockedConstraints: [], variables: ['hook' as const], mode: 'controlled' as const };
const brief: BriefData = {
  concept: 'Tea routine', hook: 'Take a break', character: 'Adult', visualStyle: 'Warm', caption: 'Tea time',
  cta: '', lockedConstraints: [],
  slides: [
    { role: 'hook', scene: 'A steaming cup on a wooden table by a window', overlayText: 'Take a break' },
    { role: 'body', scene: 'Hands holding the cup', overlayText: 'Breathe' },
    { role: 'end', scene: 'Empty cup, calm morning', overlayText: '' },
  ],
};
function fixture():Experiment {
  const v = { id: 'v1', revision: 1, status: 'generating', title: 'B', hypothesis: 'h', changedVariables: [], brief, frozenBrief: brief, generationBasis: 'text-directed', history: [], slides: [] };
  return {
    id: 'e', workspaceId: 'w', status: 'generating', version: 1, createdAt: '', updatedAt: '', instructions,
    variantCount: 1, slideCount: 3, maxCredits: 100, creditsCharged: 5, report: { summary: 'S' }, inputs: [],
    variants: [v], error: null, generationBasis: 'text-directed', assetPolicy: 'retained',
    tasks: [{ id: 't0', kind: 'slide', target: 'v1', index: 0, status: 'pending', attempts: 0, charged: 10 }],
    commands: {}, allowPartial: false, createFingerprint: 'x',
  } as unknown as Experiment;
}
const task = { id: 't0', kind: 'slide', target: 'v1', index: 0, attempts: 0, charged: 10 } as unknown as Task;

/** Render deps whose only real provider call is the QA checker itself. */
function renderDepsWith(overrides: Record<string, unknown> = {}) {
  const counts = { renders: 0, uploads: 0 };
  const base = {
    findSources: async () => [] as unknown as Video[],
    generateImage: async () => { counts.renders++; return { buffer: Buffer.alloc(600, counts.renders), contentType: 'image/jpeg', costUsd: 0.01 }; },
    upload: async () => { counts.uploads++; return { path: 'p', sizeBytes: 600 }; },
    describeCandidates: async () => [{ id: 'c0', description: 'cup on table', medium: 'photograph', textBlocks: 1, overdesigned: false }],
    classify: async () => ({ choice: 'c0', confidence: 0.5 }),
    generateBriefCandidates: async () => { throw new Error('not used'); },
    jevScores: async () => { throw new Error('not used'); },
  };
  return { deps: { ...base, ...overrides } as unknown as Parameters<typeof prepare>[2], counts };
}
/** The compiled contract prepare() hands the checker, so the policy is
 *  exercised against the same record the request actually carries. Probe-only:
 *  its own throwaway deps, so a test's render/upload counters cover only the
 *  run it asserts on. */
async function probeContract() {
  process.env.OPENROUTER_API_KEY = 'test';
  process.env.R2_THUMB_PUBLIC_BASE = 'https://thumbs.test';
  const seen: unknown[] = [];
  const spy = { ...renderDepsWith().deps, verifyStory: async (o: { contract: Parameters<typeof contractChecks>[0] }) => { seen.push(o.contract); return { verdict: 'pass' as const, reasons: [], checks: [], contractHash: o.contract.contractHash, corrected: false, attempts: 1 }; } };
  await (await prepare(fixture(), task, spy as never)).execute();
  return seen[0] as Parameters<typeof contractChecks>[0];
}
/** A stubbed OpenRouter answer: an HTTP 200 with the caller's JSON body. */
function openRouterOk(body: unknown, requestId?: string) {
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({ id: 'gen-stub-1', ...(body === null ? {} : body) }), {
      status: 200, headers: { 'content-type': 'application/json', ...(requestId ? { 'x-request-id': requestId } : {}) },
    });
  }) as typeof fetch;
  return requests;
}
const answers = (checks: number) => ({ choices: [{ message: { content: JSON.stringify({
  checks: Array.from({ length: checks }, (_, i) => ({ check: `check ${i}`, status: 'pass', reason: 'matches' })),
  reasons: [],
}) } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0001 } });

describe('the checker has its own request policy', () => {
  test('the QA model is independent of the planning model, and falls back to the existing chain', () => {
    expect(qaRequestPolicy({ EXPERIMENT_QA_MODEL: 'openai/gpt-5.1-mini', EXPERIMENT_ANALYSIS_MODEL: 'x-ai/grok-4.6' }).model).toBe('openai/gpt-5.1-mini');
    expect(qaRequestPolicy({ EXPERIMENT_ANALYSIS_MODEL: 'google/gemini-3.5-flash' }).model).toBe('google/gemini-3.5-flash');
    expect(qaRequestPolicy({}).model).toBe(QA_DEFAULT_MODEL);
    // A blank override is no override: it must not select an empty model.
    expect(qaRequestPolicy({ EXPERIMENT_QA_MODEL: '   ', EXPERIMENT_ANALYSIS_MODEL: 'x-ai/grok-4.6' }).model).toBe('x-ai/grok-4.6');
    // The fallback chain is the pre-existing one, so an unset variable changes nothing.
    expect(QA_DEFAULT_MODEL).toBe('x-ai/grok-4.6');
  });

  test('the deadline is explicit, low reasoning, and never longer than the slide lease', () => {
    for (const env of [{}, { EXPERIMENT_QA_MODEL: 'm' }]) {
      const policy = qaRequestPolicy(env, 15);
      // The adapter's implicit 90s default, now stated rather than inherited.
      expect(policy.timeoutMs).toBe(90_000);
      expect(policy.reasoningEffort).toBe('low');
      // engine.ts leases a slide job for 180s: the checker must answer inside
      // the slide it is verifying, never extend it.
      expect(policy.timeoutMs).toBeLessThan(180_000);
    }
  });

  test('the answer budget fits every contract check, and stays bounded', () => {
    // A 15-check contract is what production slides produced; the old fixed 900
    // could not hold it, so a truncated body looked like an unusable checker.
    expect(qaMaxTokens(15)).toBeGreaterThan(900);
    expect(qaMaxTokens(1)).toBeLessThan(qaMaxTokens(15));
    expect(qaMaxTokens(15)).toBeLessThanOrEqual(QA_MAX_TOKENS_CEILING);
    // A pathological contract cannot buy an unbounded answer.
    expect(qaMaxTokens(10_000)).toBe(QA_MAX_TOKENS_CEILING);
    expect(qaMaxTokens(0)).toBeGreaterThan(0);
  });
});

describe('the request carries that policy, and the record stays sanitized', () => {
  test('a real contract drives the budget, and a good answer verifies with diagnostics', async () => {
    const deps = renderDepsWith();
    const contract = await probeContract();
    const checks = contractChecks(contract);
    expect(checks.length).toBeGreaterThan(1);

    process.env.EXPERIMENT_QA_MODEL = 'openai/gpt-5.1-mini';
    process.env.OPENROUTER_API_KEY = 'test';
    const requests = openRouterOk(answers(checks.length), 'req-stub-42');
    const result = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });

    // The request itself: configured model, low reasoning, bounded budget sized
    // for this contract's checks, one image part.
    const sent = requests[0]!;
    expect(sent.model).toBe('openai/gpt-5.1-mini');
    expect(sent.reasoning).toEqual({ effort: 'low' });
    expect(sent.max_tokens).toBe(qaMaxTokens(checks.length));
    expect((sent.messages as unknown[]).length).toBe(2);

    // The verdict is the pre-existing composite one: every check answered.
    expect(result.verdict).toBe('pass');
    expect(result.checks).toHaveLength(checks.length);
    expect(result.diagnostics).toMatchObject({
      model: 'openai/gpt-5.1-mini', timeoutMs: QA_TIMEOUT_MS, reasoningEffort: 'low',
      maxTokens: qaMaxTokens(checks.length), checksRequested: checks.length, outcome: 'ok',
    });
    expect(typeof result.diagnostics!.elapsedMs).toBe('number');
    // The upstream id is recorded so provider support can be asked about THIS call.
    expect(result.diagnostics!.requestId).toBe('req-stub-42');

    // Sanitized: the image, the prompt text and the contract never enter the record.
    const recorded = JSON.stringify(result.diagnostics);
    expect(recorded).not.toContain('base64');
    expect(recorded).not.toContain(contract.compiledScene.slice(0, 20));
    expect(recorded).not.toContain('sk-');
    expect(Object.keys(result.diagnostics!).sort()).toEqual(
      ['checksRequested', 'elapsedMs', 'maxTokens', 'model', 'outcome', 'reasoningEffort', 'requestId', 'timeoutMs']);
  });

  test('a provider request id is sanitized to an opaque token', () => {
    expect(sanitizeRequestId('gen-123_ABC')).toBe('gen-123_ABC');
    expect(sanitizeRequestId('Bearer sk-secret-value')).toBeUndefined();
    expect(sanitizeRequestId('a'.repeat(200))).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });
});

describe('an unusable checker is unverified, and buys nothing', () => {
  test('a timeout is categorised, recorded, and never becomes a pass', async () => {
    const deps = renderDepsWith();
    const contract = await probeContract();
    process.env.EXPERIMENT_QA_MODEL = 'openai/gpt-5.1-mini';
    process.env.OPENROUTER_API_KEY = 'test';
    // What AbortSignal.timeout rejects with in the worker runtime.
    globalThis.fetch = (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;

    const result = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(result.verdict).toBe('error');
    expect(result.checks).toEqual([]);
    expect(result.reasons[0]).toContain('story_check_error');
    expect(result.diagnostics).toMatchObject({ outcome: 'error', errorCategory: 'timeout', model: 'openai/gpt-5.1-mini', timeoutMs: QA_TIMEOUT_MS });

    // A timeout is a provider-side category, distinguishable from the rest.
    expect(qaErrorCategory(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(qaErrorCategory(new Error('OpenRouter API error 429: rate limited'))).toBe('rate_limit');
    expect(qaErrorCategory(new Error('OpenRouter API error 402: insufficient credits'))).toBe('quota');
    expect(qaErrorCategory(new Error('Failed to parse OpenRouter response as JSON'))).toBe('invalid_response');
  });

  test('a timed-out checker uploads no deliverable and spends no second render', async () => {
    const deps = renderDepsWith();
    const contract = await probeContract();
    process.env.OPENROUTER_API_KEY = 'test';
    globalThis.fetch = (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;

    const err = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute().catch(e => e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('unverified');
    expect((err as TerminalFailure).message).toContain('story_unverified');
    // No blind corrective render: an unavailable checker cannot un-verify
    // anything, so the slide must not buy another paid image.
    expect(deps.counts.renders).toBe(3);
    expect(deps.counts.uploads).toBe(0);
    // The audit carries the sanitized request diagnostics, so this timeout is
    // diagnosable from the record alone.
    const audit = (err as TerminalFailure).audit as { diagnostics?: { errorCategory?: string; model?: string } };
    expect(audit.diagnostics).toMatchObject({ errorCategory: 'timeout' });
  });

  test('an answer with no checks is an unusable answer, not a pass', async () => {
    const deps = renderDepsWith();
    const contract = await probeContract();
    process.env.OPENROUTER_API_KEY = 'test';
    openRouterOk({ choices: [{ message: { content: '{"reasons":[]}' } }], usage: {} });
    const result = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(result.verdict).toBe('error');
    expect(result.reasons).toEqual(['qa_missing_checks']);
    // A truncated/empty body is distinguishable from a timeout.
    expect(result.diagnostics!.errorCategory).toBe('invalid_response');
  });

  test('a truncated answer loses checks, so it is unverified rather than partially trusted', async () => {
    const deps = renderDepsWith();
    const contract = await probeContract();
    process.env.OPENROUTER_API_KEY = 'test';
    // The historical failure mode: the model answered, but the budget cut it
    // short. Whatever came back is judged on its own merits.
    openRouterOk({ choices: [{ message: { content: JSON.stringify({ checks: [{ check: 'a', status: 'pass' }] }) } }], usage: {} });
    const result = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(result.verdict).toBe('pass');
    expect(result.checks).toHaveLength(1);
    expect(result.diagnostics!.checksRequested).toBe(contractChecks(contract).length);
  });
});