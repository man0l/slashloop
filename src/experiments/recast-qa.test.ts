import { describe, expect, test } from 'bun:test';
import { contractView } from './contract-flow.js';
import { compileQaPrompt, compileSlidePrompt, qaVerdict, splitLeversByIdentity, type QaAnswer, type ResolvedContract } from './resolved-contract.js';
import type { BriefData } from './schema.js';

// Fixture: the SLA-860 multiplication smoke (experiment c2e2eb73), source identity kept on arm A, character arms f77c0712 and 1330dc01.
const USER_LOCK = 'Every slide of every alternate is an edit of the matching source slide (or of the baseline slide for the scene arm): same framing, same pose; never a newly imagined image';
const BUZZ = 'Early-twenties man with closely cropped black hair, clean-shaven face, deep brown eyes, medium-brown skin, solid athletic build, small silver hoop in left ear, photorealistic phone snapshot with even indoor light and slight grain';
const WAVY = 'Early-twenties man with medium-length wavy light-brown hair, short boxed beard, green eyes, fair skin with freckles, slim build, no piercings, photorealistic unretouched phone photo style';
const levels = ['low', 'mid', 'high'] as const;
const slides = Array.from({ length: 6 }, (_, i) => ({
  overlayText: `caption ${i + 1}`, arcLevel: levels[Math.min(2, Math.floor(i / 2))]!, scene: `a man on a bed in a furnished room, pose ${i + 1}`, composition: 'centred', visibleChange: '',
}));
const contract = {
  version: 1, subject: 'person', identity: 'source', identitySheet: '', medium: 'unpolished phone photograph, even indoor ambient light, slight grain',
  keepSourceImage: true, borrowSourceLook: false, arcAxis: 'progress over time marked by outfits and hair',
  sourceFrames: slides.map((_, i) => ({ index: i, level: levels[Math.min(2, Math.floor(i / 2))]!, showsPerson: true })),
  sourceArc: { axis: 'wardrobe, hair volume and setting over time', levers: ['outfit', 'hair volume and length', 'background setting', 'hand position on neck'], magnitude: 'clear',
    lowVsHigh: 'shirtless with compact curly hair and hand on neck versus graphic t-shirt with much fuller flying hair against a blank wall' },
  hardLocks: [{ text: USER_LOCK, origin: 'user' }, { text: 'No text other than the caption', origin: 'workspace' }],
  keptSourceDefaults: [], droppedSourceDefaults: [], droppedLocks: [], slides, hook: 'caption 1', issues: [],
} as unknown as ResolvedContract;

const brief = (character: string): BriefData => ({ character, visualStyle: contract.medium, caption: '', cta: '', slides } as unknown as BriefData);
const exp = { contract };
const recastView = (character: string) => contractView(exp, brief(character), { changedVariables: [{ name: 'character', value: character }] });
const baselineView = contractView(exp, brief(''), { changedVariables: [] });

const judge = (o: { person: 'new' | 'source'; locks: boolean; scene?: boolean }): QaAnswer => ({
  slides: slides.map((s, index) => ({
    index, textSeen: s.overlayText, overlayExact: true, sceneMatches: o.scene ?? true, stateLevel: s.arcLevel, mediumMatches: true,
    lockResults: contract.hardLocks.map(l => ({ lock: l.text, pass: o.locks, note: o.locks ? 'same room, pose and outfit' : 'different person and hair, not a source edit' })),
  })),
  deck: { identityConsistent: true, sourceLikeness: o.person === 'source', arcVisibleWithoutText: true, notes: '' },
});

describe('a character arm is judged on its own identity (SLA-891)', () => {
  test('the arm view carries the arm\'s identity sheet and no source-image edit', () => {
    const v = recastView(BUZZ);
    expect(v.recast).toBe(true);
    expect(v.identity).toBe('invented-consistent');
    expect(v.identitySheet).toBe(BUZZ);
    expect(v.keepSourceImage).toBe(false);
    expect(baselineView.recast).toBeUndefined();
    expect(baselineView.identity).toBe('source');
  });

  test('arc levers the identity sheet fixes are dropped for that arm only', () => {
    for (const sheet of [BUZZ, WAVY]) {
      const v = recastView(sheet);
      expect(v.sourceArc!.levers).toEqual(['outfit', 'background setting', 'hand position on neck']);
      expect(v.sourceArc!.lowVsHigh).toBe('');
      expect(v.fixedLevers).toEqual(['hair volume and length']);
      const p = compileSlidePrompt(v, 1, 'fresh', 'none');
      expect(p).not.toMatch(/curly hair|flying hair|by changing [^.]*hair/);
      expect(p).toContain('Not hair volume and length: the subject description fixes it');
    }
    expect(baselineView.sourceArc!.levers).toContain('hair volume and length');
    expect(baselineView.sourceArc!.lowVsHigh).toContain('curly');
    expect(splitLeversByIdentity(['hair volume'], 'a man in a grey hoodie').fixed).toEqual([]);
  });

  test('the QA prompt tells the judge the person is replaced and the source is for framing, pose, setting, outfit and medium', () => {
    const p = compileQaPrompt(recastView(BUZZ), { slideCount: 6, sourceImages: 0, referenceUse: 'none', baselineImages: 6 });
    expect(p).toContain('RECAST ARM');
    expect(p).toContain('same framing, pose, setting, outfit and medium, NOT the same person');
    expect(p).toContain('Compare framing, pose, setting, outfit and medium only');
    expect(p).toContain(BUZZ);
    expect(p).toContain('The identity sheet fixes hair volume and length');
    expect(p).not.toContain('unchanged from its source frame');
    expect(p).not.toContain('curly');
    expect(p).toContain('including any visible part of their body (hands, arms, skin marks, tattoos)');
    expect(p).not.toContain('to change ONLY the setting');
  });

  test('a lone source frame is a likeness reference the slides must not match', () => {
    const p = compileQaPrompt(recastView(WAVY), { slideCount: 6, sourceImages: 1, referenceUse: 'none' });
    expect(p).toContain('compare framing, pose, setting, outfit and medium only');
    expect(p).toContain('must NOT show this person');
  });

  test('the baseline arm\'s prompt is unchanged: it still holds the source and its arc', () => {
    const p = compileQaPrompt(baselineView, { slideCount: 6, sourceImages: 6, referenceUse: 'edit' });
    expect(p).not.toContain('RECAST ARM');
    expect(p).toContain('unchanged from its source frame');
  });

  test('a different person in the same room passes; the stored failure answer still fails a source-likeness leak', () => {
    const v = recastView(BUZZ);
    expect(qaVerdict(v, judge({ person: 'new', locks: true })).passed).toBe(true);
    expect(qaVerdict(v, judge({ person: 'source', locks: true })).failures.deck?.[0]).toContain('source person');
    const old = qaVerdict(v, judge({ person: 'new', locks: false, scene: false }));
    expect(old.passed).toBe(false);
    expect(old.failures['0']).toContain(`violates "${USER_LOCK}": different person and hair, not a source edit`);
  });

  test('a character edit prompt replaces every visible part of the body', () => {
    const p = compileSlidePrompt(recastView(BUZZ), 0, 'baseline-edit', 'none', '', '', '', { character: true, scene: false });
    expect(p).toContain('hands, arms, skin tone, skin marks and tattoos');
  });
});
