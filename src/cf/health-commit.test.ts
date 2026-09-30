import { describe, expect, test } from 'bun:test';
import { DEPLOY_SHA } from './deploy-sha.js';
import { healthBody } from './health.js';

describe('worker /health commit', () => {
  test('reports the stamped deploy sha and the existing health fields', () => {
    const body = healthBody('https://mcp.slashloop.dev', 'https://example.test/auth/v1');
    expect(body).toEqual({
      ok: true,
      service: 'slashloop',
      mode: 'remote',
      public_url: 'https://mcp.slashloop.dev',
      as: 'https://example.test/auth/v1',
      tools: 'full',
      db: 'parallel',
      commit: 'dev',
    });
    expect(body.commit).toBe(DEPLOY_SHA);
  });
});
