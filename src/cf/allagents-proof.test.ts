import { describe, expect, test } from 'bun:test';
import { ALLAGENTS_PROOF_VALUE, allagentsProofResponse } from './allagents-proof.js';

describe('/.well-known/allagents-proof.txt', () => {
  test('serves the proof token as plain text', async () => {
    const res = allagentsProofResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(ALLAGENTS_PROOF_VALUE);
    expect(ALLAGENTS_PROOF_VALUE).toBe('allagents-proof=dee586ca2dd590db95d525bbea59ce7c');
  });
});
