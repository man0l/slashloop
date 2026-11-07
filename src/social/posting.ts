// Scheduler post operations shared by the HTTP routes (api/social-posts.ts)
// and the MCP tools (src/tools/social.ts). Callers resolve the visible owner
// ids (visibleOwnerIds) and pass them in; everything here is store-level and
// free of auth, so both transports enforce the same validation and the same
// PROCESSING guards.

import { createRegistry, getProvider } from './registry.js';
import * as socialStore from './store.js';
import type { GroupWriteResult } from './store.js';
import { laneAndPrimary, parseStoredTags } from './rotation.js';
import { METRIC_KEYS } from './types.js';
import type { MediaContent, MetricKey, ProviderId, SocialIntegrationRow, SocialPostRow } from './types.js';

// ── calendar grouping ───────────────────────────────────────────────────────

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
    /** The connected account this row publishes to. */
    account: { id: string; name: string | null; profile: string | null; picture: string | null; lane: string | null };
    state: string;
    releaseUrl: string | null;
    error: string | null;
    needsReconnect?: boolean;
    /** Published posts only, once synced (src/social/metrics.ts). */
    metrics?: Record<MetricKey, number | null> & {
      syncedAt: number;
      /** YouTube Analytics retention; null until the channel is connected with yt-analytics.readonly. */
      engagedViews?: number | null;
      avgViewPercentage?: number | null;
      avgViewDurationSecs?: number | null;
      /** engagedViews / views as 0-1 — Studio's "stayed to watch". */
      stayedToWatch?: number | null;
      retentionCurve?: number[] | null;
    };
  }>;
}

export function groupRows(rows: SocialPostRow[]): CalendarGroup[] {
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
    } else {
      adoptThumbnails(group.media, safeMedia(row.media));
    }
    group.posts.push({
      id: row.id,
      provider: row.provider as ProviderId,
      account: {
        id: row.integration_id,
        name: row.account_name ?? null,
        profile: row.account_profile ?? null,
        picture: row.account_picture ?? null,
        lane: laneAndPrimary(parseStoredTags(row.account_tags)).lane,
      },
      state: row.state,
      releaseUrl: row.release_url ?? null,
      error: row.error ?? null,
      ...(row.metrics_synced_at
        ? {
            metrics: {
              ...(Object.fromEntries(METRIC_KEYS.map((k) => [k, row[k] ?? null])) as Record<MetricKey, number | null>),
              syncedAt: row.metrics_synced_at,
              ...(row.stayed_to_watch != null || row.engaged_views != null
                ? {
                    engagedViews: row.engaged_views ?? null,
                    avgViewPercentage: row.avg_view_pct ?? null,
                    avgViewDurationSecs: row.avg_view_secs ?? null,
                    stayedToWatch: row.stayed_to_watch ?? null,
                    retentionCurve: parseCurve(row.retention_curve),
                  }
                : {}),
            },
          }
        : {}),
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

/** The group shows one media list (the first row's); a thumbnail set on only
 *  one platform's row (a published YouTube cover) must still be echoed. */
function adoptThumbnails(shown: MediaContent[], other: MediaContent[]): void {
  shown.forEach((m, i) => {
    const o = other[i];
    if (!m.thumbnail && o?.thumbnail && o.url === m.url) m.thumbnail = o.thumbnail;
  });
}

function safeMedia(raw: unknown): MediaContent[] {
  try {
    const parsed = typeof raw === 'string' ? (JSON.parse(raw) as MediaContent[]) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function listCalendar(owners: string[], from: number, to: number): Promise<{ groups: CalendarGroup[]; drafts: CalendarGroup[] }> {
  const [rows, drafts] = await Promise.all([
    Promise.all(owners.map((ownerId) => socialStore.listPostsInRange(ownerId, from, to))),
    Promise.all(owners.map((ownerId) => socialStore.listDrafts(ownerId))),
  ]);
  return { groups: groupRows(rows.flat()), drafts: groupRows(drafts.flat()) };
}

// ── integrations ────────────────────────────────────────────────────────────

/** Connected accounts across the owners, de-duplicated. `healthyOnly` drops
 *  accounts that need a reconnect (what a new post may target). */
export async function visibleIntegrations(owners: string[], healthyOnly: boolean): Promise<SocialIntegrationRow[]> {
  const seen = new Set<string>();
  const lists = await Promise.all(
    owners.map((ownerId) => (healthyOnly ? socialStore.listIntegrations(ownerId) : socialStore.listAllIntegrationsForOwner(ownerId))),
  );
  return lists.flat().filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));
}

// ── create ──────────────────────────────────────────────────────────────────

export interface CreatePostInput {
  integrationIds?: string[];
  content?: string;
  media?: Array<{ type?: string; url?: string; alt?: string; thumbnail?: string }>;
  /** Epoch seconds. Optional when draft: true (undated drafts carry 0). */
  publishDate?: number;
  /** Save as a draft instead of scheduling. */
  draft?: boolean;
  /** Re-capture every media item (fresh bytes, no source fingerprint). */
  stripMetadata?: boolean;
  settings?: Record<string, Record<string, unknown>>;
}

export type CreatePostResult =
  | { ok: true; groupId: string; posts: number; publishDate: number; draft: boolean; skipped: Array<{ provider: string; message: string }> }
  | { ok: false; status: 400 | 422; error: string; skipped?: Array<{ provider: string; message: string }> };

/**
 * Validate and persist one submission (one row per platform). `resolveOwners`
 * is lazy so malformed bodies are rejected before any team lookup.
 * Invalid platforms are SKIPPED with their reason — the post still schedules
 * for the platforms that accept it; 422 only when nothing is schedulable.
 */
export async function createPost(
  ownerId: string,
  resolveOwners: () => Promise<string[]>,
  body: CreatePostInput,
): Promise<CreatePostResult> {
  const integrationIds = (body.integrationIds ?? []).filter((id) => typeof id === 'string' && id);
  if (!integrationIds.length) return { ok: false, status: 400, error: 'no_integrations' };
  if (typeof body.content !== 'string' || !body.content.trim()) return { ok: false, status: 400, error: 'missing_content' };
  const asDraft = Boolean(body.draft);
  const publishDate = asDraft && !Number.isFinite(Number(body.publishDate)) ? 0 : Math.floor(Number(body.publishDate));
  if (!Number.isFinite(publishDate)) return { ok: false, status: 400, error: 'invalid_publish_date' };

  const stripMetadata = Boolean(body.stripMetadata);
  const media: MediaContent[] = [];
  for (const item of body.media ?? []) {
    if (!item?.url || typeof item.url !== 'string') continue;
    if (!/^https?:\/\//i.test(item.url)) return { ok: false, status: 400, error: 'media_urls_must_be_absolute' };
    media.push({
      type: item.type === 'video' ? 'video' : 'image',
      url: item.url,
      ...(item.alt ? { alt: item.alt } : {}),
      ...(item.thumbnail ? { thumbnail: item.thumbnail } : {}),
      // Recreated decks are already fresh — a scrub mark would waste a pass.
      ...(stripMetadata ? { scrub: true } : {}),
    });
  }

  const integrations = await visibleIntegrations(await resolveOwners(), true);
  const selected = integrations.filter((i) => integrationIds.includes(i.id));
  if (!selected.length) return { ok: false, status: 400, error: 'no_valid_integrations' };

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
  if (!valid.length) return { ok: false, status: 422, error: 'invalid_for_provider', skipped };

  const groupId = crypto.randomUUID();
  await socialStore.createPostGroup(
    valid.map((integration) => ({
      id: crypto.randomUUID(),
      groupId,
      ownerId,
      integration,
      publishDate,
      content: body.content!.trim(),
      settings: settingsByIntegration[integration.id] ?? {},
      media,
      state: asDraft ? ('DRAFT' as const) : media.some((m) => m.scrub) ? ('SCRUB' as const) : ('QUEUE' as const),
    })),
  );

  return { ok: true, groupId, posts: valid.length, publishDate, draft: asDraft, skipped };
}

// ── reschedule / delete ─────────────────────────────────────────────────────

/** Run a group mutation across every visible owner: group ids are UUIDs so at
 *  most one owner matches; counts sum, and any PROCESSING hit is reported. */
export async function applyToOwners<K extends string>(
  owners: string[],
  key: K,
  fn: (ownerId: string) => Promise<{ processing: number } & Partial<Pick<GroupWriteResult, 'mismatched' | 'publishDates'>> & Record<K, number>>,
): Promise<{ processing: number; count: number; mismatched: number; publishDates: number[] }> {
  let processing = 0;
  let count = 0;
  let mismatched = 0;
  const publishDates = new Set<number>();
  for (const ownerId of owners) {
    const next = await fn(ownerId);
    processing += next.processing;
    count += next[key] ?? 0;
    mismatched += next.mismatched ?? 0;
    for (const d of next.publishDates ?? []) publishDates.add(d);
  }
  return { processing, count, mismatched, publishDates: [...publishDates].sort((a, b) => a - b) };
}

export function rescheduleVisible(owners: string[], groupId: string, publishDate: number) {
  return applyToOwners(owners, 'rescheduled', (ownerId) => socialStore.rescheduleGroup(ownerId, groupId, publishDate));
}

/** DRAFT → QUEUE (or SCRUB) with a date. */
export function scheduleVisible(owners: string[], groupId: string, publishDate: number, target: 'QUEUE' | 'SCRUB' = 'QUEUE') {
  return applyToOwners(owners, 'scheduled', (ownerId) => socialStore.scheduleGroup(ownerId, groupId, publishDate, target));
}

/** PROCESSING rows survive; `processing` > 0 means some rows stayed. */
export async function deleteVisible(owners: string[], groupId: string): Promise<{ deleted: number; processing: number; mismatched: number }> {
  const { processing, count, mismatched } = await applyToOwners(owners, 'deleted', (ownerId) => socialStore.deleteGroup(ownerId, groupId));
  return { deleted: count, processing, mismatched };
}

function parseCurve(raw: string | null | undefined): number[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}
