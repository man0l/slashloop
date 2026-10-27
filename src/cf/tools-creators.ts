// Creator-page plumbing for slashloop.dev/tools/tiktok/<handle>/ (SLA-1058).
//
//   POST /api/tools/internal/refresh  signed by the site Worker's weekly cron: publish one
//                                     `tools-profile` refresh job per indexable creator
//   POST /api/tools/removal           public removal form: Turnstile + limits, hides the page
//                                     on the site Worker, then emails the board
//
// The site Worker owns creators/removals/sitemap state; this Worker owns the queue credentials,
// Turnstile and Resend, so both flows cross the same signed bridge as lookup results
// (TOOLS_CALLBACK_SECRET, see tools-lookup.ts).

import { corsPreflight } from '../lib/cors.js';
import { sendEmail, type SendEmailInput, type SendEmailResult } from '../lib/email.js';
import { normalizeHandle } from '../lib/tools-handle.js';
import { loadProducerConfig, publishJobHttp } from '../queue/producer.js';
import type { Env } from './env.js';
import {
  RESULT_PATH,
  SITE_REMOVAL_PATH,
  clientHash,
  fail,
  json,
  pushToSite,
  readJson,
  toolsEnv,
  verifySigned,
  verifyTurnstile,
  yyyymmdd,
  type ToolsLookupDeps,
} from './tools-lookup.js';

export const REFRESH_PATH = '/api/tools/internal/refresh';
export const REMOVAL_PATH = '/api/tools/removal';
export const MAX_REFRESH_HANDLES = 500;
export const DAILY_REMOVAL_LIMIT = 5;
const REFRESH_CONCURRENCY = 5;
const REFRESH_DEADLINE_MS = 6 * 3600 * 1000;
const REFRESH_PUBLISH_TIMEOUT_MS = 8_000;
const REFRESH_RATE_WAIT_MS = 5_000;
const WEEK_RE = /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/;
const EMAIL_RE = /^[^\s@<>"]{1,64}@[^\s@<>"]{1,255}$/;
const DEFAULT_ORIGIN = 'https://mcp.slashloop.dev';
const DEFAULT_BOARD_EMAIL = 'manol.trendafilov@gmail.com';

export interface ToolsCreatorsDeps extends ToolsLookupDeps {
  send?: (input: SendEmailInput) => Promise<SendEmailResult>;
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export async function handleRefresh(request: Request, rawEnv: Env | undefined, deps: ToolsCreatorsDeps = {}): Promise<Response> {
  const env = toolsEnv(rawEnv);
  const now = (deps.now ?? (() => new Date()))();
  const raw = await verifySigned(request, env, now);
  if (raw instanceof Response) return raw;

  let body: { handles?: unknown; week?: unknown; reason?: unknown };
  try {
    body = JSON.parse(new TextDecoder().decode(raw)) as typeof body;
  } catch {
    return fail(request, 400, 'Invalid body.');
  }
  const week = typeof body.week === 'string' ? body.week : '';
  if (!WEEK_RE.test(week)) return fail(request, 400, 'Invalid week.');
  const reason = body.reason === 'seed' ? 'seed' : 'refresh';
  if (!Array.isArray(body.handles) || body.handles.length > MAX_REFRESH_HANDLES) return fail(request, 400, 'Invalid handles.');
  const handles = [...new Set(body.handles.map((h) => normalizeHandle(h)).filter((h): h is string => !!h))];

  const workspaceId = env.TOOLS_WORKSPACE_ID?.trim();
  const cfg = loadProducerConfig({
    QUEUE_API_URL: env.QUEUE_API_URL,
    QUEUE_API_KEY_ID: env.QUEUE_API_KEY_ID,
    QUEUE_API_KEY_SECRET: env.QUEUE_API_KEY_SECRET,
  });
  if (!workspaceId || !cfg) return fail(request, 503, 'Refresh is not available right now.');
  cfg.rateLimitWaitBudgetMs = REFRESH_RATE_WAIT_MS;
  cfg.timeoutMs = REFRESH_PUBLISH_TIMEOUT_MS;

  const origin = (env.PUBLIC_URL ?? '').replace(/\/$/, '') || new URL(request.url).origin || DEFAULT_ORIGIN;
  const stamp = now.toISOString();
  const publish = deps.publish ?? ((c, b) => publishJobHttp(c, b));
  const newId = deps.newId ?? (() => crypto.randomUUID().replace(/-/g, ''));
  const ids = handles.map(() => newId());

  if (handles.length > 0) {
    await env.DB_SHARD0.batch(
      handles.map((handle, i) =>
        env.DB_SHARD0.prepare(
          "INSERT INTO tools_lookups (id, kind, subject, status, result_json, error_code, created_at, updated_at, client_hash) VALUES (?, ?, ?, 'queued', NULL, NULL, ?, ?, 'refresh')",
        ).bind(ids[i], 'profile', handle, stamp, stamp),
      ),
    );
  }

  const tally = { published: 0, deduped: 0, failed: 0 };
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < handles.length; i = next++) {
      const handle = handles[i];
      const drop = (sql: string, ...args: unknown[]) => env.DB_SHARD0.prepare(sql).bind(...args).run();
      try {
        const accepted = await publish(cfg, {
          kind: 'tools-profile',
          workspaceId,
          videoId: null,
          sourceId: null,
          dedupeKey: `tools-profile:${handle}:${reason}:${week}`,
          deadlineAt: new Date(now.getTime() + REFRESH_DEADLINE_MS).toISOString(),
          payload: { handle, requestId: ids[i], callbackUrl: `${origin}${RESULT_PATH}`, reason },
        });
        if (accepted.deduped) {
          tally.deduped++;
          await drop('DELETE FROM tools_lookups WHERE id = ?', ids[i]);
        } else tally.published++;
      } catch (err) {
        tally.failed++;
        console.warn(`[tools-refresh] publish failed: ${(err as { code?: string }).code ?? (err as Error).name}`);
        await drop("UPDATE tools_lookups SET status = 'failed', error_code = 'queue', updated_at = ? WHERE id = ?", stamp, ids[i]);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(REFRESH_CONCURRENCY, handles.length) }, worker));

  console.log(`[tools-refresh] reason=${reason} week=${week} requested=${handles.length} published=${tally.published} deduped=${tally.deduped} failed=${tally.failed}`);
  return json(request, { week, requested: handles.length, ...tally });
}

export async function handleRemoval(request: Request, rawEnv: Env | undefined, deps: ToolsCreatorsDeps = {}): Promise<Response> {
  const env = toolsEnv(rawEnv);
  const now = (deps.now ?? (() => new Date()))();
  const body = (await readJson(request)) as { handle?: unknown; email?: unknown; reason?: unknown; turnstileToken?: unknown } | null;
  if (!body || typeof body !== 'object') return fail(request, 400, 'Invalid request.');
  const handle = normalizeHandle(body.handle);
  if (!handle) return fail(request, 400, 'Enter the TikTok username of the page to remove.');
  const email = typeof body.email === 'string' ? body.email.trim() : '';
  if (email && (email.length > 254 || !EMAIL_RE.test(email))) return fail(request, 400, 'That email address does not look right.');
  const reason = typeof body.reason === 'string' ? body.reason.trim().slice(0, 1000) : '';

  const token = typeof body.turnstileToken === 'string' ? body.turnstileToken : '';
  if (!token || token.length > 2048) return fail(request, 400, 'Verification failed. Reload the page and try again.');
  if (!env.TURNSTILE_SECRET) return fail(request, 503, 'Removal requests are not available right now.');
  const ip = request.headers.get('cf-connecting-ip');
  if (!(await verifyTurnstile(env, token, ip, deps.fetchImpl ?? fetch))) {
    return fail(request, 400, 'Verification failed. Reload the page and try again.');
  }

  const limitKey = `tools:rl:removal:${await clientHash(env, request)}:${yyyymmdd(now)}`;
  const used = Number(await env.OAUTH_KV.get(limitKey)) || 0;
  if (used >= DAILY_REMOVAL_LIMIT) return fail(request, 429, 'Too many removal requests today. Try again tomorrow.');
  await env.OAUTH_KV.put(limitKey, String(used + 1), { expirationTtl: 2 * 24 * 3600 });

  // Hide first, notify second: the page must be gone even if the email cannot be sent.
  const hidden = await pushToSite(env, SITE_REMOVAL_PATH, { handle, email: email || null, reason: reason || null, requestedAt: now.toISOString() }, deps);
  if (!hidden) return fail(request, 502, 'Could not process the request right now. Please try again in a few minutes.');

  const to = env.ALERT_EMAIL?.trim() || process.env.ALERT_EMAIL?.trim() || DEFAULT_BOARD_EMAIL;
  const lines = [`Creator page removed: https://slashloop.dev/tools/tiktok/${handle}/`, `Handle: @${handle}`, `Requester email: ${email || '(not given)'}`, `Reason: ${reason || '(not given)'}`];
  const result = await (deps.send ?? sendEmail)({
    to,
    subject: `[slashloop] Removal request for @${handle}`,
    text: `${lines.join('\n')}\n\nThe page is already hidden and out of the sitemap. Restore it by deleting the row in the site D1 removals table.`,
    html: `<p>${lines.map(escapeHtml).join('<br>')}</p><p>The page is already hidden and out of the sitemap. Restore it by deleting the row in the site D1 <code>removals</code> table.</p>`,
  });
  if (!result.sent) console.warn(`[tools-removal] board email not sent: ${result.reason ?? 'unknown'}`);
  return json(request, { status: 'removed', handle });
}

export async function OPTIONS(request: Request): Promise<Response> {
  return corsPreflight(request);
}

export async function POST(request: Request, env?: Env): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === REFRESH_PATH) return handleRefresh(request, env);
  if (pathname === REMOVAL_PATH) return handleRemoval(request, env);
  return fail(request, 404, 'Not found.');
}
