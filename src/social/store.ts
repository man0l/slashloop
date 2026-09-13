// Raw-SQL data access for the social scheduler. Deliberately outside Prisma:
// the tables (prisma/d1-migrations/0005_social_scheduler.sql) are
// Workers-only, and the engine needs targeted state-machine statements
// (UPDATE … WHERE state = 'QUEUE' claims) that map better to raw SQL than to
// an ORM. Every statement goes through rawBatch() — atomic per call.

import { rawBatch, type RawStatement } from '../store.js';
import type { ProviderId, SocialIntegrationRow, SocialPostRow } from './types.js';

function rows<T>(result: unknown[][]): T[] {
  return (result[0] ?? []) as T[];
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ── integrations ────────────────────────────────────────────────────────────

export async function listIntegrations(ownerId: string): Promise<SocialIntegrationRow[]> {
  return rows<SocialIntegrationRow>(
    await rawBatch([
      {
        sql: 'SELECT * FROM social_integrations WHERE owner_id = ?1 AND refresh_needed = 0 ORDER BY provider, created_at',
        params: [ownerId],
      },
    ]),
  );
}

export async function listAllIntegrationsForOwner(ownerId: string): Promise<SocialIntegrationRow[]> {
  return rows<SocialIntegrationRow>(
    await rawBatch([
      {
        sql: 'SELECT * FROM social_integrations WHERE owner_id = ?1 ORDER BY provider, created_at',
        params: [ownerId],
      },
    ]),
  );
}

export async function getIntegration(id: string): Promise<SocialIntegrationRow | undefined> {
  return rows<SocialIntegrationRow>(
    await rawBatch([{ sql: 'SELECT * FROM social_integrations WHERE id = ?1', params: [id] }]),
  )[0];
}

export async function findIntegrationByInternalId(ownerId: string, provider: string, internalId: string): Promise<SocialIntegrationRow | undefined> {
  return rows<SocialIntegrationRow>(
    await rawBatch([
      {
        sql: 'SELECT * FROM social_integrations WHERE owner_id = ?1 AND provider = ?2 AND internal_id = ?3',
        params: [ownerId, provider, internalId],
      },
    ]),
  )[0];
}

export async function upsertIntegration(input: {
  id: string;
  ownerId: string;
  provider: ProviderId;
  internalId: string;
  profile: string;
  name: string;
  picture?: string;
  token: string;
  refreshToken?: string;
  expiresAt?: number;
}): Promise<void> {
  const now = nowSeconds();
  await rawBatch([
    {
      sql: `INSERT INTO social_integrations
              (id, owner_id, provider, internal_id, profile, name, picture, token, refresh_token, token_expires_at, refresh_needed, disabled, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, ?11, ?11)
            ON CONFLICT (owner_id, provider, internal_id) DO UPDATE SET
              token = excluded.token,
              refresh_token = COALESCE(excluded.refresh_token, social_integrations.refresh_token),
              token_expires_at = excluded.token_expires_at,
              profile = excluded.profile,
              name = excluded.name,
              picture = excluded.picture,
              refresh_needed = 0,
              disabled = 0,
              error = NULL,
              updated_at = excluded.updated_at`,
      params: [
        input.id,
        input.ownerId,
        input.provider,
        input.internalId,
        input.profile,
        input.name,
        input.picture ?? null,
        input.token,
        input.refreshToken ?? null,
        input.expiresAt ?? null,
        now,
      ],
    },
  ]);
}

export async function updateIntegrationTokens(id: string, token: string, refreshToken: string | undefined, expiresAt: number | undefined): Promise<void> {
  await rawBatch([
    {
      sql: `UPDATE social_integrations
            SET token = ?2, refresh_token = COALESCE(?3, refresh_token), token_expires_at = ?4, refresh_needed = 0, error = NULL, updated_at = ?5
            WHERE id = ?1`,
      params: [id, token, refreshToken ?? null, expiresAt ?? null, nowSeconds()],
    },
  ]);
}

export async function markIntegrationRefreshNeeded(id: string, error: string): Promise<void> {
  await rawBatch([
    {
      sql: 'UPDATE social_integrations SET refresh_needed = 1, error = ?2, updated_at = ?3 WHERE id = ?1',
      params: [id, error, nowSeconds()],
    },
  ]);
}

export async function setIntegrationDisabled(id: string, disabled: boolean): Promise<void> {
  await rawBatch([
    {
      sql: 'UPDATE social_integrations SET disabled = ?2, updated_at = ?3 WHERE id = ?1',
      params: [id, disabled ? 1 : 0, nowSeconds()],
    },
  ]);
}

export async function deleteIntegration(id: string, ownerId: string): Promise<void> {
  await rawBatch([
    { sql: 'DELETE FROM social_posts WHERE integration_id = ?1 AND owner_id = ?2', params: [id, ownerId] },
    { sql: 'DELETE FROM social_integrations WHERE id = ?1 AND owner_id = ?2', params: [id, ownerId] },
  ]);
}

/** Token refresh scan: due within 2 days (or already expired), still healthy,
 *  and actually refreshable. Bounded — the daily cron runs it, not a sweep. */
export async function integrationsDueForRefresh(limit = 25): Promise<SocialIntegrationRow[]> {
  const dueBefore = nowSeconds() + 2 * 24 * 3600;
  return rows<SocialIntegrationRow>(
    await rawBatch([
      {
        sql: `SELECT * FROM social_integrations
              WHERE refresh_needed = 0 AND disabled = 0 AND refresh_token IS NOT NULL AND token_expires_at IS NOT NULL AND token_expires_at < ?1
              LIMIT ?2`,
        params: [dueBefore, limit],
      },
    ]),
  );
}

// ── posts ───────────────────────────────────────────────────────────────────

export interface CreatePostInput {
  id: string;
  groupId: string;
  ownerId: string;
  integration: SocialIntegrationRow;
  publishDate: number;
  content: string;
  settings: Record<string, unknown>;
  media: Array<{ type: 'image' | 'video'; url: string; alt?: string; thumbnail?: string }>;
  /** 'DRAFT' rows carry publishDate 0 until scheduled. */
  state?: 'QUEUE' | 'DRAFT';
}

export async function createPostGroup(inputs: CreatePostInput[]): Promise<void> {
  if (!inputs.length) return;
  const now = nowSeconds();
  const state = inputs[0]?.state === 'DRAFT' ? 'DRAFT' : 'QUEUE';
  const statements: RawStatement[] = inputs.map((input) => ({
    sql: `INSERT INTO social_posts
            (id, group_id, owner_id, integration_id, provider, state, publish_date, content, settings, media, attempts, created_at, updated_at)
          VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, ?11, ?11)`,
    params: [
      input.id,
      input.groupId,
      input.ownerId,
      input.integration.id,
      input.integration.provider,
      state,
      input.publishDate,
      input.content,
      JSON.stringify(input.settings),
      JSON.stringify(input.media),
      now,
    ],
  }));
  await rawBatch(statements);
}

/** One user submission's rows (all platforms), newest first. */
export async function listPostsInRange(ownerId: string, from: number, to: number): Promise<SocialPostRow[]> {
  return rows<SocialPostRow>(
    await rawBatch([
      {
        sql: `SELECT * FROM social_posts
              WHERE owner_id = ?1 AND publish_date >= ?2 AND publish_date <= ?3
              ORDER BY publish_date ASC, group_id ASC`,
        params: [ownerId, from, to],
      },
    ]),
  );
}

/** Every draft group (dated or not), newest first — the calendar's drafts
 *  strip. Undated drafts carry publish_date 0 and never appear in ranges. */
export async function listDrafts(ownerId: string, limit = 50): Promise<SocialPostRow[]> {
  return rows<SocialPostRow>(
    await rawBatch([
      {
        sql: `SELECT * FROM social_posts WHERE owner_id = ?1 AND state = 'DRAFT'
              ORDER BY updated_at DESC LIMIT ?2`,
        params: [ownerId, limit],
      },
    ]),
  );
}

export async function getPost(id: string): Promise<SocialPostRow | undefined> {
  return rows<SocialPostRow>(await rawBatch([{ sql: 'SELECT * FROM social_posts WHERE id = ?1', params: [id] }]))[0];
}

/** Reschedule a whole group. PROCESSING rows are rejected (409 upstream):
 *  they are mid-upload and moving them would desync the engine. DRAFT groups
 *  reschedule too (they keep their DRAFT state until explicitly scheduled).
 *  The change count comes from SELECT changes() — rawBatch's executor drops
 *  D1's meta. */
export async function rescheduleGroup(ownerId: string, groupId: string, publishDate: number): Promise<{ rescheduled: number; processing: number }> {
  const results = await rawBatch([
    {
      sql: "SELECT COUNT(*) AS n FROM social_posts WHERE group_id = ?1 AND owner_id = ?2 AND state = 'PROCESSING'",
      params: [groupId, ownerId],
    },
    {
      sql: `UPDATE social_posts SET publish_date = ?3, updated_at = ?4
            WHERE group_id = ?1 AND owner_id = ?2 AND state IN ('QUEUE', 'ERROR', 'DRAFT')`,
      params: [groupId, ownerId, publishDate, nowSeconds()],
    },
    { sql: 'SELECT changes() AS n', params: [] },
  ]);
  const processing = Number((results[0]?.[0] as { n?: number } | undefined)?.n ?? 0);
  const rescheduled = Number((results[2]?.[0] as { n?: number } | undefined)?.n ?? 0);
  return { rescheduled, processing };
}

/** Update a draft/queued group's caption and media. PROCESSING/PUBLISHED
 *  groups are rejected upstream with 409 — only not-yet-published rows. */
export async function updateGroupContent(
  ownerId: string,
  groupId: string,
  content: string,
  media: Array<{ type: 'image' | 'video'; url: string; alt?: string; thumbnail?: string }>,
): Promise<{ updated: number; processing: number }> {
  const results = await rawBatch([
    {
      sql: "SELECT COUNT(*) AS n FROM social_posts WHERE group_id = ?1 AND owner_id = ?2 AND state = 'PROCESSING'",
      params: [groupId, ownerId],
    },
    {
      sql: `UPDATE social_posts SET content = ?3, media = ?4, updated_at = ?5
            WHERE group_id = ?1 AND owner_id = ?2 AND state IN ('QUEUE', 'ERROR', 'DRAFT')`,
      params: [groupId, ownerId, content, JSON.stringify(media), nowSeconds()],
    },
    { sql: 'SELECT changes() AS n', params: [] },
  ]);
  const processing = Number((results[0]?.[0] as { n?: number } | undefined)?.n ?? 0);
  const updated = Number((results[2]?.[0] as { n?: number } | undefined)?.n ?? 0);
  return { updated, processing };
}

/** Schedule a draft: DRAFT → QUEUE with a publish date. The engine then
 *  treats it like any scheduled post. */
export async function scheduleGroup(ownerId: string, groupId: string, publishDate: number): Promise<{ scheduled: number; processing: number }> {
  const results = await rawBatch([
    {
      sql: "SELECT COUNT(*) AS n FROM social_posts WHERE group_id = ?1 AND owner_id = ?2 AND state = 'PROCESSING'",
      params: [groupId, ownerId],
    },
    {
      sql: `UPDATE social_posts SET state = 'QUEUE', publish_date = ?3, updated_at = ?4
            WHERE group_id = ?1 AND owner_id = ?2 AND state = 'DRAFT'`,
      params: [groupId, ownerId, publishDate, nowSeconds()],
    },
    { sql: 'SELECT changes() AS n', params: [] },
  ]);
  const processing = Number((results[0]?.[0] as { n?: number } | undefined)?.n ?? 0);
  const scheduled = Number((results[2]?.[0] as { n?: number } | undefined)?.n ?? 0);
  return { scheduled, processing };
}

export async function deleteGroup(ownerId: string, groupId: string): Promise<{ deleted: number; processing: number }> {
  const results = await rawBatch([
    {
      sql: "SELECT COUNT(*) AS n FROM social_posts WHERE group_id = ?1 AND owner_id = ?2 AND state = 'PROCESSING'",
      params: [groupId, ownerId],
    },
    { sql: "DELETE FROM social_posts WHERE group_id = ?1 AND owner_id = ?2 AND state != 'PROCESSING'", params: [groupId, ownerId] },
    { sql: 'SELECT changes() AS n', params: [] },
  ]);
  const processing = Number((results[0]?.[0] as { n?: number } | undefined)?.n ?? 0);
  const deleted = Number((results[2]?.[0] as { n?: number } | undefined)?.n ?? 0);
  return { deleted, processing };
}

// ── engine state machine ────────────────────────────────────────────────────

/** Atomically claim due posts: QUEUE → PROCESSING. A concurrent second tick
 *  cannot re-claim the same rows (the WHERE no longer matches), which is the
 *  whole idempotency story of the cron design. */
export async function claimDuePosts(limit: number, atSeconds: number): Promise<SocialPostRow[]> {
  return rows<SocialPostRow>(
    await rawBatch([
      {
        sql: `UPDATE social_posts SET state = 'PROCESSING', updated_at = ?2
              WHERE id IN (
                SELECT id FROM social_posts WHERE state = 'QUEUE' AND publish_date <= ?2 LIMIT ?3
              )
              RETURNING *`,
        params: [atSeconds, atSeconds, limit],
      },
    ]),
  );
}

export async function processingPosts(limit: number): Promise<SocialPostRow[]> {
  return rows<SocialPostRow>(
    await rawBatch([
      {
        sql: "SELECT * FROM social_posts WHERE state = 'PROCESSING' ORDER BY updated_at ASC LIMIT ?1",
        params: [limit],
      },
    ]),
  );
}

export async function savePendingData(id: string, pendingData: unknown, attempts: number): Promise<void> {
  await rawBatch([
    {
      sql: 'UPDATE social_posts SET pending_data = ?2, attempts = ?3, updated_at = ?4 WHERE id = ?1',
      params: [id, JSON.stringify(pendingData), attempts, nowSeconds()],
    },
  ]);
}

export async function markPublished(id: string, postId: string, releaseUrl: string): Promise<void> {
  await rawBatch([
    {
      sql: `UPDATE social_posts SET state = 'PUBLISHED', release_id = ?2, release_url = ?3, pending_data = NULL, error = NULL, updated_at = ?4
            WHERE id = ?1`,
      params: [id, postId, releaseUrl, nowSeconds()],
    },
  ]);
}

export async function markError(id: string, error: string): Promise<void> {
  await rawBatch([
    {
      sql: `UPDATE social_posts SET state = 'ERROR', error = ?2, pending_data = NULL, updated_at = ?3 WHERE id = ?1`,
      params: [id, error.slice(0, 500), nowSeconds()],
    },
  ]);
}

export async function releaseBackToQueue(id: string, error: string): Promise<void> {
  await rawBatch([
    {
      sql: `UPDATE social_posts SET state = 'QUEUE', error = ?2, pending_data = NULL, updated_at = ?3 WHERE id = ?1`,
      params: [id, error.slice(0, 500), nowSeconds()],
    },
  ]);
}
