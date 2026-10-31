import { describe, expect, test } from 'bun:test';
import { MCPI_VERIFY_VALUE, mcpiVerifyResponse } from './mcpi-verify.js';

describe('/.well-known/mcpi-verify', () => {
  test('serves the verify token as plain text', async () => {
    const res = mcpiVerifyResponse();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toBe(MCPI_VERIFY_VALUE);
    expect(MCPI_VERIFY_VALUE).toBe('mcpi-verify=b82b69a578966ed338de8c48288fbd51');
  });
});
