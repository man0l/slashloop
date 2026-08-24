// ---------------------------------------------------------------------------
// Signed, short-lived links to the standalone gallery page (/gallery).
//
// Why this exists: `show_gallery` is an MCP App (SEP-1865). It renders only in
// hosts that declare the `io.modelcontextprotocol/ui` client extension at
// initialize and then fetch the `ui://` resource. Claude Cowork — and any
// Claude Code / Agent SDK host — does not: tool results arrive at the model as
// plain text and `_meta.ui.resourceUri` is dropped without an error. That is
// the answer to docs/media-storage-plan.md §4.3 for those hosts.
//
// So the same HTML gets a second delivery route: a normal web page. The tool
// call already carries a verified Supabase JWT, but a browser tab does not, and
// we will not put a full-scope access token in a URL. Instead we mint a narrow,
// short-lived token that says exactly one thing — "render the gallery for this
// user id" — signed with a server-only secret and audience-pinned so it cannot
// be replayed against /mcp.
//
// Degrades to null when no secret is configured: show_gallery then behaves
// exactly as it does today, minus the link. No route becomes publicly readable
// as a result of a missing env var.
// ---------------------------------------------------------------------------

import { SignJWT, jwtVerify } from 'jose';

/** Pinned so a gallery token can never be replayed as an MCP access token. */
const AUDIENCE = 'slashloop:gallery';
const ISSUER = 'slashloop';
const DEFAULT_TTL_SECONDS = 60 * 60 * 24; // 24h

/**
 * Server-only signing key.
 *
 * `GALLERY_LINK_SECRET` is the dedicated knob. It falls back to secrets that
 * are already server-only and already required for a deployment that has
 * anything to show — never to SUPABASE_ANON_KEY, which ships to browsers.
 */
function secret(): Uint8Array | null {
  const raw =
    process.env.GALLERY_LINK_SECRET
    || process.env.SUPABASE_SECRET_KEY
    || process.env.CRON_SECRET;
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

export function isGalleryLinkEnabled(): boolean {
  return secret() !== null;
}

function ttlSeconds(): number {
  const n = Number(process.env.GALLERY_LINK_TTL_SECONDS);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_SECONDS;
}

/** Resolve this deployment's public origin for link building. */
export function publicOrigin(fallback?: string): string | null {
  const raw = process.env.PUBLIC_URL || fallback;
  if (!raw) return null;
  return raw.replace(/\/$/, '');
}

export interface GalleryLinkOptions {
  sourceId?: string;
  minOutlier?: number;
  minViews?: number;
  /** Friendly backend key for the "Analyzed by" toolbar, e.g. 'openrouter'. */
  analyzedBy?: 'openrouter';
  /** Pre-check the HTML toolbar's "Has hook test" checkbox. */
  hasHookTest?: boolean;
  density?: 'large' | 'medium' | 'small' | 'list';
  /** Origin to build against when PUBLIC_URL is unset (e.g. the request host). */
  origin?: string;
}

/**
 * Mint an absolute, signed URL to the standalone gallery.
 *
 * Returns null — never throws — when the deployment has no signing secret or
 * no resolvable public origin. Callers treat the link as an enhancement.
 *
 * `userId` is the Supabase JWT `sub`. Local stdio sessions have none; those get
 * no link, which is correct: there is no deployment to link to.
 */
export async function signGalleryUrl(
  userId: string | null,
  opts: GalleryLinkOptions = {},
): Promise<string | null> {
  const key = secret();
  const origin = publicOrigin(opts.origin);
  if (!key || !origin || !userId) return null;

  const token = await new SignJWT({ scope: 'gallery' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ttlSeconds()}s`)
    .sign(key);

  // Filters ride as plain query params. They are not security-relevant: the
  // workspace is resolved from the signed `sub`, so the worst a tampered param
  // can do is change which of the user's own videos they see.
  const qs = new URLSearchParams({ t: token });
  if (opts.sourceId) qs.set('sourceId', opts.sourceId);
  if (opts.minOutlier && opts.minOutlier > 0) qs.set('minOutlier', String(opts.minOutlier));
  if (opts.minViews && opts.minViews > 0) qs.set('minViews', String(opts.minViews));
  if (opts.analyzedBy) qs.set('analyzedBy', opts.analyzedBy);
  if (opts.hasHookTest) qs.set('hasHookTest', '1');
  if (opts.density) qs.set('density', opts.density);

  return `${origin}/gallery?${qs.toString()}`;
}

/** Verify a gallery token and return the user id it authorises, or null. */
export async function verifyGalleryToken(token: string | null): Promise<string | null> {
  const key = secret();
  if (!key || !token) return null;
  try {
    const { payload } = await jwtVerify(token, key, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    });
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    return null;
  }
}

/** How long a freshly minted link stays valid, for user-facing copy. */
export function ttlHumanized(): string {
  const s = ttlSeconds();
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s >= 60) return `${Math.round(s / 60)}m`;
  return `${Math.round(s)}s`;
}
