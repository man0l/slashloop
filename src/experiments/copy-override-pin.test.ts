// SLA-431: the exact per-slide copy an edit asked for must survive from the
// request, through normalization, into the effective brief AND the render
// request. The mocked SOURCE copy deliberately differs from the requested copy
// (including a blank) so a value that is quietly dropped and re-read from source
// cannot pass: production edits never reproduced this because the requested
// support already matched the source.
import { expect, test } from 'bun:test';
import type { Video } from '@prisma/client';
import { pinCopyOverrides, prepare } from './providers.js';
import { validateVariants, type Experiment, type Input, type Proposal, type Task } from './schema.js';
import type { SlideContract } from './render-prompt.js';

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
}) as unknown as Pick<Experiment, 'instructions'>;

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

  const [pinnedBaseline, pinnedAlternate] = pinCopyOverrides([baseline, alternate], e)!;
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
  const [pinned] = pinCopyOverrides([baseline], experiment({ '1': 'New support' }))!;
  expect(pinned!.brief.slides[1]!.overlayText).toBe('New support');
  expect(pinned!.brief.slides[2]!.overlayText).toBe(SOURCE_COPY[2]);
  expect(pinned!.brief.copyOverrides).toEqual({ '1': 'New support' });
  expect(pinned!.brief.slides[0]!.overlayText).toBe(SOURCE_COPY[0]);
});

test('a blank slide 1 is carried by the override, never by a falsy hook fallback', () => {
  const baseline = proposal(SOURCE_COPY[0]!, SOURCE_COPY[1]!, SOURCE_COPY[2]!);
  const [pinned] = pinCopyOverrides([baseline], experiment({ '0': '', '1': 'New support' }))!;
  expect(pinned!.brief.copyOverrides!['0']).toBe('');
  expect(pinned!.brief.slides[0]!.overlayText).toBe('');
  // Brief.hook is min(1), so the prose field keeps a non-empty value; the
  // override is what is authoritative and must not be lost to a truthiness test.
  expect(pinned!.brief.hook.length).toBeGreaterThan(0);
});

test('an out-of-range or non-numeric override index fails before any provider call', () => {
  expect(() => pinCopyOverrides([proposal('h', 's', 'p')], experiment({ slides: 'x' as never })))
    .toThrow(/invalid_slide_mapping|not a slide index/);
});

// ---- render request: the value must survive all the way to the model --------

function sourceReferenced(copyOverrides?: Record<string, string>) {
  process.env.R2_THUMB_PUBLIC_BASE = 'https://assets.example.test';
  process.env.OPENROUTER_API_KEY = 'test-only';
  const videos = ['src'].map(id => ({ id, mediaStatus: 'slideshow', rawJson: JSON.stringify({ slideshowKeys: [0, 1, 2].map(i => `w/${id}/slides/0${i}.jpg`) }) } as Video));
  const [pinned] = pinCopyOverrides([proposal('Old hook', 'Old support', 'Old payoff')], experiment(copyOverrides))!;
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

test('supporting copy that was never requested keeps its resolved source value', async () => {
  // Only slide 2 is overridden, so slide 3 must keep its source-derived copy.
  const { e, videos } = sourceReferenced({ '0': 'New hook', '1': 'New support' });
  const payoff = await render(e, videos, 2);
  // No override for this slide, so the value is the resolved source copy — the
  // key property is that it is neither blanked nor attributed to an override.
  expect(payoff.contract.overlay.text).toBe(SOURCE_COPY[2]);
  expect(payoff.contract.overlay.text).not.toBe('');
  expect(payoff.contract.overlay.origin).not.toBe('override');
  expect(payoff.prompt).toContain(SOURCE_COPY[2]!);
});
