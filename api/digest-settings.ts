// GET/POST /api/digest-settings — the site's email-settings page.
//
// GET  returns every workspace the caller owns with its digest fields.
// POST updates digestEnabled and/or digestEmail on one or all of them.
//      digestEmail null clears the override (deliver to the auth email).
//
// Auth: Supabase access token exactly like api/billing.ts — ownership is
// enforced by ownerId = JWT sub, never by trusting a workspaceId alone.

import { verifySupabaseJwt } from '../remote/auth.js';
import { db } from '../src/db.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });
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

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

const SELECT = { id: true, name: true, digestEnabled: true, digestEmail: true, lastDigestAt: true } as const;

async function listFor(sub: string) {
  return db.workspace.findMany({
    where: { ownerId: sub },
    orderBy: { createdAt: 'asc' },
    select: SELECT,
  });
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function GET(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' });
  return json(200, { workspaces: await listFor(claims.sub) });
}

export async function POST(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' });

  let body: { workspaceId?: string; digestEnabled?: boolean; digestEmail?: string | null };
  try {
    // request.json() is unknown under some type libs (bun vs Vercel/Node) —
    // the validation below narrows every field before use.
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  if (body.digestEnabled !== undefined && typeof body.digestEnabled !== 'boolean') {
    return json(400, { error: 'digestEnabled must be boolean' });
  }
  if (body.digestEmail !== undefined && body.digestEmail !== null
      && !(typeof body.digestEmail === 'string' && EMAIL_RE.test(body.digestEmail.trim()))) {
    return json(400, { error: 'digestEmail must be null or a valid address' });
  }

  const data: { digestEnabled?: boolean; digestEmail?: string | null } = {};
  if (body.digestEnabled !== undefined) data.digestEnabled = body.digestEnabled;
  if (body.digestEmail !== undefined) data.digestEmail = body.digestEmail === null ? null : body.digestEmail.trim();
  if (Object.keys(data).length === 0) return json(400, { error: 'nothing to update' });

  // Ownership comes from the token; workspaceId only narrows the target set,
  // so a forged id can touch nothing.
  await db.workspace.updateMany({
    where: { ownerId: claims.sub, ...(body.workspaceId ? { id: body.workspaceId } : {}) },
    data,
  });

  return json(200, { workspaces: await listFor(claims.sub) });
}
