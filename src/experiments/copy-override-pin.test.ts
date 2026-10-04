// SLA-431: the exact per-slide copy an edit asked for must survive from the
// request, through normalization, into the effective brief AND the render
// request. The mocked SOURCE copy deliberately differs from the requested copy
// (including a blank) so a value that is quietly dropped and re-read from source
// cannot pass: production edits never reproduced this because the requested
// support already matched the source.
import { expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { pinCopyOverrides, prepare } from './providers.js';
import { settle } from './engine.js';
import { Instructions, validateVariants, type Experiment, type Input, type Proposal, type Task } from './schema.js';
import { persistedOverlayText, type SlideContract } from './render-prompt.js';

/** The same dedupe key the plan flow uses after pinning. */
const fingerprintOf = (p: Proposal) => JSON.stringify([
  p.brief.hook, p.brief.concept, p.brief.character, p.brief.visualStyle, p.brief.caption, p.brief.cta, p.brief.slides,
]).toLowerCase();

/** Source decks whose slides 2-3 say something the request does NOT ask for. */
const SOURCE_COPY = ['Old hook', 'Old support', 'Old payoff'];

function proposal(hook: string, support: string, payoff: string): Proposal {
  return {
    title: hook, hypothesis: 'h',
    changedVariables: [], brief: {
      concept: 'Guide', hook, character: 'Adult', visualStyle: 'Editorial', caption: '', cta: '',
      lockedConstraints: [], slides: [
        { role: 'hook', scene: 'A man in a blue hockey jersey, looking right.', overlayText: hook },
        { role: 'support', scene: 'Six men on a plain white background.', overlayText: support },
        { role: 'payoff', scene: 'Profile card on white.', overlayText: payoff },
      ],
    },
  } as unknown as Proposal;
}

const experiment = (copyOverrides?: Record<string, string>) => ({
  id: 'e', workspaceId: 'w', slideCount: 3, instructions: {
    goal: 'g', brand: '', audience: '', language: 'English', direction: 'prose', lockedConstraints: [],
    variables: ['hook'], mode: 'controlled', ...(copyOverrides ? { copyOverrides } : {}),
  },
}) as unknown as Pick<Experiment, 'instructions' | 'slideCount'>;

test('the requested support and blanks reach the effective brief of every variant', () => {
  // The fan-out retold supporting copy in the alternate variant; the pin must
  // overwrite both variants with the requested values and leave slide 4+ alone.
  const baseline = proposal(SOURCE_COPY[0]!, SOURCE_COPY[1]!, SOURCE_COPY[2]!);
  // A hook-only variant leaves slide 1's stored overlayText at the baseline value
  // (effectiveOverlayText renders brief.hook there), which is what expandDelta does.
  const alternate = proposal('An alternate hook', 'A retold angle nobody asked for', 'A retold payoff');
  alternate.changedVariables = [{ name: 'hook', value: 'An alternate hook' }];
  alternate.brief.slides[0]!.overlayText = SOURCE_COPY[0]!;
  const e = experiment({ '0': 'New hook', '1': 'New support', '2': '' });

  const [pinnedBaseline, pinnedAlternate] = pinCopyOverrides([baseline, alternate], e).proposals;
  // Slide 2+ is pinned identically on BOTH variants: exact user support/blanks.
  for (const p of [pinnedBaseline!, pinnedAlternate!]!) {
    expect(p.brief.slides.slice(1).map(s => s.overlayText)).toEqual(['New support', '']);
  }
  // The requested hook is the BASELINE's value and slide 1 mirrors it.
  expect(pinnedBaseline!.brief.hook).toBe('New hook');
  expect(pinnedBaseline!.brief.slides[0]!.overlayText).toBe('New hook');
  expect(pinnedBaseline!.brief.copyOverrides).toEqual({ '0': 'New hook', '1': 'New support', '2': '' });
  // The alternate keeps its OWN hook: that is the approved legacy A/B axis, and
  // forcing the requested hook onto it would collapse both decks into one.
  expect(pinnedAlternate!.brief.hook).toBe('An alternate hook');
  expect(pinnedAlternate!.brief.copyOverrides).toEqual({ '1': 'New support', '2': '' });
  // Slide 1's inert overlayText is aligned to the requested hook on BOTH
  // variants, so the storyboard diff stays hook-only and validation passes.
  expect(pinnedAlternate!.brief.slides[0]!.overlayText).toBe('New hook');
  // The hook stays the only variant axis: the retold support is gone, so
  // validation no longer reads those slides as a second unapproved variable.
  expect(validateVariants(e as Experiment, [pinnedBaseline!, pinnedAlternate!])).toBeUndefined();
});

test('omitted supporting copy is left to the resolved source, not blanked', () => {
  const baseline = proposal(SOURCE_COPY[0]!, SOURCE_COPY[1]!, SOURCE_COPY[2]!);
  // Only slide 2 was requested. Slide 3 keeps whatever the source said.
  const [pinned] = pinCopyOverrides([baseline], experiment({ '1': 'New support' })).proposals;
  expect(pinned!.brief.slides[1]!.overlayText).toBe('New support');
  expect(pinned!.brief.slides[2]!.overlayText).toBe(SOURCE_COPY[2]);
  expect(pinned!.brief.copyOverrides).toEqual({ '1': 'New support' });
  expect(pinned!.brief.slides[0]!.overlayText).toBe(SOURCE_COPY[0]);
});

test('a blank slide 1 is carried by the override, never by a falsy hook fallback', () => {
  const baseline = proposal(SOURCE_COPY[0]!, SOURCE_COPY[1]!, SOURCE_COPY[2]!);
  const [pinned] = pinCopyOverrides([baseline], experiment({ '0': '', '1': 'New support' })).proposals;
  expect(pinned!.brief.copyOverrides!['0']).toBe('');
  expect(pinned!.brief.slides[0]!.overlayText).toBe('');
  // Brief.hook is min(1), so the prose field keeps a non-empty value; the
  // override is what is authoritative and must not be lost to a truthiness test.
  expect(pinned!.brief.hook.length).toBeGreaterThan(0);
});

test('a non-numeric override index is refused; an unrenderable one is reported, not fatal', () => {
  // A malformed key is a real caller error and still fails loudly.
  expect(() => pinCopyOverrides([proposal('h', 's', 'p')], experiment({ slides: 'x' as never })))
    .toThrow(/is not a slide index/);
  expect(() => pinCopyOverrides([proposal('h', 's', 'p')], experiment({ '2': 'x' }))).not.toThrow();

  // M1: an index past the effective slide count is NORMAL input, not a caller
  // mistake. The wizard sizes its form from the raw card length while the
  // experiment drops a CTA last slide and prefers the recreation deck, so a
  // user is shown a box for a slide that will not render. This runs inside the
  // paid briefs execute(), where a refusal requeues four times and then fails
  // the run outright — so it must clamp and report instead.
  const e = experiment({ '0': 'New hook', '1': 'New support', '2': '', '4': 'Unrenderable slide' });
  const { proposals, dropped } = pinCopyOverrides([proposal('Old hook', 'Old support', 'Old payoff')], e);
  expect(dropped).toEqual(['4']);
  // Every in-range value is still honoured exactly; only the slide with nowhere
  // to go is skipped.
  expect(proposals[0]!.brief.slides.map(s => s.overlayText)).toEqual(['New hook', 'New support', '']);
  expect(proposals[0]!.brief.copyOverrides).toEqual({ '0': 'New hook', '1': 'New support', '2': '' });
  // It never rejects the run.
  expect(validateVariants(e as Experiment, proposals)).toBeUndefined();
});

// ---- render request: the value must survive all the way to the model --------

function sourceReferenced(copyOverrides?: Record<string, string>) {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  const videos = ['src'].map(id => ({ id, mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: [0, 1, 2].map(i => `w/${id}/slides/0${i}.jpg`) }) } as Video));
  const [pinned] = pinCopyOverrides([proposal('Old hook', 'Old support', 'Old payoff')], experiment(copyOverrides)).proposals;
  const brief = { ...pinned!.brief, slides: pinned!.brief.slides };
  const e = {
    id: 'e', workspaceId: 'w', status: 'generating', generationBasis: 'source-referenced',
    styleFormula: { medium: 'photograph', density: 'minimal' },
    instructions: experiment(copyOverrides).instructions,
    inputs: [{
      videoId: 'src', status: 'ready', analysisId: 'an1', jobId: null, error: null, coverage: null, evidence: [],
      // Recorded source copy differs from the requested copy, slide 2 included.
      copy: [
        { slideIndex: 0, state: 'observed_text', text: SOURCE_COPY[0] },
        { slideIndex: 1, state: 'observed_text', text: SOURCE_COPY[1] },
        { slideIndex: 2, state: 'observed_text', text: SOURCE_COPY[2] },
      ],
    }] as Input[],
    variants: [{ id: 'v', revision: 1, baselineId: null, changedVariables: [], frozenBrief: brief, slides: [] }],
  } as unknown as Experiment;
  return { e, videos };
}

const deps = (videos: Video[], calls: unknown[], qa: SlideContract[]) => ({
  findSources: async () => videos,
  generateImage: async (o: unknown) => { calls.push(o); return { buffer: Buffer.alloc(600), contentType: 'image/jpeg', costUsd: 0 }; },
  upload: async () => ({ path: 'stored', sizeBytes: 600 }),
  describeCandidates: async (b: Buffer[]) => b.map((_, i) => ({ id: `c${i}`, description: `candidate ${i}`, overdesigned: false })),
  classify: async () => ({ value: 'c0', confidence: 0.9 }),
  jevScores: async () => ({}),
  generateBriefCandidates: async () => { throw new Error('not used'); },
  verifyStory: async (o: { contract: SlideContract }) => {
    qa.push(o.contract);
    return { verdict: 'pass' as const, reasons: [], checks: [{ check: 'c', status: 'pass' as const }], contractHash: o.contract.contractHash, corrected: false, attempts: 1 };
  },
});

async function render(e: Experiment, videos: Video[], index: number) {
  const calls: unknown[] = []; const qa: SlideContract[] = [];
  const task = { id: 't', kind: 'slide', target: 'v', index } as Task;
  const result = await (await prepare(e, task, deps(videos, calls, qa) as never)).execute() as { prompt: string; story: { contractHash: string } };
  return { prompt: result.prompt, promptCalls: calls as Array<{ prompt: string }>, contract: qa[0]!, storyHash: result.story.contractHash };
}

test('the requested support copy reaches the render request and the QA contract', async () => {
  const { e, videos } = sourceReferenced({ '0': 'New hook', '1': 'New support', '2': '' });
  // Slide 2 requested "New support"; the source says "Old support".
  const support = await render(e, videos, 1);
  expect(support.contract.overlay).toEqual({ mode: 'replace', text: 'New support', origin: 'override' });
  expect(support.prompt).toContain('New support');
  expect(support.prompt).not.toContain('Old support');
  // One contract, one hash, for both operations.
  expect(support.storyHash).toBe(support.contract.contractHash);
  expect(support.prompt).toContain(support.contract.contractHash);
});

test('an explicit blank strips the source words instead of letting them back in', async () => {
  const { e, videos } = sourceReferenced({ '0': 'New hook', '1': 'New support', '2': '' });
  // Slide 3 requested blank; the source says "Old payoff".
  const payoff = await render(e, videos, 2);
  expect(payoff.contract.overlay).toEqual({ mode: 'clear', text: '', origin: 'override' });
  expect(payoff.prompt).not.toContain('Old payoff');
  expect(payoff.prompt).toContain('the only ADDED text rendered in the image is ""');
});

// ---- the contradictory-combination guard (F4) -----------------------------

test('exact copy overrides refuse to ride along with a supporting-copy retell', () => {
  // F4: copyOverrides says "these words are the answer". varySupportingOverlays
  // and the concept/slides variable say "the model may rewrite them". One
  // silently defeating the other is how the decision became a convention only.
  const base = {
    goal: 'g', brand: '', audience: '', language: 'English', direction: '',
    lockedConstraints: [], variables: ['hook'], mode: 'controlled',
    copyOverrides: { '0': 'New hook', '1': 'New support' },
  };
  expect(Instructions.safeParse(base).success).toBe(true);
  // The authorized retell and exact overrides are mutually exclusive.
  const retell = Instructions.safeParse({ ...base, varySupportingOverlays: true });
  expect(retell.success).toBe(false);
  expect(String(retell.error?.issues[0]?.message)).toMatch(/varySupportingOverlays/);
  for (const variable of ['concept', 'slides']) {
    const structural = Instructions.safeParse({ ...base, mode: 'exploration', variables: [variable] });
    expect(structural.success).toBe(false);
    expect(String(structural.error?.issues[0]?.message)).toMatch(new RegExp(variable));
  }
  // An absent/empty override set keeps every existing caller working.
  expect(Instructions.safeParse({ ...base, copyOverrides: undefined }).success).toBe(true);
  expect(Instructions.safeParse({ ...base, copyOverrides: {}, varySupportingOverlays: true }).success).toBe(true);
  expect(Instructions.safeParse({ ...base, copyOverrides: undefined, varySupportingOverlays: true }).success).toBe(true);
});

test('override keys must be canonical slide indices and fit the deck', () => {
  // N1: '00' and '0' name the same slide. A string-keyed lookup silently drops
  // one of them, so the value vanishes with no dropped notice.
  const base = {
    goal: 'g', brand: '', audience: '', language: 'English', direction: '',
    lockedConstraints: [], variables: ['hook'], mode: 'controlled',
  };
  expect(Instructions.safeParse({ ...base, copyOverrides: { '0': 'a', '1': 'b' } }).success).toBe(true);
  for (const key of ['00', '007', '-1', 'x', '1.0', ' 1']) {
    expect(Instructions.safeParse({ ...base, copyOverrides: { [key]: 'a' } }).success).toBe(false);
  }
  // N3: instructions are interpolated into the report prompt, where an oversized
  // value blows the prompt budget and fails a paid task on the retry loop.
  const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [String(i), 'x']));
  expect(Instructions.safeParse({ ...base, copyOverrides: eight }).success).toBe(true);
  const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i), 'x']));
  expect(Instructions.safeParse({ ...base, copyOverrides: nine }).success).toBe(false);
});

// ---- post-pin collapse (F2) and the stored record (N5) ---------------------

test('a variant that collapses onto the baseline after pinning is dropped, not fatal', () => {
  // F2: the exact hook is quoted in the direction and both planner prompts, so a
  // model that honours the request for its "new hook" produces the requested
  // hook as the ALTERNATE too. Pinning then makes both decks identical. That is
  // a degenerate A/B, not a reason to 422 and burn the analysis/planning credits.
  const e = experiment({ '0': 'Requested hook', '1': 'New support', '2': '' });
  const baseline = proposal('Board hook', SOURCE_COPY[1]!, SOURCE_COPY[2]!);
  const collapsed = proposal('Requested hook', 'A retold angle nobody asked for', 'A retold payoff');
  collapsed.changedVariables = [{ name: 'hook', value: 'Requested hook' }];
  collapsed.brief.slides[0]!.overlayText = 'Board hook';

  const pinned = pinCopyOverrides([baseline, collapsed], e).proposals;
  // Every field the dedupe key reads is now identical: the brief copy matches,
  // and only the per-variant hook field differs — which the pin equalised.
  expect(pinned[1]!.brief.slides).toEqual(pinned[0]!.brief.slides);
  expect(pinned[1]!.brief.hook).toBe(pinned[0]!.brief.hook);
  expect(fingerprintOf(pinned[1]!)).toBe(fingerprintOf(pinned[0]!));
  // Validation used to throw unapproved_variable here, failing the whole run.
  expect(() => validateVariants(e as Experiment, pinned)).toThrow(/unapproved_variable|not_one_variable/);
  // The plan flow drops the duplicate instead, and a single variant is a
  // degraded success that validateVariants accepts.
  const baseFp = fingerprintOf(pinned[0]!);
  const kept = pinned.filter((p, i) => i === 0 || fingerprintOf(p) !== baseFp);
  expect(kept).toHaveLength(1);
  expect(validateVariants(e as Experiment, kept)).toBeUndefined();
});

test('the stored slide record reports the requested copy, including a blank slide 1', () => {
  // N5: the frame is blank, so the record and the site's image alt text must not
  // claim the generated hook. Brief.hook cannot be blank (min 1), so index 0
  // cannot fall back to it.
  const [pinned] = pinCopyOverrides([proposal('Generated board hook', 'Old support', 'Old payoff')], experiment({ '0': '', '1': 'New support' })).proposals;
  const brief = pinned!.brief;
  expect(brief.hook).toBe('Generated board hook');
  expect(persistedOverlayText(brief, 0)).toBe('');
  expect(persistedOverlayText(brief, 1)).toBe('New support');
  // An omitted index keeps the record's own value rather than inventing one.
  expect(persistedOverlayText(brief, 2)).toBe('Old payoff');
  // Without an override the helper is exactly the old behaviour.
  const plain = proposal('H', 'S', 'P').brief;
  expect(persistedOverlayText(plain, 0)).toBe('H');
  expect(persistedOverlayText(plain, 1)).toBe('S');
});

test('supporting copy that was never requested keeps its resolved source value', async () => {
  const { e, videos } = sourceReferenced({ '0': 'New hook', '1': 'New support' });
  const payoff = await render(e, videos, 2);
  // No override for this slide, so the value is the resolved source copy — the
  // key property is that it is neither blanked nor attributed to an override.
  expect(payoff.contract.overlay.text).toBe(SOURCE_COPY[2]);
  expect(payoff.contract.overlay.text).not.toBe('');
  expect(payoff.contract.overlay.origin).not.toBe('override');
  expect(payoff.prompt).toContain(SOURCE_COPY[2]!);
});

// ---- the notices a caller actually sees (N6/N7) ---------------------------

test('planning records its notices on the experiment, and clears stale ones', () => {
  // The user-visible half of the two degradations: a variant that collapsed to
  // the baseline, and requested copy for a slide that will not render. Before
  // this existed both were worker-log-only, so a caller who paid for a
  // two-variant A/B saw `variants: 1` against `variantCount: 2` with no
  // explanation.
  const withNotices = [
    'Requested copy made the alternate variant identical to the baseline, so this run has 1 variant(s) instead of 2.',
    'Requested copy for slide(s) 5 was not applied: this experiment renders 4 slides.',
  ];
  const briefs = (notices?: string[]) => ({
    id: 't', kind: 'briefs', target: '', index: null, status: 'running',
    error: null, attempts: 1, nextAttemptAt: null, startedAt: null,
  } as unknown as Task);

  const stale = { ...experimentFixture(), notices: ['left over from an earlier attempt'] } as unknown as Experiment;
  settle(stale, briefs(), { proposals: [proposal('h', 's', 'p')], notices: withNotices });
  expect(stale.notices).toEqual(withNotices);
  expect(stale.variants).toHaveLength(1);

  // A retry that produced nothing must not leave yesterday's notice behind.
  const retry = { ...experimentFixture(), notices: withNotices } as unknown as Experiment;
  settle(retry, briefs(), { proposals: [proposal('h', 's', 'p')] });
  expect(retry.notices).toBeUndefined();
  // An older caller that sends a plain proposal array still settles fine.
  const legacy = experimentFixture() as unknown as Experiment;
  expect(() => settle(legacy, briefs(), [proposal('h', 's', 'p')])).not.toThrow();
  expect(legacy.variants).toHaveLength(1);
});

function experimentFixture() {
  return {
    id: 'e', workspaceId: 'w', status: 'planning', variantCount: 2, slideCount: 3,
    generationBasis: 'source-referenced', report: null, variants: [], tasks: [],
    styleFormula: null, error: null, instructions: experiment().instructions,
  };
}
