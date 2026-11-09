// ---------------------------------------------------------------------------
// MCP Tools: social post scheduler — list_social_accounts, upload_social_media,
// create_social_post, list_social_posts, get_social_stats, reschedule_social_post,
// delete_social_post, plus the lane/rotation planner: tag_social_account,
// set_rotation, plan_rotation.
//
// The same scheduler the web calendar drives (src/social/*), called in-process:
// the store is keyed by owner id, resolved from the MCP session's JWT sub, and
// widened to teammates exactly like the HTTP routes (visibleOwnerIds). Never an
// HTTP hop to the site. OAuth connect stays in the web app.
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { currentUserEmail, currentUserId } from '../context.js';
import { canonicalSiteUrl } from '../lib/cors.js';
import { managedOwnerIds, visibleOwnerIds } from '../social/visibility.js';
import * as socialStore from '../social/store.js';
import {
  MAX_PLAN_DAYS,
  MAX_SLOTS,
  isValidDate,
  isValidSlot,
  isValidTimezone,
  laneAndPrimary,
  normalizeLaneName,
  parseStoredTags,
  planRotation,
  validateTags,
  weekdayOf,
  type RotationAccount,
  type RotationConfig,
} from '../social/rotation.js';
import {
  createPost,
  deleteVisible,
  listCalendar,
  rescheduleVisible,
  scheduleVisible,
  visibleIntegrations,
  type CalendarGroup,
  type CreatePostInput,
  type CreatePostResult,
} from '../social/posting.js';
import { UploadError, storeSocialMediaFromUrl, type StoredMedia } from '../social/media-upload.js';
import { siteAwareFetch } from '../lib/site-fetch.js';
import { setPostThumbnail, type ThumbnailTarget } from '../social/thumbnail.js';
import { STATS_BUCKETS, STATS_MODES, getSocialStats, parseStatsQuery } from '../social/stats.js';
import type { SocialIntegrationRow, SocialRotationRow } from '../social/types.js';

export interface SocialToolDeps {
  /** The authenticated caller, or null on local stdio (no tenant → refused). */
  caller: () => { userId: string; email: string | null } | null;
  resolveOwners: (userId: string, email: string | null) => Promise<string[]>;
  listIntegrations: (owners: string[], healthyOnly: boolean) => ReturnType<typeof visibleIntegrations>;
  createPost: (userId: string, owners: () => Promise<string[]>, body: CreatePostInput) => Promise<CreatePostResult>;
  listCalendar: typeof listCalendar;
  getStats: typeof getSocialStats;
  reschedule: typeof rescheduleVisible;
  schedule: typeof scheduleVisible;
  deleteGroup: typeof deleteVisible;
  setThumbnail: (owners: string[], target: ThumbnailTarget, thumbnailUrl: string) => ReturnType<typeof setPostThumbnail>;
  /** Owner ids whose accounts the caller may tag: themselves + teammates of workspaces they own. */
  managedOwners: (userId: string) => Promise<string[]>;
  setTags: typeof socialStore.setIntegrationTags;
  getRotation: typeof socialStore.getRotation;
  upsertRotation: typeof socialStore.upsertRotation;
  uploadFromUrl: (url: string) => Promise<StoredMedia>;
  now: () => number;
  connectUrl: () => string;
}

export const defaultSocialDeps: SocialToolDeps = {
  caller: () => {
    const userId = currentUserId();
    return userId ? { userId, email: currentUserEmail() } : null;
  },
  resolveOwners: visibleOwnerIds,
  listIntegrations: visibleIntegrations,
  createPost,
  listCalendar,
  getStats: getSocialStats,
  reschedule: rescheduleVisible,
  schedule: scheduleVisible,
  deleteGroup: deleteVisible,
  // Lazy: api/social.ts owns the env → SocialConfig mapping and pulls in the HTTP auth stack.
  setThumbnail: async (owners, target, thumbnailUrl) => {
    const { socialConfigFromEnv } = await import('../../api/social.js');
    return setPostThumbnail(socialConfigFromEnv(), owners, target, thumbnailUrl);
  },
  managedOwners: managedOwnerIds,
  setTags: socialStore.setIntegrationTags,
  getRotation: socialStore.getRotation,
  upsertRotation: socialStore.upsertRotation,
  uploadFromUrl: (url) => storeSocialMediaFromUrl(url, siteAwareFetch),
  now: () => Date.now(),
  connectUrl: () => `${canonicalSiteUrl()}/calendar`,
};

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
const text = (payload: unknown, isError = false): ToolResult => ({
  content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

/** An ISO-8601 instant WITH an offset: a bare "2026-11-01T10:00:00" would be
 *  read in the server's zone, which is never what an agent means. */
const OFFSET_RE = /(Z|[+-]\d{2}:?\d{2})$/i;
const PAST_GRACE_SECONDS = 60;

type TimeParse = { ok: true; seconds: number } | { ok: false; error: string; message: string };

function parseInstant(value: string, nowMs: number, opts: { allowPast: boolean }): TimeParse {
  if (!OFFSET_RE.test(value.trim())) {
    return { ok: false, error: 'invalid_time', message: 'Time must be ISO 8601 with an explicit offset, e.g. 2026-11-03T15:00:00Z or 2026-11-03T17:00:00+02:00.' };
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return { ok: false, error: 'invalid_time', message: `Could not parse "${value}" as an ISO 8601 time.` };
  const seconds = Math.floor(ms / 1000);
  if (!opts.allowPast && seconds < Math.floor(nowMs / 1000) - PAST_GRACE_SECONDS) {
    return { ok: false, error: 'time_in_past', message: 'That time is already past; a past time would publish on the next scheduler tick. Pass a future time (or omit publishAt to save a draft).' };
  }
  return { ok: true, seconds };
}

const iso = (seconds: number): string | null => (seconds > 0 ? new Date(seconds * 1000).toISOString() : null);

function presentGroup(group: CalendarGroup) {
  return {
    groupId: group.groupId,
    state: group.state,
    publishAt: iso(group.publishDate),
    content: group.content,
    media: group.media.map((m) => ({ type: m.type, url: m.url, ...(m.alt ? { alt: m.alt } : {}), ...(m.thumbnail ? { thumbnail: m.thumbnail } : {}) })),
    posts: group.posts.map((p) => ({
      id: p.id,
      provider: p.provider,
      account: p.account,
      state: p.state,
      releaseUrl: p.releaseUrl,
      error: p.error,
      ...(p.metrics ? { metrics: { ...p.metrics, syncedAt: iso(p.metrics.syncedAt) } } : {}),
    })),
  };
}

function presentAccount(row: SocialIntegrationRow) {
  const tags = parseStoredTags(row.tags);
  const { lane, primary } = laneAndPrimary(tags);
  return {
    id: row.id,
    provider: row.provider,
    profile: row.profile,
    name: row.name,
    status: statusOf(row),
    needsReconnect: Boolean(row.refresh_needed),
    disabled: Boolean(row.disabled),
    error: row.error,
    tags,
    lane,
    primary,
    ...presentInsights(row),
  };
}

const INSIGHTS_HINTS: Record<string, string> = {
  missing_permission: 'Meta refused the insights call: the connection lacks instagram_business_manage_insights. Reconnect the account in the web app and accept the insights permission.',
  personal_account: 'Insights are only available for Business/Creator accounts. Switch the account to professional in the Instagram app, then reconnect it.',
  no_data: 'Instagram returned no insights rows for the latest post (too new, or the account type does not report them).',
};

/** Instagram only: whether views/reach/saves/shares can be read for this account. */
function presentInsights(row: SocialIntegrationRow): { insights?: string; insightsReason?: string; insightsHint?: string } {
  if (row.provider !== 'instagram') return {};
  const status = row.insights_status;
  if (!status) return { insights: 'unknown' };
  if (status === 'ok') return { insights: 'available' };
  const hint = INSIGHTS_HINTS[status];
  return { insights: 'unavailable', insightsReason: status, ...(hint ? { insightsHint: hint } : {}) };
}

function presentRotation(row: SocialRotationRow): RotationConfig {
  return {
    name: row.name,
    lanes: JSON.parse(row.lanes) as string[],
    anchorMonday: row.anchor_monday,
    periodDays: row.period_days,
    timezone: row.timezone,
  };
}

function handleOf(row: SocialIntegrationRow): string {
  return row.profile || row.name || row.internal_id;
}

const statusOf = (row: SocialIntegrationRow): 'active' | 'reconnect_needed' | 'disabled' =>
  row.disabled ? 'disabled' : row.refresh_needed ? 'reconnect_needed' : 'active';

const laneMember = (row: SocialIntegrationRow) => ({ integrationId: row.id, provider: row.provider, handle: handleOf(row) });

/** Lane → accounts view for list_social_accounts; healthy = the planner's rule (an active primary). */
function buildLanes(rows: SocialIntegrationRow[]) {
  const byLane = new Map<string, SocialIntegrationRow[]>();
  const untagged: SocialIntegrationRow[] = [];
  for (const row of rows) {
    const { lane } = laneAndPrimary(parseStoredTags(row.tags));
    if (lane === null) untagged.push(row);
    else byLane.set(lane, [...(byLane.get(lane) ?? []), row]);
  }
  const isPrimary = (row: SocialIntegrationRow) => laneAndPrimary(parseStoredTags(row.tags)).primary;
  const lanes = [...byLane.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lane, members]) => {
      const ordered = [...members].sort((a, b) => Number(isPrimary(b)) - Number(isPrimary(a)));
      const primary = ordered.find(isPrimary);
      return {
        lane,
        primary: primary ? laneMember(primary) : null,
        members: ordered.map((row) => ({ ...laneMember(row), role: isPrimary(row) ? ('primary' as const) : ('repost' as const), status: statusOf(row) })),
        healthy: Boolean(primary && statusOf(primary) === 'active'),
      };
    });
  return { lanes, untagged: untagged.map((row) => ({ ...laneMember(row), status: statusOf(row) })) };
}

const PROCESSING_MESSAGE = 'A post in this group is publishing right now — try again in a moment.';

export function registerSocialTools(server: McpServer, d: SocialToolDeps = defaultSocialDeps) {
  async function withCaller(fn: (c: { userId: string; email: string | null }) => Promise<ToolResult>): Promise<ToolResult> {
    const caller = d.caller();
    if (!caller) {
      return text({ error: 'auth_required', message: 'Social scheduling needs a signed-in Slashloop account; it is not available over local stdio.' }, true);
    }
    try {
      return await fn(caller);
    } catch (err) {
      console.error(`[social-tools] ${(err as Error).message}`);
      return text({ error: 'social_unavailable', message: (err as Error).message }, true);
    }
  }

  // ---- list_social_accounts ----
  server.tool(
    'list_social_accounts',
    'List the connected social accounts (TikTok, YouTube, Instagram, Threads, Pinterest) that posts can be scheduled to. '
      + 'Returns each account id (use as integrationIds in create_social_post), provider, handle and status: active, reconnect_needed '
      + '(token expired — the user must reconnect in the web app) or disabled. Tokens are never returned. '
      + 'Instagram accounts also carry `insights` (available | unavailable | unknown) with `insightsReason`/`insightsHint` when views/reach/saves/shares cannot be read. '
      + 'Each account also carries `tags`, `lane` and `primary` (see tag_social_account). '
      + 'The top-level `lanes` block answers "which account is in which lane" in one call: per lane its primary, its members (role primary | repost, status) and `healthy` '
      + '(the primary is active); `untagged` lists accounts with no lane. To post to a whole lane, pass its name to create_social_post as `lane`. '
      + 'Includes teammates\' accounts shared through a workspace. Connecting accounts happens in the web app (OAuth); '
      + 'when none are connected the response carries the connect URL. Free; no credits charged.',
    {},
    { readOnlyHint: true },
    () => withCaller(async ({ userId, email }) => {
      const owners = await d.resolveOwners(userId, email);
      const rows = await d.listIntegrations(owners, false);
      const accounts = rows.map(presentAccount);
      if (!accounts.length) {
        return text({
          accounts,
          lanes: [],
          untagged: [],
          connectUrl: d.connectUrl(),
          message: 'No social accounts are connected. Connect them in the Slashloop web app (OAuth cannot be done from MCP), then call this again.',
        });
      }
      const usable = accounts.filter((a) => a.status === 'active').length;
      return text({
        accounts,
        ...buildLanes(rows),
        usable,
        ...(usable < accounts.length ? { message: 'Some accounts need attention (reconnect_needed / disabled) and cannot be targeted until fixed in the web app.', connectUrl: d.connectUrl() } : {}),
      });
    }),
  );

  // ---- tag_social_account ----
  server.tool(
    'tag_social_account',
    'Replace the tags on a connected social account. Vocabulary: `lane:<name>` (at most one per account; every account in a lane posts the same video at the same minute) '
      + 'and `primary` (the lane\'s lead account, at most one per lane; it decides whether the lane is healthy and requires a lane tag). Pass [] to clear. '
      + 'Only the user who connected the account, or the owner of a workspace it is shared through, may tag it (else `not_owner`). '
      + 'Errors: invalid_tag, primary_needs_lane, lane_has_primary, not_found, not_owner. Free.',
    {
      integrationId: z.string().min(1).describe('Account id from list_social_accounts.'),
      tags: z.array(z.string()).max(4).describe('Full replacement tag list, e.g. ["lane:jenny","primary"].'),
    },
    { readOnlyHint: false },
    ({ integrationId, tags }) => withCaller(async ({ userId, email }) => {
      const owners = await d.resolveOwners(userId, email);
      const visible = await d.listIntegrations(owners, false);
      const row = visible.find((r) => r.id === integrationId);
      if (!row) return text({ error: 'not_found', message: 'No visible account has that id. Call list_social_accounts.', integrationId }, true);
      if (row.owner_id !== userId && !(await d.managedOwners(userId)).includes(row.owner_id)) {
        return text({ error: 'not_owner', message: 'Only the user who connected this account, or the owner of a workspace it is shared through, can tag it.', integrationId }, true);
      }
      const parsed = validateTags(tags);
      if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
      if (parsed.primary) {
        const clash = visible.find((r) => r.id !== row.id && laneAndPrimary(parseStoredTags(r.tags)).primary && laneAndPrimary(parseStoredTags(r.tags)).lane === parsed.lane);
        if (clash) {
          return text({ error: 'lane_has_primary', message: `Lane "${parsed.lane}" already has a primary (${handleOf(clash)}, ${clash.id}); clear its primary tag first.`, lane: parsed.lane, primaryIntegrationId: clash.id }, true);
        }
      }
      await d.setTags(row.id, parsed.tags);
      return text({ integrationId: row.id, provider: row.provider, handle: handleOf(row), tags: parsed.tags, lane: parsed.lane, primary: parsed.primary });
    }),
  );

  // ---- set_rotation ----
  server.tool(
    'set_rotation',
    'Create or update (by name) a weekly lane rotation: the ordered lane list, an anchor Monday and the timezone slots are read in. '
      + 'Week 0 starts on `anchorMonday` (YYYY-MM-DD, must be a Monday); video v of a day goes to lanes[(v-1-week) mod lanes.length], so every week is a permutation and each lane takes a different video slot each week. '
      + 'Lane names are the `lane:<name>` tags from tag_social_account. A lane no account is tagged with is accepted but reported in `warnings`. '
      + 'Errors: invalid_name, invalid_lanes, invalid_anchor, anchor_not_monday, invalid_timezone, invalid_period. Free.',
    {
      name: z.string().min(1).max(64).describe('Rotation name, unique per user.'),
      lanes: z.array(z.string()).describe('Ordered lane names, e.g. ["jenny","alice","spoon"].'),
      anchorMonday: z.string().describe('YYYY-MM-DD of the Monday that starts week 0, in `timezone`.'),
      periodDays: z.number().int().min(1).max(366).optional().describe('Days per rotation step. Default 7.'),
      timezone: z.string().optional().describe('IANA zone the anchor and slot times are read in. Default America/New_York.'),
    },
    { readOnlyHint: false },
    ({ name, lanes, anchorMonday, periodDays, timezone }) => withCaller(async ({ userId, email }) => {
      const cleanName = name.trim();
      if (!cleanName) return text({ error: 'invalid_name', message: 'name must not be blank.' }, true);
      const tz = timezone ?? 'America/New_York';
      if (!isValidTimezone(tz)) return text({ error: 'invalid_timezone', message: `"${tz}" is not an IANA timezone (e.g. America/New_York).` }, true);
      const normalized: string[] = [];
      for (const lane of lanes) {
        const n = normalizeLaneName(lane);
        if (!n) return text({ error: 'invalid_lanes', message: `"${lane}" is not a valid lane name (lowercase letters, digits, "-" or "_").` }, true);
        if (normalized.includes(n)) return text({ error: 'invalid_lanes', message: `Lane "${n}" is listed twice; each lane appears once so every week is a permutation.` }, true);
        normalized.push(n);
      }
      if (!normalized.length) return text({ error: 'invalid_lanes', message: 'lanes must list at least one lane.' }, true);
      if (!isValidDate(anchorMonday)) return text({ error: 'invalid_anchor', message: 'anchorMonday must be a real calendar date, YYYY-MM-DD.' }, true);
      if (weekdayOf(anchorMonday) !== 1) {
        const day = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekdayOf(anchorMonday)];
        return text({ error: 'anchor_not_monday', message: `${anchorMonday} is a ${day} in ${tz}; anchorMonday must be a Monday.` }, true);
      }

      const owners = await d.resolveOwners(userId, email);
      const accounts = await d.listIntegrations(owners, false);
      const warnings: string[] = [];
      for (const lane of normalized) {
        const members = accounts.filter((a) => laneAndPrimary(parseStoredTags(a.tags)).lane === lane);
        if (!members.length) warnings.push(`lane "${lane}" has no tagged account; its videos will move to the next lane (tag_social_account).`);
        else if (!members.some((a) => laneAndPrimary(parseStoredTags(a.tags)).primary)) warnings.push(`lane "${lane}" has no primary account; its videos will move to the next lane.`);
      }

      const config = { ownerId: userId, name: cleanName, lanes: normalized, anchorMonday, periodDays: periodDays ?? 7, timezone: tz };
      const created = await d.upsertRotation(config);
      return text({
        created,
        rotation: { name: cleanName, lanes: normalized, anchorMonday, periodDays: config.periodDays, timezone: tz },
        warnings,
      });
    }),
  );

  // ---- plan_rotation ----
  server.tool(
    'plan_rotation',
    'Read-only: lay out which account posts which video for `days` days from `from` under a saved rotation (set_rotation). Creates nothing. '
      + '`slots` is the ordered local HH:MM post times in the rotation\'s timezone; slots.length = videos per day and slot i is video i+1. '
      + 'Each row is one account for one video: every account in the lane shares the identical publishAt (primary first). If a lane\'s primary is reconnect_needed/disabled (or the lane has none), '
      + 'that video moves to the next lane with a healthy primary; every move and every skipped account is listed in `problems`. '
      + 'Call this before scheduling a week, then create_social_post({ integrationIds: [row.integrationId], publishAt: row.publishAt, … }) per row after the user confirms. '
      + 'Errors: rotation_not_found, invalid_date, invalid_slots, invalid_days. Free.',
    {
      rotation: z.string().min(1).describe('Rotation name from set_rotation.'),
      from: z.string().describe('First local date, YYYY-MM-DD in the rotation timezone.'),
      days: z.number().int().min(1).max(MAX_PLAN_DAYS),
      slots: z.array(z.string()).min(1).max(MAX_SLOTS).describe('Local HH:MM times, e.g. ["09:00","13:00","19:00"].'),
    },
    { readOnlyHint: true },
    ({ rotation, from, days, slots }) => withCaller(async ({ userId, email }) => {
      if (!isValidDate(from)) return text({ error: 'invalid_date', message: 'from must be a real calendar date, YYYY-MM-DD.' }, true);
      const badSlot = slots.find((s) => !isValidSlot(s));
      if (badSlot !== undefined) return text({ error: 'invalid_slots', message: `"${badSlot}" is not HH:MM (24h, e.g. 09:00).` }, true);

      const owners = [userId, ...(await d.resolveOwners(userId, email)).filter((o) => o !== userId)];
      let saved: SocialRotationRow | undefined;
      for (const owner of owners) {
        saved = await d.getRotation(owner, rotation.trim());
        if (saved) break;
      }
      if (!saved) return text({ error: 'rotation_not_found', message: `No rotation named "${rotation}". Create it with set_rotation.` }, true);

      const accounts: RotationAccount[] = (await d.listIntegrations(owners, false)).map((row) => ({
        integrationId: row.id,
        provider: row.provider,
        internalId: row.internal_id,
        handle: handleOf(row),
        tags: parseStoredTags(row.tags),
        refreshNeeded: Boolean(row.refresh_needed),
        disabled: Boolean(row.disabled),
      }));
      return text(planRotation(presentRotation(saved), accounts, { from, days, slots }));
    }),
  );

  // ---- upload_social_media ----
  server.tool(
    'upload_social_media',
    'Copy an image or video from a public http(s) URL into Slashloop storage and return a stable public URL to use in create_social_post media. '
      + 'Use it for any file that is not already on a durable public URL; rendered experiment images (the image URLs from get_experiment) can be passed directly. '
      + 'Accepted: JPEG/PNG/WebP images up to 20MB, MP4/MOV videos up to 95MB (same limits as the web uploader). Free; no credits charged.',
    { url: z.string().url().describe('Public http(s) URL of the image or video to store.') },
    { readOnlyHint: false },
    ({ url }) => withCaller(async () => {
      try {
        const stored = await d.uploadFromUrl(url);
        return text({ url: stored.url, type: stored.type, sizeBytes: stored.sizeBytes, sourceUrl: url });
      } catch (err) {
        if (err instanceof UploadError) return text({ error: err.code, message: err.message, ...err.detail }, true);
        throw err;
      }
    }),
  );

  // ---- create_social_post ----
  server.tool(
    'create_social_post',
    'Create a social post for one or more connected accounts: SAVES A DRAFT when publishAt is omitted, otherwise SCHEDULES it to go live at publishAt. '
      + 'CONFIRM FIRST: a scheduled post publishes publicly on the user\'s real accounts without further prompts — get an explicit yes on the caption, media, '
      + 'accounts and time before scheduling; when unsure, save a draft (omit publishAt) and let the user approve it. '
      + 'Target accounts with exactly one of: integrationIds (from list_social_accounts) or `lane` (a lane name; expands to every active account in that lane, '
      + 'errors lane_not_found / lane_unhealthy when the lane\'s primary needs a reconnect — it never falls through to another lane); media is an ordered list of {type: image|video, url} with public URLs (see upload_social_media). '
      + 'publishAt is ISO 8601 with an offset (e.g. 2026-11-03T15:00:00Z). Platforms that reject the post (e.g. too many slides) are skipped and reported in `skipped`; '
      + 'the post is still created for the rest. Free; no credits charged.',
    {
      integrationIds: z.array(z.string()).min(1).max(20).optional().describe('Account ids from list_social_accounts. Pass this or `lane`, not both.'),
      lane: z.string().min(1).optional().describe('Lane name (e.g. "alice"): posts to every active account tagged lane:<name>. Pass this or integrationIds, not both.'),
      content: z.string().min(1).describe('Caption / post text.'),
      media: z
        .array(z.object({
          type: z.enum(['image', 'video']),
          url: z.string().url().describe('Public http(s) media URL.'),
          alt: z.string().optional(),
          thumbnail: z.string().url().optional().describe('Cover image (JPEG, public URL, 9:16 for reels). Used as the Instagram Reel cover and the YouTube/Pinterest thumbnail; without it Instagram uses the frame at 1s.'),
        }))
        .max(35)
        .optional()
        .describe('Ordered media (slideshow images, or a single video).'),
      publishAt: z.string().optional().describe('ISO 8601 time with offset. Omit to save a draft.'),
      stripMetadata: z.boolean().optional().describe('Re-capture the media before publishing so no source fingerprint/metadata survives.'),
      settings: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe('Per-account provider settings keyed by integration id (e.g. TikTok privacy, Pinterest board, Instagram thumbOffsetMs = Reel cover frame in ms when no thumbnail is set; default 1000).'),
    },
    { readOnlyHint: false },
    ({ integrationIds, lane, content, media, publishAt, stripMetadata, settings }) => withCaller(async ({ userId, email }) => {
      if ((integrationIds?.length ? 1 : 0) + (lane !== undefined ? 1 : 0) !== 1) {
        return text({ error: 'invalid_target', message: 'Pass exactly one of integrationIds or lane.' }, true);
      }
      let targetIds = integrationIds ?? [];
      let laneName: string | null = null;
      if (lane !== undefined) {
        laneName = normalizeLaneName(lane);
        const members = laneName === null
          ? []
          : (await d.listIntegrations(await d.resolveOwners(userId, email), false)).filter((r) => laneAndPrimary(parseStoredTags(r.tags)).lane === laneName);
        if (laneName === null || !members.length) {
          return text({ error: 'lane_not_found', message: `No visible account is tagged lane:${lane}. Call list_social_accounts and read its \`lanes\` block.`, lane }, true);
        }
        const primary = members.find((r) => laneAndPrimary(parseStoredTags(r.tags)).primary);
        const active = members.filter((r) => statusOf(r) === 'active');
        if ((primary && statusOf(primary) !== 'active') || !active.length) {
          const bad = primary && statusOf(primary) !== 'active' ? primary : members[0];
          return text({
            error: 'lane_unhealthy',
            message: `Lane "${laneName}" cannot be posted to: ${primary && statusOf(primary) !== 'active' ? 'its primary' : 'no member'} ${handleOf(bad)} is ${statusOf(bad)}. Reconnect it in the web app, or target accounts with integrationIds.`,
            lane: laneName,
            integrationId: bad.id,
          }, true);
        }
        targetIds = active
          .sort((a, b) => Number(laneAndPrimary(parseStoredTags(b.tags)).primary) - Number(laneAndPrimary(parseStoredTags(a.tags)).primary))
          .map((r) => r.id);
      }
      let publishDate: number | undefined;
      if (publishAt !== undefined) {
        const parsed = parseInstant(publishAt, d.now(), { allowPast: false });
        if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
        publishDate = parsed.seconds;
      }
      const result = await d.createPost(userId, () => d.resolveOwners(userId, email), {
        integrationIds: targetIds,
        content,
        media,
        publishDate,
        draft: publishDate === undefined,
        stripMetadata,
        settings,
      });
      if (!result.ok) {
        return text({ error: result.error, ...(result.skipped ? { skipped: result.skipped } : {}), message: createErrorMessage(result.error) }, true);
      }
      return text({
        groupId: result.groupId,
        ...(laneName !== null ? { lane: laneName, integrationIds: targetIds } : {}),
        state: result.draft ? 'draft' : 'scheduled',
        publishAt: iso(result.publishDate),
        accounts: result.posts,
        skipped: result.skipped,
        message: result.draft
          ? 'Saved as a draft. Nothing will publish until it is scheduled (reschedule_social_post with schedule=true).'
          : `Scheduled for ${iso(result.publishDate)}.`,
      });
    }),
  );

  // ---- get_social_stats ----
  server.tool(
    'get_social_stats',
    'Views per connected account over time, bucketed by day, week (Monday start) or month (UTC). '
      + 'mode "gained" (default) = views each account gained in the bucket, from daily snapshots (tracking starts at `trackingSince`; the first snapshot of a post counts only if it was published that day); '
      + 'mode "posted" = current views of the posts published in the bucket. from/to are inclusive YYYY-MM-DD dates, at most 400 days apart (default: last 30 days). '
      + 'accounts filters by integration id (list_social_accounts). Includes teammates\' accounts shared through a workspace. Free.',
    {
      from: z.string().optional().describe('First day, YYYY-MM-DD (UTC). Default: 29 days before `to`.'),
      to: z.string().optional().describe('Last day, inclusive, YYYY-MM-DD (UTC). Default: today.'),
      bucket: z.enum(STATS_BUCKETS).optional().describe('day (default), week (starts Monday) or month (starts on the 1st).'),
      mode: z.enum(STATS_MODES).optional().describe('gained (default) or posted.'),
      accounts: z.array(z.string().min(1)).optional().describe('Integration ids to include. Default: every account.'),
    },
    { readOnlyHint: true },
    ({ from, to, bucket, mode, accounts }) => withCaller(async ({ userId, email }) => {
      const parsed = parseStatsQuery({ from, to, bucket, mode, accounts: accounts?.join(',') }, d.now());
      if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
      const owners = await d.resolveOwners(userId, email);
      return text(await d.getStats(owners, parsed.query));
    }),
  );

  // ---- list_social_posts ----
  server.tool(
    'list_social_posts',
    'List scheduled and published social posts in a time range, plus all drafts. from/to are ISO 8601 with an offset; default is now → 30 days ahead. '
      + 'Each post group has a groupId (use for reschedule/delete), aggregate state (draft, queued, processing, published, error, scrubbing), '
      + 'publishAt, caption, media and one entry per account with its own state, releaseUrl and error. Includes teammates\' posts shared through a workspace. Free.',
    {
      from: z.string().optional().describe('Range start, ISO 8601 with offset. Default: now.'),
      to: z.string().optional().describe('Range end, ISO 8601 with offset. Default: 30 days after from.'),
    },
    { readOnlyHint: true },
    ({ from, to }) => withCaller(async ({ userId, email }) => {
      const nowS = Math.floor(d.now() / 1000);
      let fromS = nowS;
      if (from !== undefined) {
        const parsed = parseInstant(from, d.now(), { allowPast: true });
        if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
        fromS = parsed.seconds;
      }
      let toS = fromS + 30 * 86_400;
      if (to !== undefined) {
        const parsed = parseInstant(to, d.now(), { allowPast: true });
        if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
        toS = parsed.seconds;
      }
      if (toS < fromS) return text({ error: 'invalid_range', message: '`to` must not be before `from`.' }, true);

      const owners = await d.resolveOwners(userId, email);
      const { groups, drafts } = await d.listCalendar(owners, fromS, toS);
      return text({
        range: { from: iso(fromS), to: iso(toS) },
        posts: groups.map(presentGroup),
        drafts: drafts.map(presentGroup),
      });
    }),
  );

  // ---- reschedule_social_post ----
  server.tool(
    'reschedule_social_post',
    'Move a post group to a new publishAt (ISO 8601 with offset). Works on draft, queued and errored groups. A draft stays a draft '
      + 'unless schedule=true, which turns it into a scheduled post — CONFIRM FIRST with the user before scheduling a draft, since it will then publish on the real accounts. '
      + 'Returns error "processing" (409) while any post in the group is publishing right now — retry shortly. Free.',
    {
      groupId: z.string().min(1).describe('groupId from list_social_posts / create_social_post.'),
      publishAt: z.string().describe('New time, ISO 8601 with offset.'),
      schedule: z.boolean().optional().describe('true = also promote a draft to scheduled (DRAFT → QUEUE).'),
    },
    { readOnlyHint: false },
    ({ groupId, publishAt, schedule }) => withCaller(async ({ userId, email }) => {
      const parsed = parseInstant(publishAt, d.now(), { allowPast: false });
      if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
      const owners = await d.resolveOwners(userId, email);
      const result = schedule
        ? await d.schedule(owners, groupId, parsed.seconds)
        : await d.reschedule(owners, groupId, parsed.seconds);
      if (result.processing > 0) return text({ error: 'processing', message: PROCESSING_MESSAGE, groupId }, true);
      if (result.mismatched > 0) {
        return text({
          error: 'not_persisted',
          message: 'The write returned but the stored publishAt does not match the request. The post may still publish at its old time — check list_social_posts and retry.',
          groupId,
          requested: iso(parsed.seconds),
          stored: result.publishDates.map(iso),
        }, true);
      }
      if (result.count === 0) {
        return text({
          error: 'not_found',
          message: schedule
            ? 'No draft rows matched that groupId (unknown id, or the group is not a draft).'
            : 'No reschedulable rows matched that groupId (unknown id, or every post is already published).',
          groupId,
        }, true);
      }
      return text({ groupId, publishAt: iso(result.publishDates[0] ?? parsed.seconds), updated: result.count, state: schedule ? 'scheduled' : undefined });
    }),
  );

  // ---- set_social_post_thumbnail ----
  server.tool(
    'set_social_post_thumbnail',
    'Set the cover/thumbnail image of a post. Draft/queued/errored posts store it and the platform applies it at publish time. '
      + 'ALREADY-PUBLISHED YouTube posts are updated live on YouTube (thumbnails.set; the channel must be verified, image JPEG/PNG under 2MB) and echoed by list_social_posts. '
      + 'Published Instagram Reels CANNOT be changed through the API — those return error "not_supported" (set the cover in the Instagram app). '
      + 'Pass groupId to cover every post in the group, or postId to target one post; the response lists a per-post status '
      + '(updated, saved, unsupported, processing, skipped, failed). Free.',
    {
      groupId: z.string().min(1).optional().describe('groupId from list_social_posts — applies to every post in the group.'),
      postId: z.string().min(1).optional().describe('A single post id (posts[].id from list_social_posts) instead of the whole group.'),
      thumbnail: z.string().url().describe('Public http(s) URL of the cover image (JPEG/PNG, under 2MB for YouTube; 9:16 for reels).'),
    },
    { readOnlyHint: false },
    ({ groupId, postId, thumbnail }) => withCaller(async ({ userId, email }) => {
      if (!groupId && !postId) return text({ error: 'missing_target', message: 'Pass groupId or postId.' }, true);
      const owners = await d.resolveOwners(userId, email);
      const outcome = await d.setThumbnail(owners, postId ? { postId } : { groupId }, thumbnail);
      if (!outcome.ok) return text({ error: outcome.error, message: outcome.message }, true);
      const { results } = outcome;
      if (!results.length) return text({ error: 'not_found', message: 'No posts matched that groupId/postId.' }, true);
      const done = results.some((r) => r.status === 'updated' || r.status === 'saved');
      if (!done) {
        const error = results.some((r) => r.status === 'processing')
          ? 'processing'
          : results.some((r) => r.status === 'unsupported') ? 'not_supported' : 'thumbnail_failed';
        return text({ error, message: results.find((r) => r.message)?.message, results }, true);
      }
      return text({ thumbnail, results });
    }),
  );

  // ---- delete_social_post ----
  server.tool(
    'delete_social_post',
    'Delete a post group (draft or scheduled) from every account it targets. Irreversible — confirm with the user first. '
      + 'Rows whose post is publishing right now (PROCESSING) are NOT deleted; the response lists how many stayed so you can retry later. '
      + 'Posts already published on the platform are not removed from the platform. Free.',
    { groupId: z.string().min(1).describe('groupId from list_social_posts / create_social_post.') },
    { readOnlyHint: false, destructiveHint: true },
    ({ groupId }) => withCaller(async ({ userId, email }) => {
      const owners = await d.resolveOwners(userId, email);
      const { deleted, processing, mismatched } = await d.deleteGroup(owners, groupId);
      if (mismatched > 0 && processing === 0) {
        return text({ error: 'not_persisted', message: 'The delete returned but rows still exist for this group. Check list_social_posts and retry.', groupId, deleted }, true);
      }
      if (processing > 0) {
        return text({
          error: 'processing',
          message: 'Some posts in this group are publishing right now and were not deleted; retry in a moment.',
          groupId,
          deleted,
          remainingProcessing: processing,
        }, true);
      }
      if (deleted === 0) return text({ error: 'not_found', message: 'No posts matched that groupId.', groupId }, true);
      return text({ groupId, deleted, remainingProcessing: 0 });
    }),
  );
}

function createErrorMessage(error: string): string {
  switch (error) {
    case 'no_integrations': return 'Pass at least one integrationId from list_social_accounts, or a lane name.';
    case 'missing_content': return 'content (the caption) is required.';
    case 'invalid_publish_date': return 'publishAt could not be read as a time.';
    case 'media_urls_must_be_absolute': return 'Every media url must be an absolute http(s) URL (see upload_social_media).';
    case 'no_valid_integrations': return 'None of the integrationIds is a usable connected account (unknown, not visible to you, or needs a reconnect). Call list_social_accounts.';
    case 'invalid_for_provider': return 'No selected account accepts this post; see `skipped` for each platform\'s reason.';
    default: return error;
  }
}
