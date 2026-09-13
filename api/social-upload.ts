// POST /api/social/upload — multipart file upload for scheduler media.
//
// Auth: Supabase access token. Stores the file in the THUMBS bucket under
// social/<timestamp>-<rand>.<ext> and returns its STABLE PUBLIC URL — that
// URL is what TikTok photo posts (PULL_FROM_URL) and Instagram containers
// (image_url/video_url) fetch later, and what the engine's ranged GETs read
// for byte uploads. Public-unlisted is the same trust model as every other
// object under /thumbs.
//
// Limits: images 20MB, videos 95MB (Workers request-body cap on the Free
// plan is 100MB — keep headroom for the multipart wrapper).

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { publicUrl, putObject, thumbBucket } from '../src/lib/storage.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_VIDEO_BYTES = 95 * 1024 * 1024;

const IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const VIDEO_TYPES: Record<string, string> = {
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

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

  const contentType = file.type || '';
  const ext = IMAGE_TYPES[contentType] ?? VIDEO_TYPES[contentType];
  if (!ext) return json(415, { error: 'unsupported_type', type: contentType }, request);
  const isVideo = ext === '.mp4' || ext === '.mov';
  const maxBytes = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size <= 0 || file.size > maxBytes) {
    return json(413, { error: 'too_large', maxBytes, sizeBytes: file.size }, request);
  }

  const key = `social/${Date.now()}-${crypto.randomUUID().slice(0, 8)}${ext}`;
  const body = new Uint8Array(await file.arrayBuffer());

  try {
    await putObject({ bucket: thumbBucket(), path: key, body, contentType });
  } catch (err) {
    console.error(`[social/upload] putObject failed: ${(err as Error).message}`);
    return json(500, { error: 'storage_failed' }, request);
  }

  const url = publicUrl(thumbBucket(), key);
  return json(201, { url, type: isVideo ? 'video' : 'image', key, sizeBytes: body.byteLength }, request);
}
