// GET /api/social/callback/:provider — browser redirect target of every
// platform's OAuth consent screen. No Authorization header exists here; the
// HMAC-signed `state` parameter carries the user identity (stateless — no
// session store). Exchanges the code, upserts the integration, then bounces
// to the site calendar with a ?connect= status the page can surface.
//
// The router injects the provider id as ?callback= (regex capture), so this
// module's only handler is GET.

import { socialConfigFromEnv, stateSecret, workerOrigin } from './social.js';
import { createRegistry, getProvider, socialStore, verifyOAuthState, type ProviderId } from '../src/social/index.js';

const PROVIDERS: ProviderId[] = ['tiktok', 'youtube', 'instagram', 'threads'];

function siteOrigin(): string {
  return (process.env.SOCIAL_SITE_URL ?? 'https://slashloop.dev').replace(/\/$/, '');
}

function bounce(status: string, provider?: string): Response {
  const params = new URLSearchParams({ connect: status });
  if (provider) params.set('provider', provider);
  return Response.redirect(`${siteOrigin()}/calendar?${params.toString()}`, 302);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const provider = url.searchParams.get('callback') as ProviderId | null;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!provider || !PROVIDERS.includes(provider) || !code || !state) {
    return bounce('error');
  }

  const payload = await verifyOAuthState(stateSecret(), state);
  if (!payload) {
    return bounce('expired');
  }

  const cfg = socialConfigFromEnv();
  const registry = createRegistry(cfg);
  const redirectUri = `${workerOrigin(request)}/api/social/callback/${provider}`;

  try {
    const auth = await getProvider(registry, provider).authenticate(cfg, code, redirectUri, state);
    await socialStore.upsertIntegration({
      id: crypto.randomUUID(),
      ownerId: payload.sub,
      provider,
      internalId: auth.internalId,
      profile: auth.profile,
      name: auth.name,
      picture: auth.picture,
      token: auth.accessToken,
      refreshToken: auth.refreshToken,
      expiresAt: auth.expiresIn ? Math.floor(Date.now() / 1000) + auth.expiresIn : undefined,
    });
    return bounce('ok', provider);
  } catch (err) {
    console.error(`[social] ${provider} connect failed: ${(err as Error).message}`);
    return bounce('error', provider);
  }
}
