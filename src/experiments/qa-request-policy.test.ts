// SLA-511: the checker is its own request policy, a pass requires the answer it
// asked for, and a checker that cannot answer buys nothing.
//
// Three defects these pin:
//  1. the QA call inherited the planning model with no deadline of its own, and
//     a timeout was recorded identically to a refusal — no model, no elapsed
//     time, no deadline, no upstream id;
//  2. a composite pass accepted ANY non-empty array of passing entries, so
//     answering one of fifteen requested checks verified the whole slide;
//  3. an `error` (unavailable or unusable QA) bought a second paid render wave
//     whenever the candidate was also off-style.
//
// Everything here is offline: the provider is a stub, nothing is spent, and no
// clock is real. The completion gate is asserted, not assumed: a checker that
// cannot answer — and an answer that does not cover the contract — leave the
// slide unverified, upload nothing, and burn no second render.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import {
  prepare, qaCoverageProblem, qaErrorCategory, qaMaxTokens, qaRequestPolicy, renderDeps,
  resolveQaVerdict, TerminalFailure,
  QA_DEFAULT_MODEL, QA_MAX_TOKENS_CEILING, QA_TIMEOUT_MS, type QaDiagnostics,
} from './providers.js';
import { compileSlideContract, contractChecks, contractQaBlock } from './render-prompt.js';
import { sanitizeRequestId } from '../lib/openrouter.js';
import { admission } from './test-admission.js';
import { slideFanout } from './schema.js';
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
/** The check list the checker is actually asked for.
 *
 *  SLA-522: an unobserved preserved lock is a COMPARISON against the mapped
 *  source frame, and a contract whose own source map says `referenceKind:'none'`
 *  has no such frame — so it asks absolute requirements instead. `probeContract()`
 *  resolves a text-directed fixture, hence `sourceBaseline:false` here; a
 *  contract built from a mapped source keeps the comparative labels. */
function requestedChecks(c: Parameters<typeof contractChecks>[0]): string[] {
  return contractChecks(c, { sourceBaseline: c.sourceMap.referenceKind !== 'none' });
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
/** A 200 answer whose `checks` are the ones the contract actually asked for —
 *  the fixture a well-behaved checker produces. Labels come from the contract,
 *  never from a made-up list. */
function answersFor(labels: readonly string[], status: 'pass'|'fail'|'unknown' = 'pass') {
  return { choices: [{ message: { content: JSON.stringify({
    checks: labels.map(check => ({ check, status, reason: 'matches the contract item' })),
    reasons: [],
  }) } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0001 } };
}
/** An HTTP response the adapter can judge, with control over status, headers and body. */
function openRouterResponse(opts: { status: number; body?: unknown; raw?: string; headers?: Record<string, string> }) {
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    requests.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return new Response(opts.raw ?? JSON.stringify(opts.body), {
      status: opts.status,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    });
  }) as unknown as typeof fetch;
  return requests;
}

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

  test('the answer budget scales with the contract, and stays bounded', () => {
    // A heuristic, not a measurement: the request stops asking one fixed size
    // for every contract, and one verbose answer can still exceed it — which is
    // what the coverage check below turns into `unverified`, never into a pass.
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
    const checks = requestedChecks(contract);
    expect(checks.length).toBeGreaterThan(1);

    process.env.EXPERIMENT_QA_MODEL = 'openai/gpt-5.1-mini';
    process.env.OPENROUTER_API_KEY = 'test';
    const requests = openRouterResponse({ status: 200, body: answersFor(checks), headers: { 'x-request-id': 'req-stub-42' } });
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

  test('empty choices and server failures reach the engine without upload or correction', async () => {
    for (const response of [
      { status: 200, body: { choices: [] } },
      { status: 503, body: { error: { code: 503, message: 'provider unavailable' } } },
    ]) {
      const deps = renderDepsWith();
      process.env.OPENROUTER_API_KEY = 'test';
      openRouterResponse(response);
      const err = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute().catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TerminalFailure);
      expect((err as Error & { qaDiagnostics: QaDiagnostics }).qaDiagnostics.outcome).toBe('error');
      expect(deps.counts.renders).toBe(slideFanout());
      expect(deps.counts.uploads).toBe(0);
    }
  });

  test('a provider request id is sanitized to an opaque token', () => {
    expect(sanitizeRequestId('gen-123_ABC')).toBe('gen-123_ABC');
    expect(sanitizeRequestId('Bearer sk-secret-value')).toBeUndefined();
    expect(sanitizeRequestId('a'.repeat(200))).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });
});

describe('a pass requires the answer that was asked for', () => {
  test('a complete answer passes, and an incomplete one is unverified', async () => {
    const contract = await probeContract();
    const labels = requestedChecks(contract);
    expect(labels.length).toBeGreaterThan(1);
    process.env.OPENROUTER_API_KEY = 'test';

    // Exactly one entry per requested check, using the contract's own labels.
    openRouterResponse({ status: 200, body: answersFor(labels) });
    const complete = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(complete.verdict).toBe('pass');
    expect(complete.checks).toHaveLength(labels.length);
    expect(complete.reasons).toEqual([]);

    // The CTO reproduction: 15 requested checks, ONE unrelated passing entry.
    // Before the coverage check this resolved to `pass` and shipped the slide.
    openRouterResponse({ status: 200, body: answersFor(['unrelated arbitrary check']) });
    const reproduced = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(reproduced.verdict).toBe('error');
    expect(reproduced.verdict).not.toBe('pass');
    expect(reproduced.reasons[0]).toContain('qa_');
    expect(reproduced.diagnostics).toMatchObject({ outcome: 'ok', errorCategory: 'invalid_response', checksRequested: labels.length });
  });

  test('missing, duplicate, unexpected and malformed entries are all unverified', async () => {
    const contract = await probeContract();
    const labels = requestedChecks(contract);
    process.env.OPENROUTER_API_KEY = 'test';
    const check = async (checks: unknown[]) => {
      openRouterResponse({ status: 200, body: { choices: [{ message: { content: JSON.stringify({ checks, reasons: [] }) } }], usage: {} } });
      return renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    };
    const passing = (l: string) => ({ check: l, status: 'pass', reason: 'matches' });

    // Missing one requested check.
    const missing = await check(labels.slice(0, -1).map(passing));
    expect(missing.verdict).toBe('error');
    expect(missing.reasons[0]).toContain('qa_incomplete_coverage');

    // One requested check answered twice, and every other one present.
    const duplicate = await check([...labels.map(passing), passing(labels[0]!)]);
    expect(duplicate.verdict).toBe('error');
    expect(duplicate.reasons[0]).toContain('qa_duplicate_check');

    // Complete coverage PLUS a check nobody asked for.
    const unexpected = await check([...labels.map(passing), passing('the mood is nice')]);
    expect(unexpected.verdict).toBe('error');
    expect(unexpected.reasons[0]).toContain('qa_unexpected_check');

    // A status outside the vocabulary is malformed, not a soft `unknown`:
    // `unknown` is a real verdict the contract defines ("the image cannot
    // settle this"), so it must not be the fallback for nonsense.
    const badStatus = await check([...labels.map(passing)].map((c, i) => (i === 0 ? { ...c, status: 'probably' } : c)));
    expect(badStatus.verdict).toBe('error');
    expect(badStatus.reasons[0]).toContain('qa_response_malformed');

    // Structural malformation: no label, and no array at all.
    const noLabel = await check([...labels.map(passing)].map((c, i) => (i === 0 ? { status: 'pass' } : c)));
    expect(noLabel.verdict).toBe('error');
    expect(noLabel.reasons[0]).toContain('qa_response_malformed');
    openRouterResponse({ status: 200, body: { choices: [{ message: { content: '{"reasons":[]}' } }], usage: {} } });
    const noChecks = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(noChecks.verdict).toBe('error');
    expect(noChecks.reasons).toEqual(['qa_missing_checks']);
    expect(noChecks.diagnostics!.errorCategory).toBe('invalid_response');

    // A genuine `unknown` or `fail` on a complete answer is still the contract's
    // own verdict, not a response-shape problem: unverified / failed, and never
    // silently upgraded to a pass.
    openRouterResponse({ status: 200, body: answersFor(labels, 'unknown') });
    const unknown = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(unknown.verdict).toBe('error');
    expect(unknown.diagnostics!.errorCategory).toBeUndefined();
    openRouterResponse({ status: 200, body: answersFor(labels, 'fail') });
    expect((await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) })).verdict).toBe('fail');
  });

  test('coverage matches RAW labels, not their truncated display form', () => {
    const long = `the subject's gaze is unchanged: "${'x'.repeat(260)}"`;
    const other = `the subject's gaze is unchanged: "${'x'.repeat(261)}"`;
    // resolveQaVerdict truncates a stored label to 200 chars, so two different
    // checks can share a stored prefix. Matching happens before that.
    const verdicts = resolveQaVerdict({ checks: [{ check: long, status: 'pass' }] }, 'h', false, 1, [long, other]);
    expect(verdicts.verdict).toBe('error');
    expect(verdicts.reasons[0]).toContain('qa_incomplete_coverage');

    // Whitespace-only differences in what the model sent are tolerated: they
    // are the same check. Casing and punctuation are not.
    expect(qaCoverageProblem([{ check: '  the   medium is photograph ', status: 'pass' }], ['the medium is photograph'])).toBeNull();
    expect(qaCoverageProblem([{ check: 'The medium is photograph', status: 'pass' }], ['the medium is photograph'])).toContain('qa_unexpected_check');
    // The pure helper is the same rule the resolver applies.
    expect(qaCoverageProblem([{ check: 'a', status: 'pass' }], ['a'])).toBeNull();
    expect(qaCoverageProblem('not an array', ['a'])).toContain('qa_response_malformed');
  });

  test('a label whose own text contains repeated spaces is answered, not rejected', async () => {
    // CTO round 2: a contract label quotes the overlay verbatim through
    // JSON.stringify, so a user string with a double space produced
    // `the on-image overlay matches exactly: "Take  a break"`. Canonicalising
    // only the returned side rejected an IDENTICAL echo of it as unexpected.
    const spaced = compileSlideContract({
      slideIndex: 0, role: 'hook', medium: 'photograph',
      scene: 'A man with curly light-brown hair and blue eyes wearing a blue hockey jersey, looking right.',
      overlay: { mode: 'replace', text: 'Take  a break', origin: 'brief' },
      observedCopy: { state: 'observed_text', text: 'Take  a break' },
      identityLocked: true,
      sourceMap: { videoId: 'src', analysisId: 'an1', sourceIndex: 0, referenceKind: 'slide', path: 'p/0.jpg' },
    });
    const overlayLabel = contractChecks(spaced).find(c => c.includes('on-image overlay'))!;
    // The contract really does carry the repeated space, unchanged.
    expect(overlayLabel).toBe('the on-image overlay matches exactly: "Take  a break"');
    process.env.OPENROUTER_API_KEY = 'test';
    // SLA-522: this contract is mapped to a source slide, so its unobserved
    // locks are comparisons and the checker is given that frame. The point of
    // the test below is the LABEL, not the frame, so every answer is complete.
    const baseline = Buffer.alloc(600, 4);

    // 1. Identical echo: complete coverage.
    const labels = requestedChecks(spaced);
    openRouterResponse({ status: 200, body: answersFor(labels) });
    const echoed = await renderDeps.verifyStory!({ contract: spaced, candidate: Buffer.alloc(600, 9), baseline });
    expect(echoed.verdict).toBe('pass');
    expect(echoed.diagnostics!.errorCategory).toBeUndefined();

    // 2. Whitespace-only variation in what the checker sent: still the same
    // check, so still complete coverage.
    openRouterResponse({ status: 200, body: answersFor(labels.map(l => l.replace(/ /g, '   '))) });
    const respaced = await renderDeps.verifyStory!({ contract: spaced, candidate: Buffer.alloc(600, 9), baseline });
    expect(respaced.verdict).toBe('pass');

    // The rule is symmetric, not a special case for this label.
    expect(qaCoverageProblem([{ check: 'the overlay is "a  b"', status: 'pass' }], ['the overlay is "a  b"'])).toBeNull();
    expect(qaCoverageProblem([{ check: 'the overlay is "a b"', status: 'pass' }], ['the overlay is "a  b"'])).toBeNull();

    // And strictness is unchanged where it must be. A checker that answers a
    // DIFFERENT overlay string is not answering this check; a missing one is
    // still missing. (Collapsing `Take  a break` to `Take a break` is NOT a
    // different answer — that is the whitespace case above, by design.)
    openRouterResponse({ status: 200, body: answersFor(labels.map(l => l === overlayLabel ? 'the on-image overlay matches exactly: "Take a breather"' : l)) });
    const reworded = await renderDeps.verifyStory!({ contract: spaced, candidate: Buffer.alloc(600, 9), baseline });
    // Rejected as the unknown label it is (unexpected is detected before the
    // missing-label pass), and categorised as an unusable answer.
    expect(reworded.verdict).toBe('error');
    expect(reworded.reasons[0]).toBe('qa_unexpected_check:the on-image overlay matches exactly: "Take a breather"');
    expect(reworded.diagnostics!.errorCategory).toBe('invalid_response');
    openRouterResponse({ status: 200, body: answersFor(labels.filter(l => l !== overlayLabel)) });
    const omitted = await renderDeps.verifyStory!({ contract: spaced, candidate: Buffer.alloc(600, 9), baseline });
    expect(omitted.verdict).toBe('error');
    expect(omitted.reasons[0]).toContain('qa_incomplete_coverage');
    // The overlay text sent to the checker is untouched by the matching rule.
    expect(JSON.stringify(contractQaBlock(spaced)).includes('Take  a break')).toBe(true);
  });

  test('an incomplete answer uploads nothing and buys no corrective wave', async () => {
    const contract = await probeContract();
    const labels = requestedChecks(contract);
    const deps = renderDepsWith();
    process.env.OPENROUTER_API_KEY = 'test';
    openRouterResponse({ status: 200, body: answersFor(labels.slice(0, 3)) });

    const err = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute().catch(e => e);
    expect(err).toBeInstanceOf(TerminalFailure);
    expect((err as TerminalFailure).verdict).toBe('unverified');
    expect((err as TerminalFailure).audit).toMatchObject({ verdict: 'error' });
    expect(((err as TerminalFailure).audit as { reasons: string[] }).reasons[0]).toContain('qa_incomplete_coverage');
    // 3 renders is the initial fan-out only: an incomplete answer is not a
    // finding about the image, so it must not buy a second paid wave.
    expect(deps.counts.renders).toBe(slideFanout());
    expect(deps.counts.uploads).toBe(0);
    expect(labels.length).toBeGreaterThan(3);
  });

  test('a full answer still ships, so the gate is not merely always-unverified', async () => {
    const contract = await probeContract();
    const deps = renderDepsWith();
    process.env.OPENROUTER_API_KEY = 'test';
    openRouterResponse({ status: 200, body: answersFor(requestedChecks(contract)) });

    const result = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute() as { story: { verdict: string }; qa: { verdict: string } };
    expect(result.story.verdict).toBe('pass');
    expect(result.qa.verdict).toBe('pass');
    expect(deps.counts.uploads).toBe(1);
    expect(deps.counts.renders).toBe(slideFanout());
  });
});

describe('an unavailable checker is unverified, and buys nothing', () => {
  test('a timeout is categorised and propagates for bounded provider retry', async () => {
    const contract = await probeContract();
    process.env.EXPERIMENT_QA_MODEL = 'openai/gpt-5.1-mini';
    process.env.OPENROUTER_API_KEY = 'test';
    // What AbortSignal.timeout rejects with in the worker runtime: no response,
    // therefore no header and no id to quote.
    globalThis.fetch = (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;

    const result = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) }).catch(e => e);
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('timed out');
    expect(result.qaDiagnostics).toMatchObject({ outcome: 'error', errorCategory: 'timeout', model: 'openai/gpt-5.1-mini', timeoutMs: QA_TIMEOUT_MS });
    // No id is invented for a call that never reached the gateway.
    expect(result.qaDiagnostics.requestId).toBeUndefined();

    // A timeout is a provider-side category, distinguishable from the rest.
    expect(qaErrorCategory(Object.assign(new Error('The operation timed out.'), { name: 'TimeoutError' }))).toBe('timeout');
    expect(qaErrorCategory(new Error('OpenRouter API error 429: rate limited'))).toBe('rate_limit');
    expect(qaErrorCategory(new Error('OpenRouter API error 402: insufficient credits'))).toBe('quota');
    expect(qaErrorCategory(new Error('Failed to parse OpenRouter response as JSON'))).toBe('invalid_response');
  });

  test('a refused or malformed call keeps the gateway id it was given', async () => {
    const contract = await probeContract();
    process.env.OPENROUTER_API_KEY = 'test';

    // 429 with the header the gateway sent: categorised, and still traceable.
    openRouterResponse({ status: 429, body: { error: { code: 429, message: 'rate limited' } }, headers: { 'x-request-id': 'req-throttled-1' } });
    const throttled = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) }).catch(e => e);
    expect(throttled).toBeInstanceOf(Error);
    expect(throttled.qaDiagnostics).toMatchObject({ outcome: 'error', errorCategory: 'rate_limit', requestId: 'req-throttled-1' });

    // Same refusal, id only in the body.
    openRouterResponse({ status: 402, raw: JSON.stringify({ id: 'gen-body-9', error: { code: 402, message: 'insufficient credits' } }) });
    const quota = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(quota.diagnostics).toMatchObject({ outcome: 'error', errorCategory: 'quota', requestId: 'gen-body-9' });

    // A body that arrived but did not parse: unusable answer, id retained, and
    // the provider body itself is never carried into the diagnostics.
    openRouterResponse({ status: 200, raw: 'not json at all', headers: { 'x-request-id': 'req-unparseable-2' } });
    const unparseable = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) });
    expect(unparseable.verdict).toBe('error');
    expect(unparseable.diagnostics).toMatchObject({ outcome: 'error', errorCategory: 'invalid_response', requestId: 'req-unparseable-2' });
    expect(JSON.stringify(unparseable.diagnostics)).not.toContain('not json at all');

    // An id that is not an opaque token is dropped, not half-quoted.
    openRouterResponse({ status: 429, body: { error: { code: 429, message: 'rate limited' } }, headers: { 'x-request-id': 'Bearer sk-not-a-token' } });
    const dirty = await renderDeps.verifyStory!({ contract, candidate: Buffer.alloc(600, 9) }).catch(e => e);
    expect(dirty.qaDiagnostics.errorCategory).toBe('rate_limit');
    expect(dirty.qaDiagnostics.requestId).toBeUndefined();
  });

  test('empty choices and server failures reach the engine without upload or correction', async () => {
    for (const response of [
      { status: 200, body: { choices: [] } },
      { status: 503, body: { error: { code: 503, message: 'provider unavailable' } } },
    ]) {
      const deps = renderDepsWith();
      process.env.OPENROUTER_API_KEY = 'test';
      openRouterResponse(response);
      const err = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute().catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toBeInstanceOf(TerminalFailure);
      expect((err as Error & { qaDiagnostics: QaDiagnostics }).qaDiagnostics.outcome).toBe('error');
      expect(deps.counts.renders).toBe(slideFanout());
      expect(deps.counts.uploads).toBe(0);
    }
  });

  test('a provider request id is sanitized to an opaque token', () => {
    expect(sanitizeRequestId('gen-123_ABC')).toBe('gen-123_ABC');
    expect(sanitizeRequestId('Bearer sk-secret-value')).toBeUndefined();
    expect(sanitizeRequestId('a'.repeat(200))).toBeUndefined();
    expect(sanitizeRequestId(undefined)).toBeUndefined();
  });

  test('a timed-out checker reaches provider retry without uploading or correcting', async () => {
    const deps = renderDepsWith();
    await probeContract();
    process.env.OPENROUTER_API_KEY = 'test';
    globalThis.fetch = (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;

    const err = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TerminalFailure);
    expect((err as Error).message).toContain('timed out');
    // No blind corrective render: an unavailable checker cannot un-verify
    // anything, so the slide must not buy another paid image.
    expect(deps.counts.renders).toBe(slideFanout());
    expect(deps.counts.uploads).toBe(0);
    // The audit carries the sanitized request diagnostics, so this timeout is
    // diagnosable from the record alone.
    expect((err as Error & { qaDiagnostics: QaDiagnostics }).qaDiagnostics).toMatchObject({ errorCategory: 'timeout' });
  });

  test('an off-style candidate does not buy a wave when QA is unavailable', async () => {
    // The style flag used to reach the corrective render through the same
    // condition as a story failure, so an unusable checker plus an over-designed
    // candidate bought a second paid image to learn nothing.
    const deps = renderDepsWith({ describeCandidates: async () => [{ id: 'c0', description: 'invented app UI dashboard', medium: 'collage', textBlocks: 4, overdesigned: true }] });
    await probeContract();
    process.env.OPENROUTER_API_KEY = 'test';
    globalThis.fetch = (async () => { const e = new Error('The operation timed out.'); e.name = 'TimeoutError'; throw e; }) as unknown as typeof fetch;

    const err = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute().catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TerminalFailure);
    expect(deps.counts.renders).toBe(slideFanout());
    expect(deps.counts.uploads).toBe(0);
    expect((err as Error & { qaDiagnostics: QaDiagnostics }).qaDiagnostics).toMatchObject({ errorCategory: 'timeout' });
  });

  test('a VERIFIED failure still corrects, so the gate did not lose its one retry', async () => {
    const contract = await probeContract();
    const labels = requestedChecks(contract);
    const deps = renderDepsWith();
    process.env.OPENROUTER_API_KEY = 'test';
    // Complete coverage, but a real contract finding: that is the one case a
    // second render is for.
    let call = 0;
    openRouterResponse({ status: 200, body: answersFor(labels, 'fail') });
    globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
      call++;
      const first = call === 1;
      const checks = first ? labels.map(c => ({ check: c, status: 'fail', reason: 'the subject is missing' })) : labels.map(c => ({ check: c, status: 'pass', reason: 'matches' }));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ checks, reasons: ['overlay cropped'] }) } }], usage: {} }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;

    const result = await (await prepare(fixture(), task, { ...deps.deps, verifyStory: renderDeps.verifyStory } as never)).execute(admission(1)) as { story: { verdict: string; corrected: boolean } };
    expect(result.story).toMatchObject({ verdict: 'pass', corrected: true });
    expect(contract).toBeDefined();
    // Initial wave plus the single shared corrective wave.
    expect(deps.counts.renders).toBe(2 * slideFanout());
    expect(deps.counts.uploads).toBe(1);
  });
});
