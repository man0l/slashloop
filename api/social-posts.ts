// /api/social/posts — scheduled submissions.
//
//   GET    /api/social/posts?from=&to=   → groups in the epoch range (calendar feed)
//   POST   /api/social/posts             → create a submission: one row per platform
//   PATCH  /api/social/posts?id=<group>  → reschedule a group (409 while PROCESSING)
//   DELETE /api/social/posts?id=<group>  → delete a group (PROCESSING rows survive)
//
// Auth: Supabase access token; teams share visibility both ways — every query
// spans the owner_ids visible to the caller (own rows plus teammates' rows
// across workspace shares, see visibleOwnerIds), so a leaked group id can
// only ever touch rows inside the caller's team.

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { socialStore, visibleOwnerIds, type MediaContent } from '../src/social/index.js';
import { applyToOwners, createPost, deleteVisible, listCalendar, type CreatePostInput } from '../src/social/posting.js';

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

// ── calendar feed ───────────────────────────────────────────────────────────

export async function GET(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const url = new URL(request.url);
  const from = Number(url.searchParams.get('from'));
  const to = Number(url.searchParams.get('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return json(400, { error: 'invalid_range' }, request);
  }

  const owners = await visibleOwnerIds(claims.sub, claims.email);
  return json(200, await listCalendar(owners, from, to), request);
}

// ── create ──────────────────────────────────────────────────────────────────

export async function POST(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  let body: CreatePostInput;
  try {
    body = (await request.json()) as CreatePostInput;
  } catch {
    return json(400, { error: 'invalid_json' }, request);
  }

  const result = await createPost(claims.sub, () => visibleOwnerIds(claims.sub, claims.email), body);
  if (!result.ok) {
    return json(result.status, result.skipped ? { error: result.error, skipped: result.skipped } : { error: result.error }, request);
  }
  const { ok: _ok, ...payload } = result;
  return json(201, payload, request);
}

// ── reschedule / delete ─────────────────────────────────────────────────────

export async function PATCH(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json(400, { error: 'missing_id' }, request);

  let body: {
    publishDate?: number;
    /** 'QUEUE' schedules a DRAFT group; absent = plain reschedule. */
    state?: string;
    /** Update caption + media (drafts and queued groups only). */
    content?: string;
    media?: Array<{ type?: string; url?: string; alt?: string; thumbnail?: string }>;
    /** Mark (or unmark) the group's media for the metadata scrub. */
    stripMetadata?: boolean;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return json(400, { error: 'invalid_json' }, request);
  }

  const processingGuard = (result: { processing: number }, payload: Record<string, unknown>) =>
    result.processing > 0
      ? json(409, { error: 'processing', message: 'A post in this group is publishing right now — try again in a moment.' }, request)
      : json(200, payload, request);

  // Group mutations span every visible owner: group ids are UUIDs so at most
  // one owner matches; counts sum, and any PROCESSING hit wins as a 409.
  const owners = await visibleOwnerIds(claims.sub, claims.email);
  const applyToVisible = <K extends string>(key: K, fn: (ownerId: string) => Promise<{ processing: number } & Record<K, number>>) =>
    applyToOwners(owners, key, fn);

  // Caption + media update (drafts/queued only — the guard rejects PROCESSING).
  const hasContent = typeof body.content === 'string';
  const hasMedia = Array.isArray(body.media);
  if (hasContent || hasMedia) {
    const media: MediaContent[] = hasMedia
      ? body.media!.filter((m) => m?.url && typeof m.url === 'string' && /^https?:\/\//i.test(m.url)).map((m) => ({
          type: m.type === 'video' ? ('video' as const) : ('image' as const),
          url: m.url!,
          ...(m.alt ? { alt: m.alt } : {}),
          ...(m.thumbnail ? { thumbnail: m.thumbnail } : {}),
        }))
      : [];
    const { processing, count } = await applyToVisible('updated', (ownerId) =>
      socialStore.updateGroupContent(ownerId, id, hasContent ? body.content!.trim() : '', media),
    );
    return processingGuard({ processing }, { updated: count });
  }

  // Schedule a draft (DRAFT → QUEUE — or SCRUB when the media still carries
  // scrub marks) with a date.
  if (body.state === 'QUEUE') {
    const publishDate = Math.floor(Number(body.publishDate));
    if (!Number.isFinite(publishDate)) return json(400, { error: 'invalid_publish_date' }, request);
    const { processing, count } = await applyToVisible('scheduled', (ownerId) =>
      socialStore.scheduleGroup(ownerId, id, publishDate, body.stripMetadata ? 'SCRUB' : 'QUEUE'),
    );
    return processingGuard({ processing }, { scheduled: count, publishDate });
  }

  // Plain reschedule.
  const publishDate = Math.floor(Number(body.publishDate));
  if (!Number.isFinite(publishDate)) return json(400, { error: 'invalid_publish_date' }, request);
  const { processing, count } = await applyToVisible('rescheduled', (ownerId) => socialStore.rescheduleGroup(ownerId, id, publishDate));
  return processingGuard({ processing }, { rescheduled: count });
}

export async function DELETE(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json(400, { error: 'missing_id' }, request);

  const owners = await visibleOwnerIds(claims.sub, claims.email);
  const { deleted, processing } = await deleteVisible(owners, id);
  if (processing > 0) {
    return json(409, { error: 'processing', message: 'A post in this group is publishing right now and cannot be removed.', deleted }, request);
  }
  return json(200, { deleted }, request);
}
