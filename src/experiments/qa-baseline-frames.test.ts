// SLA-522: source-preservation QA is a COMPARISON, so the mapped source frame
// has to be in the room when it is made.
//
// Five defects this pins:
//  1. the checker received the candidate ALONE, so every "unchanged from the
//     reference frame" check was answered by a model that had never seen the
//     reference frame — complexion, gaze and setting were verified by guess;
//  2. the frame it should have compared against was never even read back, so
//     nothing tied the comparison to the mapped source the render used;
//  3. the two images, once attached, were not identified, so "the subject" in a
//     check could be read off either frame;
//  4. an unreadable frame quietly downgraded the contract to absolute checks,
//     which converts an unmade comparison into a pass;
//  5. the corrective re-check did not carry the same frame, so a slide could
//     pass its second check against a different (or no) baseline.
//
// Everything here is offline: the provider is a stubbed fetch, nothing is spent,
// no clock is real. The strict gate is asserted, not assumed — a missing or
// unreadable baseline leaves the slide unverified, uploads nothing, and buys no
// second render.
import { afterEach, describe, expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { prepare, renderDeps, TerminalFailure } from './providers.js';
import { admission } from './test-admission.js';
import { contractCheckPlan, contractChecks } from './render-prompt.js';
import { thumbBucket } from '../lib/storage.js';
import { editInstructions } from '../tools/experiments.js';
import type { Experiment, Input, Task } from './schema.js';
import type { SlideContract } from './render-prompt.js';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
afterEach(() => {
  globalThis.fetch = originalFetch;
  process.env = { ...originalEnv };
});

const SOURCE_PATH = 'w/src/slides/001.jpg';
const SOURCE_BUCKET = thumbBucket();
/** A byte-distinguishable stand-in for the mapped frame. Its content never
 *  leaves the test: the point is that THIS buffer, not some other frame, is
 *  what the QA request carries. */
const SOURCE_FRAME = Buffer.from('mapped-source-frame-bytes', 'utf8');
const CANDIDATE_FRAME = Buffer.alloc(600, 7);

/** A source-referenced experiment whose slide 0 maps onto SOURCE_PATH. */
function sourceReferenced(opts: { variables?: string[]; character?: string; scene?: string; changed?: Array<{ name: string; value: string }> } = {}) {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  const videos = [{ id: 'src', mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: [0, 1, 2].map(i => `w/src/slides/00${i + 1}.jpg`) }) } as Video];
  const copy = [0, 1, 2].map(slideIndex => ({ slideIndex, state: 'observed_text' as const, text: 'Original headline' }));
  const scene = opts.scene ?? 'A man with curly light-brown hair and blue eyes wearing a blue hockey jersey, looking right.';
  const brief = {
    concept: 'Guide', hook: 'Official ratings', character: opts.character ?? 'Adult', visualStyle: 'Editorial',
    caption: '', cta: '', lockedConstraints: [], slides: [0, 1, 2].map(() => ({ role: 'proof', scene, overlayText: 'Official ratings' })),
  };
  const e = {
    id: 'e', workspaceId: 'w', status: 'generating', generationBasis: 'source-referenced', styleFormula: { medium: 'photograph', density: 'minimal' },
    inputs: [{ videoId: 'src', status: 'ready', analysisId: 'an1', jobId: null, error: null, coverage: null, evidence: [], copy }] as Input[],
    instructions: { language: 'English', brand: '', audience: '', goal: 'g', direction: 'nordic', lockedConstraints: [], variables: opts.variables ?? ['hook'], mode: 'exploration' },
    variants: [{ id: 'v', revision: 1, baselineId: null, changedVariables: opts.changed ?? [], generationBasis: 'source-referenced', frozenBrief: brief, slides: [] }],
    tasks: [{ id: 't', kind: 'slide', target: 'v', index: 0, status: 'pending', attempts: 0, charged: 10 }],
  } as unknown as Experiment;
  return { e, videos };
}
/** A text-directed experiment: no inputs, so `selectSlideReference` resolves
 *  nothing and the contract's own source map says `referenceKind: 'none'`. */
function textDirected() {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  const brief = {
    concept: 'Tea routine', hook: 'Take a break', character: 'Adult', visualStyle: 'Warm', caption: '', cta: '', lockedConstraints: [],
    slides: [
      { role: 'hook', scene: 'A woman with short blonde hair holding a steaming cup', overlayText: 'Take a break' },
      { role: 'body', scene: 'Hands holding the cup', overlayText: '' },
      { role: 'end', scene: 'Empty cup on a wooden table', overlayText: '' },
    ],
  };
  return {
    id: 'e', workspaceId: 'w', status: 'generating', generationBasis: 'text-directed', styleFormula: { medium: 'photograph', density: 'minimal' },
    inputs: [] as Input[],
    instructions: { language: 'English', brand: '', audience: '', goal: 'g', direction: 'calm', lockedConstraints: [], variables: ['hook'], mode: 'exploration' },
    variants: [{ id: 'v', revision: 1, baselineId: null, changedVariables: [], generationBasis: 'text-directed', frozenBrief: brief, slides: [] }],
    tasks: [{ id: 't', kind: 'slide', target: 'v', index: 0, status: 'pending', attempts: 0, charged: 10 }],
  } as unknown as Experiment;
}
const task = { id: 't', kind: 'slide', target: 'v', index: 0, attempts: 0, charged: 10 } as unknown as Task;

/** Deps that record every read of a mapped frame and every QA call. */
function depsWith(videos: Video[], opts: {
  baseline?: Buffer | null;
  qa?: (o: { contract: SlideContract; candidate: Buffer; baseline?: Buffer | null }) => unknown;
} = {}) {
  const reads: Array<{ bucket: string; path: string }> = [];
  const qa: Array<{ contract: SlideContract; candidate: Buffer; baseline?: Buffer | null }> = [];
  const renders: unknown[] = [];
  const uploads: unknown[] = [];
  const deps = {
    findSources: async () => videos,
    generateImage: async (o: unknown) => { renders.push(o); return { buffer: Buffer.alloc(600, renders.length), contentType: 'image/jpeg', costUsd: 0 }; },
    readReference: async (o: { bucket: string; path: string }) => {
      reads.push(o);
      return 'baseline' in opts ? (opts.baseline ?? null) : SOURCE_FRAME;
    },
    upload: async (o: unknown) => { uploads.push(o); return { path: 'stored', sizeBytes: 600 }; },
    describeCandidates: async (b: Buffer[]) => b.map((_, i) => ({ id: `c${i}`, description: `candidate ${i}`, overdesigned: false })),
    classify: async () => ({ value: 'c0', confidence: 0.9 }),
    jevScores: async () => ({}),
    generateBriefCandidates: async () => { throw new Error('not used'); },
    verifyStory: async (o: { contract: SlideContract; candidate: Buffer; baseline?: Buffer | null }) => {
      qa.push(o);
      return opts.qa ? opts.qa(o) as never : { verdict: 'pass' as const, reasons: [], checks: [], contractHash: o.contract.contractHash, corrected: false, attempts: 1 };
    },
  };
  return { deps: deps as unknown as Parameters<typeof prepare>[2], reads, qa, renders, uploads };
}

/** A stubbed OpenRouter answer over the contract's own check list. */
function answersFor(checks: readonly string[], status: 'pass' | 'fail' | 'unknown' = 'pass') {
  return { choices: [{ message: { content: JSON.stringify({
    checks: checks.map(check => ({ check, status, reason: 'the frames satisfy the contract item' })),
    reasons: [],
  }) } }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0 } };
}
/** Capture the QA requests the production checker makes. Nothing is spent. */
function captureQaRequests() {
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    requests.push(body);
    const parsed = userBodyOf(body);
    const labels = parsed.checks.map(entry => entry.check);
    return new Response(JSON.stringify(answersFor(labels)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return requests;
}
/** The JSON user message of a captured request. With frames attached it is the
 *  first text part of a content array, not a bare string. */
function userBodyOf(request: Record<string, unknown>) {
  const user = (request.messages as Array<{ content: unknown }>)[1]!.content;
  if (typeof user === 'string') return JSON.parse(user) as QaUserBody;
  const text = (user as Array<{ type: string; text?: string }>).find(part => part.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as QaUserBody;
}
type QaUserBody = {
  images: Array<{ frame: string; label: string }>;
  checks: Array<{ check: string; frames: string }>;
  sourceMap: { path: string | null; referenceKind: string; videoId: string | null };
  contract: { contractHash: string };
};
/** The user message of a captured request, decoded. */
function userBody(request: Record<string, unknown>): QaUserBody {
  return userBodyOf(request);
}
/** Every image part of a captured request, in wire order, carrying the caption
 *  that immediately precedes it (null when the frame is uncaptioned). */
function imageParts(request: Record<string, unknown>) {
  const user = (request.messages as Array<{ content: unknown }>)[1]!.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  const parts: Array<{ label: string | null; bytes: Buffer | null }> = [];
  let caption: string | null = null;
  for (const part of user) {
    if (part.type === 'text') { caption = part.text ?? null; continue; }
    parts.push({
      label: caption,
      bytes: part.image_url ? Buffer.from(String(part.image_url.url).split('base64,')[1]!, 'base64') : null,
    });
    caption = null;
  }
  return parts;
}
/** The compiled contract prepare() hands the checker. */
async function probeContract(deps: Parameters<typeof prepare>[2], e: Experiment) {
  const seen: SlideContract[] = [];
  await (await prepare(e, task, { ...deps as object, verifyStory: async (o: { contract: SlideContract }) => {
    seen.push(o.contract);
    return { verdict: 'pass' as const, reasons: [], checks: [], contractHash: o.contract.contractHash, corrected: false, attempts: 1 };
  } } as never)).execute();
  return seen[0]!;
}

describe('the mapped source frame reaches the checker', () => {
  test('QA reads the exact frame the render used as its reference, once per slide', async () => {
    const { e, videos } = sourceReferenced();
    const harness = depsWith(videos);
    await (await prepare(e, task, harness.deps)).execute();

    // The read is keyed by the SAME bucket+path `selectSlideReference` resolved
    // and `generateImage` was given as `referenceUrl` — not a sibling slide, not
    // a variant's plate, not an inferred person.
    expect(harness.reads).toHaveLength(1);
    expect(harness.reads[0]).toEqual({ bucket: SOURCE_BUCKET, path: SOURCE_PATH });
    const rendered = harness.renders[0] as { referenceUrl?: string };
    expect(rendered.referenceUrl).toContain(SOURCE_PATH);

    // The frame the render derived from and the frame QA compares against are
    // the same bytes, and the contract still names the same source map + hash.
    expect(harness.qa[0]!.baseline).toEqual(SOURCE_FRAME);
    expect(harness.qa[0]!.contract.sourceMap.path).toBe(SOURCE_PATH);
    expect(harness.qa[0]!.contract.sourceMap.referenceKind).toBe('slide');
    expect(harness.qa[0]!.contract.contractHash).toBe(harness.qa[0]!.contract.contractHash);
  });

  test('the production checker sends two identified frames: source first, candidate last', async () => {
    const { e, videos } = sourceReferenced();
    const harness = depsWith(videos);
    const contract = await probeContract(harness.deps, e);
    const requests = captureQaRequests();

    const result = await renderDeps.verifyStory!({ contract, candidate: CANDIDATE_FRAME, baseline: SOURCE_FRAME });

    const parts = imageParts(requests[0]!);
    expect(parts).toHaveLength(2);
    expect(parts[0]!.bytes).toEqual(SOURCE_FRAME);
    expect(parts[1]!.bytes).toEqual(CANDIDATE_FRAME);
    // "The subject" in a check must not be readable off the wrong frame.
    expect(parts[0]!.label).toContain('source frame');
    expect(parts[1]!.label).toContain('Candidate');

    const body = userBody(requests[0]!);
    expect(body.images.map(frame => frame.frame)).toEqual(['source', 'candidate']);
    expect(body.contract.contractHash).toBe(contract.contractHash);
    expect(body.sourceMap.path).toBe(SOURCE_PATH);
    expect(body.sourceMap.referenceKind).toBe('slide');
    // Both frames are named on the request itself, not only in a caption.
    expect(body.images[0]!.label).toContain('rendered FROM this frame');
    expect(body.images[1]!.label).toContain('verify');
    // Strict coverage is untouched: every contract check is still requested.
    expect(result.verdict).toBe('pass');
    expect(result.checks).toHaveLength(contractChecks(contract, { sourceBaseline: true }).length);
  });

  test('a comparative lock names both frames; an absolute requirement names the candidate', async () => {
    const { e, videos } = sourceReferenced();
    const harness = depsWith(videos);
    const contract = await probeContract(harness.deps, e);
    const plan = contractCheckPlan(contract, { sourceBaseline: true });
    const byAttribute = (attribute: string) => plan.find(entry => entry.check.startsWith(`the subject's ${attribute} `));

    // Attributes the source scene prose actually stated are absolute: the value
    // is in the check, so the candidate frame alone settles them.
    for (const attribute of ['role', 'hair', 'eyes', 'wardrobe', 'gaze']) {
      expect(byAttribute(attribute)).toMatchObject({ scope: 'candidate' });
      expect(byAttribute(attribute)!.check).toContain(' is unchanged: "');
    }
    // Attributes the prose never stated are exactly the comparisons: they can
    // only be shown unchanged by looking at the source frame next to the
    // candidate, so they are routed to BOTH rather than answered from one.
    for (const attribute of ['facial-hair', 'complexion', 'jewelry', 'setting']) {
      expect(byAttribute(attribute)).toEqual({
        check: `the subject's ${attribute} is unchanged from the reference frame`,
        scope: 'comparison',
        severity: 'soft',
      });
    }
    // Overlay, labels and medium/beat stay candidate-only: they are absolute
    // requirements in the contract, not comparisons against the source.
    expect(plan.filter(entry => entry.check.includes('the on-image overlay') || entry.check.includes('the medium is'))).toHaveLength(2);
    expect(plan.filter(entry => entry.check.includes('the on-image overlay') || entry.check.includes('the medium is')).every(entry => entry.scope === 'candidate')).toBe(true);

    // And the request says which frames answer each one.
    const requests = captureQaRequests();
    await renderDeps.verifyStory!({ contract, candidate: CANDIDATE_FRAME, baseline: SOURCE_FRAME });
    const sent = userBody(requests[0]!);
    expect(sent.checks.find(entry => entry.check.includes('complexion'))).toEqual({
      check: `the subject's complexion is unchanged from the reference frame`, frames: 'source+candidate',
    });
    expect(sent.checks.find(entry => entry.check.includes('the medium is'))!.frames).toBe('candidate');
    expect(sent.checks).toHaveLength(plan.length);
  });

  test('superseded source appearance is never a preserved lock, and its replacement is candidate-only', async () => {
    const casting = 'short blonde hair, light eyes';
    const { e, videos } = sourceReferenced({ variables: ['character'], character: casting, changed: [{ name: 'character', value: casting }] });
    e.instructions = editInstructions(undefined, [], 'English', { variables: ['character'], character: casting });
    const harness = depsWith(videos);
    const contract = await probeContract(harness.deps, e);
    const plan = contractCheckPlan(contract, { sourceBaseline: true });

    // The replaced hair phrase is gone from the subject, so it must not survive
    // as something QA is told to preserve.
    expect(contract.subject.castingTarget).toMatchObject({ hair: 'short blonde hair', eyes: 'light eyes' });
    expect(contract.subject.supersededPhrases.length).toBeGreaterThan(0);
    const preserved = plan.filter(entry => entry.check.includes(' is unchanged'));
    for (const phrase of contract.subject.supersededPhrases) {
      expect(preserved.map(entry => entry.check).join('\n')).not.toContain(phrase);
    }
    // An unlocked attribute never appears as a lock at all, comparative or not.
    for (const attribute of Object.keys(contract.subject.castingTarget)) {
      expect(contract.subject.lockedAttributes.map(lock => lock.attribute)).not.toContain(attribute);
      expect(preserved.filter(entry => entry.check.startsWith(`the subject's ${attribute} `))).toHaveLength(0);
    }
    // The requested replacement is judged on the candidate, not as a comparison.
    const requested = plan.filter(entry => entry.check.includes(' matches the requested casting target'));
    expect(requested).toHaveLength(Object.keys(contract.subject.castingTarget).length);
    expect(requested.every(entry => entry.scope === 'candidate')).toBe(true);
  });
});

describe('an unavailable comparison stays unverified', () => {
  test('an unreadable mapped frame records the comparison as unverified and spends nothing', async () => {
    for (const baseline of [null, undefined]) {
      const { e, videos } = sourceReferenced();
      const harness = depsWith(videos, { baseline: baseline ?? null });
      const contract = await probeContract({ ...harness.deps as object } as never, e);
      const comparative = { ...contract, subject: { ...contract.subject, lockedAttributes: [{ attribute: 'complexion', observed: null }] } } as SlideContract;
      const requests = captureQaRequests();

      const result = await renderDeps.verifyStory!({ contract: comparative, candidate: CANDIDATE_FRAME, baseline });

      expect(result.verdict).toBe('error');
      expect(result.verdict).not.toBe('pass');
      expect(result.reasons[0]).toStartWith('qa_baseline_missing:comparative=1');
      expect(result.reasons[0]).toContain('complexion');
      expect(result.diagnostics).toMatchObject({ outcome: 'error', errorCategory: 'baseline_missing' });
      // No request, so no credit: an unmade comparison is never worth a paid call.
      expect(requests).toHaveLength(0);
    }
  });

  test('a missing baseline fails the slide as unverified with no upload and no second render', async () => {
    const { e, videos } = sourceReferenced();
    const harness = depsWith(videos, { baseline: null, qa: renderDeps.verifyStory });
    const failure = await (await prepare(e, task, harness.deps)).execute().then(() => null, (err: unknown) => err);

    expect(failure).toBeInstanceOf(TerminalFailure);
    expect((failure as InstanceType<typeof TerminalFailure>).message).toStartWith('story_unverified:');
    expect(harness.uploads).toHaveLength(0);
    expect(harness.renders).toHaveLength(1);
    const audit = (failure as InstanceType<typeof TerminalFailure>).audit as { verdict: string; qaBaseline: { attached: boolean; referenceKind: string; path: string }; sourceMap: { path: string } };
    expect(audit.verdict).toBe('error');
    // The record says which frame was owed and that it was not attached.
    expect(audit.qaBaseline).toEqual({ referenceKind: 'slide', path: SOURCE_PATH, attached: false });
    expect(audit.sourceMap.path).toBe(SOURCE_PATH);
  });

  test('a frame that cannot settle the comparison is unverified, never a pass', async () => {
    const { e, videos } = sourceReferenced();
    const harness = depsWith(videos);
    const contract = await probeContract(harness.deps, e);
    const occluded = { ...contract, subject: { ...contract.subject, lockedAttributes: [{ attribute: 'gaze', observed: null }] } } as SlideContract;
    const labels = contractChecks(occluded, { sourceBaseline: true });

    globalThis.fetch = (async () => new Response(JSON.stringify(answersFor(labels, 'unknown')), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const result = await renderDeps.verifyStory!({ contract: occluded, candidate: CANDIDATE_FRAME, baseline: SOURCE_FRAME });

    // The comparison was ATTEMPTED with both frames attached, so this is not a
    // response-shape problem: it is the checker's own `unknown`.
    expect(result.verdict).toBe('error');
    expect(result.diagnostics).toMatchObject({ outcome: 'ok' });
    expect(result.diagnostics!.errorCategory).toBeUndefined();
    // A soft comparison the frames cannot settle is a recorded warning (SLA-545);
    // the hard unknowns are what keep the slide unverified.
    expect([...result.reasons, ...(result.warnings ?? [])].join(' ')).toContain('gaze');
  });

  test('a text-directed contract asks absolute requirements and invents no comparison', async () => {
    const harness = depsWith([]);
    const contract = await probeContract(harness.deps, textDirected());
    expect(contract.sourceMap.referenceKind).toBe('none');
    const plan = contractCheckPlan(contract, { sourceBaseline: false });

    // No mapped frame exists, so nothing may be phrased as a source comparison.
    expect(plan.filter(entry => entry.scope === 'comparison')).toHaveLength(0);
    expect(plan.map(entry => entry.check).join('\n')).not.toContain('reference frame');
    // A lock the prose never stated becomes an observable requirement against
    // the slide's own scene — checkable from the candidate, not from a ghost.
    expect(plan.filter(entry => entry.check.includes(' matches this slide\'s scene'))).toContainEqual({
      check: `the subject's complexion matches this slide's scene: ${JSON.stringify(contract.compiledScene)}`,
      scope: 'candidate',
      severity: 'soft',
    });

    const requests = captureQaRequests();
    await renderDeps.verifyStory!({ contract, candidate: CANDIDATE_FRAME, baseline: null });
    // One frame, and it is the candidate: no second image to mistake for the source.
    expect(imageParts(requests[0]!)).toHaveLength(1);
    expect(imageParts(requests[0]!)[0]!.bytes).toEqual(CANDIDATE_FRAME);
    expect(userBody(requests[0]!).images).toEqual([{ frame: 'candidate', label: 'Candidate render to verify' }]);
  });
});

describe('the corrective re-check compares against the same frame', () => {
  test('both QA calls carry the identical baseline and the identical contract hash', async () => {
    const { e, videos } = sourceReferenced();
    const calls: number[] = [];
    const harness = depsWith(videos, {
      qa: (o) => {
        calls.push(calls.length);
        const pass = calls.length > 1;
        return { verdict: pass ? 'pass' : 'fail', reasons: pass ? [] : [`the subject's complexion is unchanged from the reference frame: the source frame shows a different complexion`], checks: [], contractHash: o.contract.contractHash, corrected: false, attempts: 1 };
      },
    });
    const result = await (await prepare(e, task, harness.deps)).execute(admission()) as { story: { verdict: string; attempts: number; corrected: boolean; qaBaseline: { attached: boolean } } };

    // Two QA calls happened: the initial check and the one bounded correction.
    expect(harness.qa).toHaveLength(2);
    expect(harness.qa[0]!.baseline).toEqual(SOURCE_FRAME);
    expect(harness.qa[1]!.baseline).toEqual(SOURCE_FRAME);
    expect(harness.qa[0]!.contract.contractHash).toBe(harness.qa[1]!.contract.contractHash);
    // The frame was read once and reused, not re-resolved per attempt.
    expect(harness.reads).toHaveLength(1);
    expect(result.story).toMatchObject({ verdict: 'pass', attempts: 2, corrected: true, qaBaseline: { attached: true } });
    expect(harness.uploads).toHaveLength(1);
  });
});