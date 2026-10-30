// ---------------------------------------------------------------------------
// MCP Tools: social post scheduler — list_social_accounts, upload_social_media,
// create_social_post, list_social_posts, reschedule_social_post,
// delete_social_post.
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
import { visibleOwnerIds } from '../social/visibility.js';
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
import type { SocialIntegrationRow } from '../social/types.js';

export interface SocialToolDeps {
  /** The authenticated caller, or null on local stdio (no tenant → refused). */
  caller: () => { userId: string; email: string | null } | null;
  resolveOwners: (userId: string, email: string | null) => Promise<string[]>;
  listIntegrations: (owners: string[], healthyOnly: boolean) => ReturnType<typeof visibleIntegrations>;
  createPost: (userId: string, owners: () => Promise<string[]>, body: CreatePostInput) => Promise<CreatePostResult>;
  listCalendar: typeof listCalendar;
  reschedule: typeof rescheduleVisible;
  schedule: typeof scheduleVisible;
  deleteGroup: typeof deleteVisible;
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
  reschedule: rescheduleVisible,
  schedule: scheduleVisible,
  deleteGroup: deleteVisible,
  uploadFromUrl: (url) => storeSocialMediaFromUrl(url),
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
    media: group.media.map((m) => ({ type: m.type, url: m.url, ...(m.alt ? { alt: m.alt } : {}) })),
    posts: group.posts.map((p) => ({
      id: p.id,
      provider: p.provider,
      state: p.state,
      releaseUrl: p.releaseUrl,
      error: p.error,
    })),
  };
}

function presentAccount(row: SocialIntegrationRow) {
  return {
    id: row.id,
    provider: row.provider,
    profile: row.profile,
    name: row.name,
    status: row.disabled ? 'disabled' : row.refresh_needed ? 'reconnect_needed' : 'active',
    needsReconnect: Boolean(row.refresh_needed),
    disabled: Boolean(row.disabled),
    error: row.error,
  };
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
      + 'Includes teammates\' accounts shared through a workspace. Connecting accounts happens in the web app (OAuth); '
      + 'when none are connected the response carries the connect URL. Free; no credits charged.',
    {},
    { readOnlyHint: true },
    () => withCaller(async ({ userId, email }) => {
      const owners = await d.resolveOwners(userId, email);
      const accounts = (await d.listIntegrations(owners, false)).map(presentAccount);
      if (!accounts.length) {
        return text({
          accounts,
          connectUrl: d.connectUrl(),
          message: 'No social accounts are connected. Connect them in the Slashloop web app (OAuth cannot be done from MCP), then call this again.',
        });
      }
      const usable = accounts.filter((a) => a.status === 'active').length;
      return text({
        accounts,
        usable,
        ...(usable < accounts.length ? { message: 'Some accounts need attention (reconnect_needed / disabled) and cannot be targeted until fixed in the web app.', connectUrl: d.connectUrl() } : {}),
      });
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
      + 'integrationIds come from list_social_accounts; media is an ordered list of {type: image|video, url} with public URLs (see upload_social_media). '
      + 'publishAt is ISO 8601 with an offset (e.g. 2026-11-03T15:00:00Z). Platforms that reject the post (e.g. too many slides) are skipped and reported in `skipped`; '
      + 'the post is still created for the rest. Free; no credits charged.',
    {
      integrationIds: z.array(z.string()).min(1).max(20).describe('Account ids from list_social_accounts.'),
      content: z.string().min(1).describe('Caption / post text.'),
      media: z
        .array(z.object({
          type: z.enum(['image', 'video']),
          url: z.string().url().describe('Public http(s) media URL.'),
          alt: z.string().optional(),
          thumbnail: z.string().url().optional(),
        }))
        .max(35)
        .optional()
        .describe('Ordered media (slideshow images, or a single video).'),
      publishAt: z.string().optional().describe('ISO 8601 time with offset. Omit to save a draft.'),
      stripMetadata: z.boolean().optional().describe('Re-capture the media before publishing so no source fingerprint/metadata survives.'),
      settings: z
        .record(z.string(), z.record(z.string(), z.unknown()))
        .optional()
        .describe('Per-account provider settings keyed by integration id (e.g. TikTok privacy, Pinterest board).'),
    },
    { readOnlyHint: false },
    ({ integrationIds, content, media, publishAt, stripMetadata, settings }) => withCaller(async ({ userId, email }) => {
      let publishDate: number | undefined;
      if (publishAt !== undefined) {
        const parsed = parseInstant(publishAt, d.now(), { allowPast: false });
        if (!parsed.ok) return text({ error: parsed.error, message: parsed.message }, true);
        publishDate = parsed.seconds;
      }
      const result = await d.createPost(userId, () => d.resolveOwners(userId, email), {
        integrationIds,
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
      if (result.count === 0) {
        return text({
          error: 'not_found',
          message: schedule
            ? 'No draft rows matched that groupId (unknown id, or the group is not a draft).'
            : 'No reschedulable rows matched that groupId (unknown id, or every post is already published).',
          groupId,
        }, true);
      }
      return text({ groupId, publishAt: iso(parsed.seconds), updated: result.count, state: schedule ? 'scheduled' : undefined });
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
      const { deleted, processing } = await d.deleteGroup(owners, groupId);
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
    case 'no_integrations': return 'Pass at least one integrationId from list_social_accounts.';
    case 'missing_content': return 'content (the caption) is required.';
    case 'invalid_publish_date': return 'publishAt could not be read as a time.';
    case 'media_urls_must_be_absolute': return 'Every media url must be an absolute http(s) URL (see upload_social_media).';
    case 'no_valid_integrations': return 'None of the integrationIds is a usable connected account (unknown, not visible to you, or needs a reconnect). Call list_social_accounts.';
    case 'invalid_for_provider': return 'No selected account accepts this post; see `skipped` for each platform\'s reason.';
    default: return error;
  }
}
