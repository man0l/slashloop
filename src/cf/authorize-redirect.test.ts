// SLA-118: the authorize/login page must preserve the full MCP authorize
// request through the Supabase redirectTo handoff instead of dropping to '/'.
import { describe, expect, test } from 'bun:test';
import { defaultLoginRedirect, loginPage, safeRedirectTarget } from '../../remote/pages.js';

const OAUTH_SEARCH =
  '?client_id=test&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code' +
  '&scope=test&state=xyz&code_challenge=abc&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fmcp.slashloop.dev%2Fmcp';

describe('authorize redirect preservation (SLA-118)', () => {
  test('MCP authorize request defaults to the full authorize URL', () => {
    expect(defaultLoginRedirect(OAUTH_SEARCH, '/authorize')).toBe(`/authorize${OAUTH_SEARCH}`);
    expect(defaultLoginRedirect(OAUTH_SEARCH, '/login')).toBe(`/login${OAUTH_SEARCH}`);
  });

  test('direct visits keep the old / fallback; explicit redirect wins; evil values rejected', () => {
    expect(defaultLoginRedirect('', '/login')).toBe('/');
    expect(defaultLoginRedirect('', '/')).toBe('/');
    expect(defaultLoginRedirect('?redirect=/gallery', '/login')).toBe('/gallery');
    expect(safeRedirectTarget('https://evil.com/', '/')).toBe('/');
    expect(safeRedirectTarget('//evil.com', '/')).toBe('/');
    expect(safeRedirectTarget('/\\evil.com', '/')).toBe('/');
    expect(safeRedirectTarget('/gallery', '/')).toBe('/gallery');
  });

  test('served script defaults redirect to the authorize URL, not /', () => {
    const html = loginPage();
    expect(html).toContain("params.get('client_id')");
    expect(html).toContain('location.pathname + location.search');
    expect(html).not.toContain("params.get('redirect') || '/'");
    // redirectTo must embed the preserved target, not a hardcoded '/'.
    expect(html).toContain("'/login?redirect=' + encodeURIComponent(redirect)");
  });

  test('served script completes via the server endpoint instead of self-reloading', () => {
    const html = loginPage();
    expect(html).toContain('/api/oauth/authorize/complete');
    expect(html).toContain('redirect === selfUrl');
    expect(html).not.toContain('if (user) { location.href = redirect; }');
  });
});
