// GET /api/social/callback/:provider — browser redirect target of every
// platform's OAuth consent screen. No Authorization header exists here; the
// HMAC-signed `state` parameter carries the user identity (stateless — no
// session store). Exchanges the code, upserts the integration, then bounces
// to the site calendar with a ?connect= status the page can surface.
//
// The router injects the provider id as ?callback= (regex capture), so this
// module's only handler is GET.

import { socialConfigFromEnv, stateSecret, workerOrigin } from './social.js';
import { connectFailureReason, createRegistry, getProvider, socialStore, verifyOAuthState, type ProviderId } from '../src/social/index.js';

const PROVIDERS: ProviderId[] = ['tiktok', 'youtube', 'instagram', 'threads', 'pinterest'];

function siteOrigin(): string {
  return (process.env.SOCIAL_SITE_URL ?? 'https://slashloop.dev').replace(/\/$/, '');
}

// `reason` is always one of connectFailureReason's fixed codes — never platform
// text — so the site can't be made to render arbitrary copy from the URL.
// `account` is the platform handle reduced to handle-safe characters, and
// `existing` says the handle was already linked (the consent re-authorized
// an account instead of adding one) — Instagram Login only ever grants the
// account that is signed in on instagram.com, so a user with several
// accounts under one email can otherwise re-link the first one and think
// the second was added.
function bounce(
  status: string,
  provider?: string,
  reason?: string,
  account?: { handle: string; existing: boolean },
): Response {
  const params = new URLSearchParams({ connect: status });
  if (provider) params.set('provider', provider);
  if (reason) params.set('reason', reason);
  if (account) {
    const handle = safeHandle(account.handle);
    if (handle) params.set('account', handle);
    if (account.existing) params.set('existing', '1');
  }
  return Response.redirect(`${siteOrigin()}/calendar?${params.toString()}`, 302);
}

/** Platform handles are [A-Za-z0-9._-]; anything else is dropped so the
 *  redirect never carries platform-controlled free text. */
export function safeHandle(raw: string): string {
  return raw.replace(/^@/, '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64);
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const provider = url.searchParams.get('callback') as ProviderId | null;
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (provider && PROVIDERS.includes(provider) && !code && url.searchParams.get('error')) {
    return bounce('error', provider, 'denied'); // user cancelled the consent screen
  }
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
    const existing = await socialStore.findIntegrationByInternalId(payload.sub, provider, auth.internalId);
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
    return bounce('ok', provider, undefined, { handle: auth.profile, existing: Boolean(existing) });
  } catch (err) {
    const detail = (err as { detail?: string }).detail;
    console.error(`[social] ${provider} connect failed: ${(err as Error).message}${detail ? ` | ${detail}` : ''}`);
    return bounce('error', provider, connectFailureReason(err));
  }
}
