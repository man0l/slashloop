// SLA-868: a composite deck is an ordinary experiment source, and a hook-only
// experiment on it is a text edit.
import { describe, expect, test } from 'bun:test';
import { experimentSourceKeys, hasExperimentSlides } from '../../lib/media.js';
import { renderContract } from '../render-prompt.js';
import { compositeDeckEstimate } from './deck.js';

const keys = Array.from({ length: 9 }, (_, i) => `ws/v1/recreate/${String(i).padStart(2, '0')}.jpg`);
const raw = JSON.stringify({ recreationKeys: keys, recreationModel: 'composite', compositeDeck: { fingerprint: 'f', faceIds: [] } });

describe('composite deck as an experiment source (SLA-868)', () => {
  test('is experiment-eligible and its recreation keys are the experiment source', () => {
    expect(hasExperimentSlides(raw)).toBe(true);
    expect(experimentSourceKeys(raw)).toEqual(keys);
  });
  test('a hook-only experiment is a text edit with fan-out 1', () => {
    const c = renderContract(['hook'], [{ name: 'hook' }]);
    expect(c.kind).toBe('hook-text');
    expect(c.fanout).toBe(1);
    expect(c.changeFaces).toBe(false);
    expect(c.changeStory).toBe(false);
  });
  test('building the deck costs no render credits and no image-model call', () => {
    expect(compositeDeckEstimate(keys.length)).toMatchObject({ slides: 9, renderCredits: 0, totalCredits: 0, imageModelCalls: 0 });
  });
});
