// /api/social — connected platform accounts + OAuth connect URL.
//
//   GET    /api/social/integrations      → list (tokens stripped)
//   POST   /api/social/integrations?connect=<provider>
//                                         → { url } to open the consent screen
//   DELETE /api/social/integrations?id=  → disconnect (+ delete its posts)
//
// All three are authed fetches from the site (Supabase token, ownership =
// JWT sub). The browser-facing OAuth callback is a separate module —
// api/social-callback.ts — because the platform's redirect is a plain GET
// and this router dispatches one HTTP method set per module.

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { signOAuthState, socialStore, getProvider, createRegistry, type SocialConfig, type ProviderId } from '../src/social/index.js';

const PROVIDERS: ProviderId[] = ['tiktok', 'youtube', 'instagram', 'threads'];

export function socialConfigFromEnv(): SocialConfig {
  return {
    // Stream drives the metadata scrub (video re-encode); absent = video
    // scrubbing fails with a setup message instead of silently skipping.
    scrub:
      process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_STREAM_TOKEN
        ? { accountId: process.env.CLOUDFLARE_ACCOUNT_ID, token: process.env.CLOUDFLARE_STREAM_TOKEN }
        : undefined,
    tiktok: process.env.SOCIAL_TIKTOK_CLIENT_ID
      ? { clientId: process.env.SOCIAL_TIKTOK_CLIENT_ID, clientSecret: process.env.SOCIAL_TIKTOK_CLIENT_SECRET ?? '' }
      : undefined,
    youtube: process.env.SOCIAL_GOOGLE_CLIENT_ID
      ? { clientId: process.env.SOCIAL_GOOGLE_CLIENT_ID, clientSecret: process.env.SOCIAL_GOOGLE_CLIENT_SECRET ?? '' }
      : undefined,
    instagram: process.env.SOCIAL_META_CLIENT_ID
      ? {
          clientId: process.env.SOCIAL_META_CLIENT_ID,
          clientSecret: process.env.SOCIAL_META_CLIENT_SECRET ?? '',
          graphVersion: process.env.SOCIAL_META_GRAPH_VERSION,
        }
      : undefined,
    threads: process.env.SOCIAL_THREADS_CLIENT_ID
      ? { clientId: process.env.SOCIAL_THREADS_CLIENT_ID, clientSecret: process.env.SOCIAL_THREADS_CLIENT_SECRET ?? '' }
      : undefined,
  };
}

export function workerOrigin(request: Request): string {
  return (process.env.PUBLIC_URL ?? new URL(request.url).origin).replace(/\/$/, '');
}

export function stateSecret(): string {
  return process.env.SOCIAL_OAUTH_SECRET ?? process.env.CRON_SECRET ?? '';
}

function json(status: number, body: unknown, request: Request): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}

async function authenticate(request: Request) {
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return null;
  try {
    return await verifySupabaseJwt(token);
  } catch {
    return null;
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

export async function GET(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const integrations = await socialStore.listIntegrations(claims.sub);
  // Which platforms have developer-app credentials on this deployment —
  // the site hides connect buttons for the rest instead of erroring on click.
  const cfg = socialConfigFromEnv();
  const configured = [cfg.tiktok && 'tiktok', cfg.youtube && 'youtube', cfg.instagram && 'instagram', cfg.threads && 'threads'].filter(Boolean);
  return json(200, { integrations: integrations.map(sanitizeIntegration), configured }, request);
}

export async function POST(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const provider = new URL(request.url).searchParams.get('connect');
  if (!provider || !PROVIDERS.includes(provider as ProviderId)) {
    return json(400, { error: 'unknown_provider' }, request);
  }

  const cfg = socialConfigFromEnv();
  const registry = createRegistry(cfg);
  let providerImpl;
  try {
    providerImpl = getProvider(registry, provider);
  } catch {
    return json(400, { error: 'provider_not_configured' }, request);
  }

  const state = await signOAuthState(stateSecret(), claims.sub);
  const redirectUri = `${workerOrigin(request)}/api/social/callback/${provider}`;
  const url = await providerImpl.generateAuthUrl(cfg, redirectUri, state);
  return json(200, { url }, request);
}

export async function DELETE(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json(400, { error: 'missing_id' }, request);

  await socialStore.deleteIntegration(id, claims.sub);
  return json(200, { ok: true }, request);
}

export function sanitizeIntegration(row: {
  id: string;
  provider: string;
  profile: string | null;
  name: string | null;
  picture: string | null;
  refresh_needed: number;
  disabled: number;
  error: string | null;
}) {
  return {
    id: row.id,
    provider: row.provider,
    profile: row.profile,
    name: row.name,
    picture: row.picture,
    needsReconnect: Boolean(row.refresh_needed),
    disabled: Boolean(row.disabled),
    error: row.error,
  };
}
