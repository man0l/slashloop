import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { classifyOAuthError, formatOAuthError, logOAuthError } from './oauth-error-log.js';

describe('classifyOAuthError', () => {
  test('expected 4xx client noise is info', () => {
    expect(classifyOAuthError({ status: 401, code: 'invalid_token' })).toBe('info');
    expect(classifyOAuthError({ status: 400, code: 'invalid_request' })).toBe('info');
    expect(classifyOAuthError({ status: 400, code: 'invalid_client_metadata' })).toBe('info');
  });

  test('5xx is error regardless of code', () => {
    expect(classifyOAuthError({ status: 500, code: 'server_error' })).toBe('error');
    expect(classifyOAuthError({ status: 503, code: 'invalid_token' })).toBe('error');
  });

  test('other 4xx stays warn', () => {
    expect(classifyOAuthError({ status: 400, code: 'invalid_grant' })).toBe('warn');
    expect(classifyOAuthError({ status: 403, code: 'insufficient_scope' })).toBe('warn');
    expect(classifyOAuthError({ status: 401, code: 'invalid_client' })).toBe('warn');
    expect(classifyOAuthError({ status: 429, code: 'invalid_request' })).toBe('warn');
  });
});

describe('formatOAuthError', () => {
  test('includes user-agent when the provider passes the request', () => {
    const request = new Request('https://x.test/mcp', { headers: { 'user-agent': 'claude-code/1.2' } });
    const line = formatOAuthError({ status: 401, code: 'invalid_token', description: 'Invalid token', request });
    expect(line).toBe('OAuth error response: 401 invalid_token - Invalid token ua=claude-code/1.2');
  });

  test('never reads the authorization header', () => {
    const request = new Request('https://x.test/mcp', {
      headers: { authorization: 'Bearer secret-token-value', 'user-agent': 'ua' },
    });
    const line = formatOAuthError({ status: 401, code: 'invalid_token', description: 'bad', request });
    expect(line).not.toContain('secret-token-value');
  });

  test('sanitizes and caps probe-controlled text', () => {
    const line = formatOAuthError({
      status: 400,
      code: 'invalid_client_metadata',
      description: `grant\nurn:aindx:${'x'.repeat(500)}`,
    });
    expect(line).not.toContain('\n');
    expect(line.length).toBeLessThan(300);
  });
});

describe('logOAuthError', () => {
  const spies: Array<{ mockRestore(): void }> = [];
  afterEach(() => spies.splice(0).forEach((s) => s.mockRestore()));

  function spyAll() {
    const info = spyOn(console, 'info').mockImplementation(() => {});
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    const error = spyOn(console, 'error').mockImplementation(() => {});
    spies.push(info, warn, error);
    return { info, warn, error };
  }

  test('401 invalid_token logs at info only, returns void', () => {
    const { info, warn, error } = spyAll();
    expect(logOAuthError({ status: 401, code: 'invalid_token', description: 'Invalid token' })).toBeUndefined();
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  test('5xx logs at error', () => {
    const { info, warn, error } = spyAll();
    logOAuthError({ status: 500, code: 'server_error', description: 'boom' });
    expect(error).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});
