// POST /api/social/upload — multipart file upload for scheduler media.
//
// Auth: Supabase access token. Stores the file in the THUMBS bucket under
// social/<timestamp>-<rand>.<ext> and returns its STABLE PUBLIC URL — that
// URL is what TikTok photo posts (PULL_FROM_URL) and Instagram containers
// (image_url/video_url) fetch later, and what the engine's ranged GETs read
// for byte uploads. Public-unlisted is the same trust model as every other
// object under /thumbs.
//
// Type/size limits and the write live in src/social/media-upload.ts.

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { UploadError, storeSocialMedia } from '../src/social/media-upload.js';

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

export async function POST(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  // Workers runtime hands back the web FormData; the type libs disagree on
  // which FormData declaration wins, so narrow manually.
  let form: { get(name: string): unknown };
  try {
    form = (await request.formData()) as unknown as { get(name: string): unknown };
  } catch {
    return json(400, { error: 'invalid_form' }, request);
  }
  const file = form.get('file') as File | null;
  if (!(file instanceof File)) return json(400, { error: 'missing_file' }, request);

  try {
    const stored = await storeSocialMedia(new Uint8Array(await file.arrayBuffer()), file.type || '');
    return json(201, stored, request);
  } catch (err) {
    if (!(err instanceof UploadError)) throw err;
    if (err.code === 'unsupported_type') return json(415, { error: err.code, ...err.detail }, request);
    if (err.code === 'too_large') return json(413, { error: err.code, ...err.detail }, request);
    return json(500, { error: 'storage_failed' }, request);
  }
}
