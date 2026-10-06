// SLA-550: appearance locks (hair, eyes, wardrobe, complexion, ...) exist only for a photographed
// person. Unknown, mixed and non-person media keep only what the source stated for role, gaze and setting.
import { describe, expect, test } from 'bun:test';
import { compileSlideContract, contractCheckPlan, contractChecks, type ObservedCopy } from './render-prompt.js';

const blank = (): ObservedCopy => ({ state: 'observed_empty', text: '' });
const sourceMap = { videoId: 'v', analysisId: 'a', sourceIndex: 0, referenceKind: 'slide', path: null };
const scene = 'A man with curly light-brown hair and blue eyes wearing a blue hockey jersey and a gold chain, looking right, in a locker room.';
const PERSON_ATTRS = ['hair', 'eyes', 'facial-hair', 'complexion', 'wardrobe', 'jewelry'];

function build(medium: string, identityLocked = true) {
  return compileSlideContract({ slideIndex: 0, role: 's', medium, scene, overlay: { mode: 'clear', text: '', origin: 'source' }, observedCopy: blank(), sourceMap, identityLocked });
}
const attrs = (medium: string) => build(medium).subject.lockedAttributes.map(l => l.attribute);

describe('appearance locks follow the medium', () => {
  test('a photograph keeps the person-appearance locks', () => {
    const present = attrs('photograph');
    expect(present).toContain('hair');
    expect(present).toContain('wardrobe');
    expect(contractChecks(build('photograph')).join('\n')).toMatch(/hair/);
  });

  for (const medium of ['unknown', 'mixed', 'mixed: photograph and collage', 'collage', 'animated', 'illustration', '']) {
    test(`"${medium}" emits no appearance lock and no appearance check, observed or not`, () => {
      const c = build(medium || 'unknown');
      const present = c.subject.lockedAttributes.map(l => l.attribute);
      for (const a of PERSON_ATTRS) expect(present).not.toContain(a);
      const checks = contractChecks(c).join('\n').toLowerCase();
      for (const word of ['hair', 'eyes', 'wardrobe', 'jewelry', 'complexion']) expect(checks).not.toContain(word);
      expect(contractCheckPlan(c).map(x => x.check).join('\n').toLowerCase()).not.toMatch(/hair|wardrobe|jewelry/);
    });
  }

  test('non-person media still keep the observed gaze and setting', () => {
    for (const medium of ['unknown', 'mixed']) {
      const present = build(medium).subject.lockedAttributes.filter(l => l.observed).map(l => l.attribute);
      for (const a of present) expect(PERSON_ATTRS).not.toContain(a);
    }
    expect(contractChecks(build('mixed')).join('\n').toLowerCase()).toMatch(/gaze|setting|locker/);
  });

  test('case and surrounding space in the medium do not flip the policy', () => {
    expect(attrs('  Photograph ')).toContain('hair');
    expect(attrs('Mixed')).not.toContain('hair');
  });
});
