// Signed playback URLs for the PRIVATE media bucket, served by the Worker.
//
// On Workers, private media is reached through the R2 binding (no S3 keys, so
// no presigned S3 URLs). Instead signUrl() in storage.ts mints a JWT that
// authorises exactly one object path for a limited time — the same pattern as
// src/lib/gallery-link.ts — and GET /media/{path} (src/cf/media-routes.ts)
// verifies it and streams the object, Range requests included so <video>
// seeking works.
//
// Audience-pinned so a media token can never be replayed against /gallery,
// and gallery tokens can never fetch media.

import { SignJWT, jwtVerify } from 'jose';

const AUDIENCE = 'slashloop:media';
const ISSUER = 'slashloop';

function secret(): Uint8Array | null {
  // Same server-only fallback chain as gallery-link.ts.
  const raw =
    process.env.MEDIA_SIGNING_SECRET
    || process.env.GALLERY_LINK_SECRET
    || process.env.SUPABASE_SECRET_KEY
    || process.env.CRON_SECRET;
  if (!raw) return null;
  return new TextEncoder().encode(raw);
}

/** Mint a short-lived URL to one private media object, or null when unsigned. */
export async function signMediaUrl(path: string, ttlSeconds: number, origin: string | null): Promise<string | null> {
  const key = secret();
  if (!key || !origin) return null;
  const token = await new SignJWT({ scope: 'media' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(path)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${Math.max(60, Math.floor(ttlSeconds))}s`)
    .sign(key);
  return `${origin}/media/${path}?t=${token}`;
}

/** Verify a media token → the object path it authorises, or null. */
export async function verifyMediaToken(token: string | null): Promise<string | null> {
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
