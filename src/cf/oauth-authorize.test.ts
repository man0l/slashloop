// SLA-118: POST /api/oauth/authorize/complete mints the provider grant
// after the Supabase login round-trip and returns the client's redirect_uri.
import { describe, expect, test } from 'bun:test';
import { completeAuthorizeRequest, oauthErrorRedirect } from './oauth-authorize.js';

const QUERY =
  '?client_id=test&redirect_uri=https%3A%2F%2Fexample.com%2Fcb&response_type=code' +
  '&state=xyz&code_challenge=abc&code_challenge_method=S256';

const PARSED = {
  responseType: 'code',
  clientId: 'test',
  redirectUri: 'https://example.com/cb',
  scope: ['test'],
  state: 'xyz',
  codeChallenge: 'abc',
  codeChallengeMethod: 'S256',
};

function fakeVerify(claims: { sub: string; email?: string; client_id?: string } | Error) {
  return async (_token: string) => {
    if (claims instanceof Error) throw claims;
    return claims;
  };
}

function fakeProvider(overrides: Record<string, unknown> = {}) {
  const calls: { completeOptions?: Record<string, unknown>; parseUrl?: string } = {};
  return {
    calls,
    provider: {
      parseAuthRequest: async (req: Request) => {
        calls.parseUrl = req.url;
        if (overrides.parseError) throw overrides.parseError;
        return PARSED;
      },
      completeAuthorization: async (opts: {
        request: unknown;
        userId: string;
        metadata: unknown;
        scope: string[];
        props: unknown;
      }) => {
        calls.completeOptions = opts as unknown as Record<string, unknown>;
        return { redirectTo: 'https://example.com/cb?code=authcode&state=xyz' };
      },
    },
  };
}

const BASE = {
  query: QUERY,
  requestUrl: 'https://mcp.slashloop.dev/api/oauth/authorize/complete',
};

describe('POST /api/oauth/authorize/complete (SLA-118)', () => {
  test('401 when the access token is missing', async () => {
    const { provider } = fakeProvider();
    const res = await completeAuthorizeRequest({
      ...BASE,
      token: null,
      verify: fakeVerify({ sub: 'u1' }),
      provider,
    });
    expect(res.status).toBe(401);
  });

  test('401 when the access token is invalid', async () => {
    const { provider } = fakeProvider();
    const res = await completeAuthorizeRequest({
      ...BASE,
      token: 'garbage',
      verify: fakeVerify(new Error('bad')),
      provider,
    });
    expect(res.status).toBe(401);
  });

  test('400 when the authorize query is missing', async () => {
    const { provider } = fakeProvider();
    const res = await completeAuthorizeRequest({
      ...BASE,
      query: '',
      token: 'tok',
      verify: fakeVerify({ sub: 'u1' }),
      provider,
    });
    expect(res.status).toBe(400);
  });

  test('success returns the client redirect_uri target with JWT identity', async () => {
    const { provider, calls } = fakeProvider();
    const res = await completeAuthorizeRequest({
      ...BASE,
      token: 'tok',
      verify: fakeVerify({ sub: 'user-123', email: 'a@b.c' }),
      provider,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectTo: string };
    expect(body.redirectTo).toBe('https://example.com/cb?code=authcode&state=xyz');
    // Provider re-validates the re-anchored /authorize request.
    expect(calls.parseUrl).toBe(`https://mcp.slashloop.dev/authorize${QUERY}`);
    // Identity comes from the verified JWT.
    const opts = calls.completeOptions as { userId: string; props: Record<string, unknown> };
    expect(opts.userId).toBe('user-123');
    expect(opts.props).toMatchObject({ sub: 'user-123', email: 'a@b.c' });
  });

  test('a caller cannot authorize as someone else via the query', async () => {
    const { provider, calls } = fakeProvider();
    await completeAuthorizeRequest({
      ...BASE,
      query: `${QUERY}&sub=victim`,
      token: 'tok',
      verify: fakeVerify({ sub: 'attacker' }),
      provider,
    });
    const opts = calls.completeOptions as { userId: string; props: Record<string, unknown> };
    expect(opts.userId).toBe('attacker');
    expect(opts.props).toMatchObject({ sub: 'attacker' });
  });

  test('provider validation error with a registered redirect returns the error redirect', async () => {
    const parseError = Object.assign(new Error('denied'), {
      code: 'access_denied',
      description: 'Denied.',
      redirectUri: 'https://example.com/cb',
      state: 'xyz',
    });
    const { provider } = fakeProvider({ parseError });
    const res = await completeAuthorizeRequest({
      ...BASE,
      token: 'tok',
      verify: fakeVerify({ sub: 'u1' }),
      provider,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { redirectTo: string; error: string };
    expect(body.error).toBe('access_denied');
    expect(body.redirectTo).toContain('https://example.com/cb');
    expect(body.redirectTo).toContain('error=access_denied');
    expect(body.redirectTo).toContain('state=xyz');
  });

  test('provider validation error without a redirect renders locally, never redirects', async () => {
    const parseError = Object.assign(new Error('unknown client'), {
      code: 'invalid_request',
      description: 'Unknown client.',
    });
    const { provider } = fakeProvider({ parseError });
    const res = await completeAuthorizeRequest({
      ...BASE,
      token: 'tok',
      verify: fakeVerify({ sub: 'u1' }),
      provider,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as Record<string, string>;
    expect(body.redirectTo ?? '').toBe('');
    expect(oauthErrorRedirect(parseError)).toBeNull();
  });
});
