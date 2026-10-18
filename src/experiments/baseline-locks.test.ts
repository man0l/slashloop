import { describe, expect, test } from 'bun:test';
import { contractView, settleQa } from './contract-flow.js';
import { compileQaPrompt, compileSlidePrompt, lockScope, locksForArm, qaVerdict, withoutExemptLocks, type QaAnswer, type ResolvedContract } from './resolved-contract.js';
import type { BriefData } from './schema.js';

// Fixture: the SLA-860 character run (experiment 61420838): a baseline that is a pixel-faithful edit of the source and a recast alternate.
const USER_LOCK = 'Every slide of the alternate is an edit of the matching source slide: same framing, same pose, same outfit, same room and lighting; only the person is replaced.';
const WS_LOCK = 'No text other than the caption';
const BUZZ = 'Early-twenties man with closely cropped black hair, clean-shaven face, deep brown eyes, medium-brown skin, solid athletic build, no tattoos';
const NOTE = 'image is identical to source; person not replaced';
const slides = Array.from({ length: 6 }, (_, i) => ({ overlayText: `caption ${i + 1}`, arcLevel: 'none' as const, scene: `a man on a bed, pose ${i + 1}`, composition: 'centred', visibleChange: '' }));
const contract = {
  version: 1, subject: 'person', identity: 'source', identitySheet: '', medium: 'phone photograph', keepSourceImage: true, borrowSourceLook: false, arcAxis: '',
  sourceFrames: slides.map((_, i) => ({ index: i, level: 'none', showsPerson: true })),
  hardLocks: [{ text: USER_LOCK, origin: 'user' }, { text: WS_LOCK, origin: 'workspace' }],
  keptSourceDefaults: [], droppedSourceDefaults: [], droppedLocks: [], slides, hook: 'caption 1', issues: [],
} as unknown as ResolvedContract;
const brief = (character: string): BriefData => ({ character, visualStyle: contract.medium, caption: '', cta: '', slides } as unknown as BriefData);
const exp = { contract };
const baselineView = contractView(exp, brief(''), { changedVariables: [] });
const recastView = contractView(exp, brief(BUZZ), { changedVariables: [{ name: 'character', value: BUZZ }] });

// The stored answer for the baseline arm: every slide fails the alternate's lock.
const baselineAnswer = (): QaAnswer => ({
  slides: slides.map((s, index) => ({
    index, textSeen: s.overlayText, overlayExact: true, sceneMatches: true, stateLevel: 'none', mediumMatches: true,
    lockResults: [{ lock: USER_LOCK, pass: false, note: NOTE }, { lock: WS_LOCK, pass: true, note: '' }],
  })),
  deck: { identityConsistent: true, sourceLikeness: false, arcVisibleWithoutText: true, notes: '' },
});

describe('locks follow arms (SLA-917)', () => {
  test('a lock that describes the alternate\'s change is the alternate\'s, not the baseline\'s', () => {
    expect(lockScope(USER_LOCK).alternateOnly).toBe(true);
    expect(lockScope('Use the new setting on every slide').alternateOnly).toBe(true);
    expect(lockScope('Keep the caption short').alternateOnly).toBe(false);
    expect(lockScope('Every alternate is an edit of the baseline slide').alternateOnly).toBe(false);
    expect(locksForArm(contract.hardLocks, new Set()).exempt.map(l => l.text)).toEqual([USER_LOCK]);
    expect(locksForArm(contract.hardLocks, new Set(['character'])).exempt).toEqual([]);
    expect(locksForArm(contract.hardLocks, new Set(['scene'])).exempt.map(l => l.text)).toEqual([USER_LOCK]);
  });

  test('the baseline view drops the lock from the judge and the renderer, the alternate keeps it', () => {
    expect(baselineView.hardLocks.map(l => l.text)).toEqual([WS_LOCK]);
    expect(baselineView.exemptLocks).toEqual([USER_LOCK]);
    expect(recastView.hardLocks.map(l => l.text)).toEqual([USER_LOCK, WS_LOCK]);
    expect(recastView.exemptLocks).toBeUndefined();
    const ask = { slideCount: 6, sourceImages: 6, referenceUse: 'edit' as const };
    expect(compileQaPrompt(baselineView, ask)).not.toContain('only the person is replaced');
    expect(compileQaPrompt(recastView, { ...ask, baselineImages: 6 })).toContain('only the person is replaced');
    expect(contract.hardLocks).toHaveLength(2);
  });

  test('the stored baseline answer passes with a warning; the alternate is still judged on the same lock', () => {
    const base = qaVerdict(baselineView, baselineAnswer());
    expect(base.passed).toBe(true);
    expect(base.failures).toEqual({});
    expect(base.warnings).toHaveLength(1);
    expect(qaVerdict(recastView, baselineAnswer()).failures['0']).toEqual([`violates "${USER_LOCK}": ${NOTE}`]);
  });

  test('SLA-891 still holds: a recast arm that shows the source body fails', () => {
    const a = baselineAnswer();
    a.slides.forEach(s => { s.lockResults.forEach(l => { l.pass = true; }); });
    expect(qaVerdict(recastView, a).passed).toBe(true);
    a.deck.sourceLikeness = true;
    expect(qaVerdict(recastView, a).failures.deck?.[0]).toContain('source person');
  });

  test('a baseline whose only failures are exempt locks settles passed and schedules no repair', () => {
    const verdict = qaVerdict(baselineView, baselineAnswer());
    const e = {
      status: 'generating', creditsCharged: 124, maxCredits: 400, providerCalls: {},
      variants: [{ id: 'a9c5fb7a', status: 'generating', slides: slides.map((_, index) => ({ index, status: 'done', provider: 'edit' })), baselineId: undefined, changedVariables: [] }],
      tasks: [{ id: 'qa1', kind: 'qa', target: 'a9c5fb7a', status: 'done', attempts: 1, charged: 0 }],
    } as never as Parameters<typeof settleQa>[0];
    settleQa(e, e.tasks[0]!, verdict);
    expect(e.variants[0]!.status).toBe('done');
    expect(e.variants[0]!.qaDeck?.verdict).toBe('passed');
    expect(e.tasks).toHaveLength(1);
    expect(e.status).toBe('completed');
  });

  test('a repair note citing an exempt lock never reaches the slide prompt', () => {
    const fix = `violates "${USER_LOCK}": ${NOTE} | the caption must be exactly "caption 1" (seen: "x")`;
    expect(withoutExemptLocks(fix, baselineView.exemptLocks)).toBe('the caption must be exactly "caption 1" (seen: "x")');
    const p = compileSlidePrompt(baselineView, 0, 'edit', 'edit', fix);
    expect(p).not.toContain('person not replaced');
    expect(p).toContain('FIX FROM QA: the caption must be exactly');
    expect(compileSlidePrompt(baselineView, 0, 'edit', 'edit', `violates "${USER_LOCK}": ${NOTE}`)).not.toContain('FIX FROM QA');
  });
});
