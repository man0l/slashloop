// /api/social/posts — scheduled submissions.
//
//   GET    /api/social/posts?from=&to=   → groups in the epoch range (calendar feed)
//   POST   /api/social/posts             → create a submission: one row per platform
//   PATCH  /api/social/posts?id=<group>  → reschedule a group (409 while PROCESSING)
//   DELETE /api/social/posts?id=<group>  → delete a group (PROCESSING rows survive)
//
// Auth: Supabase access token; every query filters owner_id = JWT sub, so a
// leaked group id can only ever touch the caller's own posts.

import { verifySupabaseJwt } from '../remote/auth.js';
import { corsHeaders, corsPreflight } from '../src/lib/cors.js';
import { BadBodyError, createRegistry, getProvider, socialStore, type MediaContent, type ProviderId, type SocialPostRow } from '../src/social/index.js';

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

  const rows = await socialStore.listPostsInRange(claims.sub, from, to);
  const drafts = await socialStore.listDrafts(claims.sub);
  return json(200, { groups: groupRows(rows), drafts: groupRows(drafts) }, request);
}

export interface CalendarGroup {
  groupId: string;
  publishDate: number;
  content: string;
  media: MediaContent[];
  /** Aggregate state for chip coloring: any PROCESSING wins, then ERROR,
   *  then queued-until, then fully PUBLISHED; DRAFT groups report 'draft'. */
  state: 'queued' | 'processing' | 'published' | 'error' | 'draft' | 'scrubbing';
  posts: Array<{
    id: string;
    provider: ProviderId;
    state: string;
    releaseUrl: string | null;
    error: string | null;
    needsReconnect?: boolean;
  }>;
}

function groupRows(rows: SocialPostRow[]): CalendarGroup[] {
  const byGroup = new Map<string, CalendarGroup>();
  for (const row of rows) {
    const groupId = row.group_id;
    let group = byGroup.get(groupId);
    if (!group) {
      group = {
        groupId,
        publishDate: row.publish_date,
        content: row.content ?? '',
        media: safeMedia(row.media),
        state: 'queued',
        posts: [],
      };
      byGroup.set(groupId, group);
    }
    group.posts.push({
      id: row.id,
      provider: row.provider as ProviderId,
      state: row.state,
      releaseUrl: row.release_url ?? null,
      error: row.error ?? null,
    });
  }

  for (const group of byGroup.values()) {
    if (group.posts.every((p) => p.state === 'DRAFT')) group.state = 'draft';
    else if (group.posts.every((p) => p.state === 'SCRUB')) group.state = 'scrubbing';
    else if (group.posts.some((p) => p.state === 'PROCESSING')) group.state = 'processing';
    else if (group.posts.some((p) => p.state === 'ERROR')) group.state = 'error';
    else if (group.posts.every((p) => p.state === 'PUBLISHED')) group.state = 'published';
  }
  return [...byGroup.values()];
}

function safeMedia(raw: unknown): MediaContent[] {
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as MediaContent[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// ── create ──────────────────────────────────────────────────────────────────

interface CreateBody {
  integrationIds?: string[];
  content?: string;
  media?: Array<{ type?: string; url?: string; alt?: string; thumbnail?: string }>;
  /** Epoch seconds. Optional when draft: true (undated drafts carry 0). */
  publishDate?: number;
  /** Save as a draft instead of scheduling. */
  draft?: boolean;
  /** Re-capture every media item (fresh bytes, no source fingerprint):
   *  images re-encoded now-ish by the engine, videos through Stream. */
  stripMetadata?: boolean;
  settings?: Record<string, Record<string, unknown>>;
}

export async function POST(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return json(400, { error: 'invalid_json' }, request);
  }

  const integrationIds = (body.integrationIds ?? []).filter((id) => typeof id === 'string' && id);
  if (!integrationIds.length) return json(400, { error: 'no_integrations' }, request);
  if (typeof body.content !== 'string' || !body.content.trim()) return json(400, { error: 'missing_content' }, request);
  const asDraft = Boolean(body.draft);
  const publishDate = asDraft && !Number.isFinite(Number(body.publishDate)) ? 0 : Math.floor(Number(body.publishDate));
  if (!Number.isFinite(publishDate)) return json(400, { error: 'invalid_publish_date' }, request);

  const stripMetadata = Boolean(body.stripMetadata);
  const media: MediaContent[] = [];
  for (const item of body.media ?? []) {
    if (!item?.url || typeof item.url !== 'string') continue;
    if (!/^https?:\/\//i.test(item.url)) return json(400, { error: 'media_urls_must_be_absolute' }, request);
    media.push({
      type: item.type === 'video' ? 'video' : 'image',
      url: item.url,
      ...(item.alt ? { alt: item.alt } : {}),
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
      // Recreated decks are already fresh — a scrub mark would waste a pass.
      ...(stripMetadata ? { scrub: true } : {}),
    });
  }

  const integrations = await socialStore.listIntegrations(claims.sub);
  const selected = integrations.filter((i) => integrationIds.includes(i.id));
  if (!selected.length) return json(400, { error: 'no_valid_integrations' }, request);

  // Per-provider validation. Invalid platforms are SKIPPED with their reason
  // (the gallery pushes one deck to many platforms and TikTok's 35-photo
  // rules differ from Instagram's 10) — the post still schedules for the
  // platforms that accept it. 422 only when nothing is schedulable.
  const registry = createRegistry({});
  const settingsByIntegration = body.settings ?? {};
  const valid: typeof selected = [];
  const skipped: Array<{ provider: string; message: string }> = [];
  for (const integration of selected) {
    const settings = settingsByIntegration[integration.id] ?? {};
    const validity = getProvider(registry, integration.provider).checkValidity({ message: body.content, settings, media });
    if (validity === true) valid.push(integration);
    else skipped.push({ provider: integration.provider, message: validity });
  }
  if (!valid.length) {
    return json(422, { error: 'invalid_for_provider', skipped }, request);
  }

  const groupId = crypto.randomUUID();
  await socialStore.createPostGroup(
    valid.map((integration) => ({
      id: crypto.randomUUID(),
      groupId,
      ownerId: claims.sub,
      integration,
      publishDate,
      content: body.content!.trim(),
      settings: settingsByIntegration[integration.id] ?? {},
      media,
      state: asDraft ? ('DRAFT' as const) : media.some((m) => m.scrub) ? ('SCRUB' as const) : ('QUEUE' as const),
    })),
  );

  return json(201, { groupId, posts: valid.length, publishDate, draft: asDraft, skipped }, request);
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
    const result = await socialStore.updateGroupContent(claims.sub, id, hasContent ? body.content!.trim() : '', media);
    return processingGuard(result, { updated: result.updated });
  }

  // Schedule a draft (DRAFT → QUEUE — or SCRUB when the media still carries
  // scrub marks) with a date.
  if (body.state === 'QUEUE') {
    const publishDate = Math.floor(Number(body.publishDate));
    if (!Number.isFinite(publishDate)) return json(400, { error: 'invalid_publish_date' }, request);
    const result = await socialStore.scheduleGroup(claims.sub, id, publishDate, body.stripMetadata ? 'SCRUB' : 'QUEUE');
    return processingGuard(result, { scheduled: result.scheduled, publishDate });
  }

  // Plain reschedule.
  const publishDate = Math.floor(Number(body.publishDate));
  if (!Number.isFinite(publishDate)) return json(400, { error: 'invalid_publish_date' }, request);
  const result = await socialStore.rescheduleGroup(claims.sub, id, publishDate);
  return processingGuard(result, { rescheduled: result.rescheduled });
}

export async function DELETE(request: Request): Promise<Response> {
  const claims = await authenticate(request);
  if (!claims) return json(401, { error: 'invalid_token' }, request);

  const id = new URL(request.url).searchParams.get('id');
  if (!id) return json(400, { error: 'missing_id' }, request);

  const result = await socialStore.deleteGroup(claims.sub, id);
  if (result.processing > 0) {
    return json(409, { error: 'processing', message: 'A post in this group is publishing right now and cannot be removed.', deleted: result.deleted }, request);
  }
  return json(200, { deleted: result.deleted }, request);
}
