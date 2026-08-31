// ---------------------------------------------------------------------------
// Scrape-outage email — one email per outage, never a repeat.
//
// Scraping failures (fetch/refresh jobs) range from "this one TikTok was
// deleted" (noise) to "the proxy endpoint refuses every connection" (the
// Aug-2026 Proxy-Cheap outage, where the vendor kept status ACTIVE while the
// connect IP/port went null). This module emails the owner exactly once per
// outage episode and stays quiet until scraping works again:
//
//   failJob(scrape kind) -> notifyScrapeFailure:
//     - per-video noise is filtered out (classifyFetchError + NOISE codes)
//     - an atomic UPDATE ... WHERE "notifiedAt" IS NULL claims the send, so
//       the two worker containers racing the same outage cannot both email
//     - claim then send: a failed send releases the claim so the next failure
//       retries the email instead of silently swallowing the outage
//   completeJob(scrape kind) -> markScrapeSuccess: clears notifiedAt (after a
//     6h rearm cooldown), re-arming the alert for the NEXT outage — the
//     cooldown is what stops a flapping proxy from emailing on every dip
//
// State lives in the ScrapeAlertState table (one row, id='scrape'), not in
// memory — watchtower recreates containers on every deploy and an in-memory
// flag would re-email after each one. Written only via raw SQL: the model in
// schema.prisma is documentation, the client never touches it. A claim holds
// for the whole episode — strictly one email, never two. If the table is
// missing (migration not applied yet) every query throws, we swallow, and NO
// email goes out — alerting must fail off, never fail spammy.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { classifyFetchError, type FetchErrorCode } from './fetch-errors.js';
import { sendEmail } from './email.js';

/// The kinds that actually scrape TikTok (proxy/Apify). analyze/rescore are
/// AI work, thumb is a single CDN image fetch — outages there are not
/// "scraping is down" and would only add alert noise.
export const SCRAPE_ALERT_KINDS: ReadonlySet<string> = new Set(['fetch', 'refresh']);

/// Failure codes that mean "this one piece of content is bad", not "scraping
/// is broken". Everything else (spend cap, missing key, actor errors, CDN
/// refusals, and anything unclassifiable) alerts — a novel failure mode
/// should surface, and the once-per-episode dedupe caps the noise if it is
/// actually per-video after all.
const PER_CONTENT_NOISE: ReadonlySet<FetchErrorCode> = new Set([
  'video_not_found',
  'video_unavailable',
  'apify_not_stored',
  'download_failed',
  'openrouter_balance',
]);

const NETWORK_FLAVOR =
  /failed to connect|connection refused|tcp connect|econn(refused|reset|timedout)|socket hang up|fetch failed|network|timeout|timed out/i;

/**
 * Should this failure text page the owner? True for outage-flavored errors
 * (infrastructure codes plus any network-ish message), false for per-video
 * noise like a deleted TikTok.
 */
export function isScrapeOutageError(message: string): boolean {
  if (!message?.trim()) return false;
  const info = classifyFetchError(message);
  if (info && PER_CONTENT_NOISE.has(info.code)) return false;
  if (NETWORK_FLAVOR.test(message)) return true;
  // Unclassifiable messages count as outage — see PER_CONTENT_NOISE comment.
  return true;
}

function alertRecipient(): string {
  return process.env.ALERT_EMAIL?.trim() || 'manol.trendafilov@gmail.com';
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Pure email builder so tests can pin the wording without a DB or Resend. */
export function renderScrapeAlert(kind: string, message: string): { subject: string; html: string; text: string } {
  const info = classifyFetchError(message);
  const hint = info ? info.message : '';
  const short = message.slice(0, 400);
  const subject = `[slashloop] scraping is failing — ${kind} jobs`;
  const lines = [`Scraping is failing (${kind} jobs). First failure of this episode:`, ``, short];
  if (hint) lines.push(``, hint);
  lines.push(
    ``,
    `You will not get another email until scraping succeeds once (then this re-arms).`,
    `Workers: contabo VPS (salonease-slashloop-worker*). Proxy status: https://dashboard.proxy-cheap.com`,
  );
  const text = lines.join('\n');
  const html = `
<p><strong>Scraping is failing</strong> (${kind} jobs).</p>
<p><code>${escapeHtml(short)}</code></p>
${hint ? `<p>${escapeHtml(hint)}</p>` : ''}
<p style="color:#666">One email per outage episode — re-armed by the next successful scrape.
Workers: contabo VPS · <a href="https://dashboard.proxy-cheap.com">Proxy-Cheap dashboard</a></p>`.trim();
  return { subject, html, text };
}

/// Release the incident claim — used both to re-arm on success and to retry
/// the email if Resend rejected the send.
async function rearm(): Promise<void> {
  await db.$executeRaw`UPDATE "ScrapeAlertState" SET "notifiedAt" = NULL, "lastError" = NULL, "updatedAt" = now()
    WHERE id = 'scrape' AND "notifiedAt" IS NOT NULL`;
}

/**
 * Called from failJob for every scraping-kind failure. Never throws — alerting
 * must not be able to fail the job path, and a missing table (pre-migration)
 * must disable alerting rather than spam.
 */
export async function notifyScrapeFailure(kind: string, message: string): Promise<void> {
  try {
    if (!SCRAPE_ALERT_KINDS.has(kind)) return;
    if (!isScrapeOutageError(message)) return;

    // Atomic claim: both workers can hit this concurrently, but only one
    // UPDATE matches an armed row — the loser gets 0 and stays silent. The
    // claim is PERMANENT for the episode: a crash in the ~1s between claim
    // and send loses that episode's email rather than ever risking a second
    // one. An earlier 10-minute expiry here re-sent an episode after a
    // container died mid-send — the owner got the same outage email twice,
    // which is exactly what this module must never do. Silence is the
    // accepted failure mode; recovery re-arms.
    const claimed = await db.$executeRaw`UPDATE "ScrapeAlertState" SET "notifiedAt" = now(), "lastError" = ${message.slice(0, 500)}, "updatedAt" = now()
      WHERE id = 'scrape' AND "notifiedAt" IS NULL`;
    if (claimed === 0) return; // already mid-incident, or another worker just claimed it

    const { subject, html, text } = renderScrapeAlert(kind, message);
    const res = await sendEmail({ to: alertRecipient(), subject, html, text });
    if (!res.sent) {
      console.warn(`[scrape-alert] send failed (${res.reason}) — releasing claim for retry`);
      await rearm();
      return;
    }
    console.log(`[scrape-alert] outage email sent for ${kind} failure (${res.id ?? 'no id'})`);
  } catch (err) {
    // Includes the table-missing case until the migration lands — fail off.
    console.warn(`[scrape-alert] skipped: ${(err as Error).message.slice(0, 160)}`);
  }
}

/**
 * Re-arm cooldown (hours). A flapping proxy defeats one-email-per-episode:
 * each brief success re-arms, the next failure emails again — the Aug-31
 * outage sent three emails this way (169 failures vs 18 successes over 2h).
 * A success only re-arms if the last email is this old, so flap storms stay
 * silent while a genuinely new outage (next day, say) still alerts.
 */
export function rearmCooldownSeconds(): number {
  const raw = process.env.SCRAPE_ALERT_REARM_COOLDOWN_HOURS;
  const n = raw == null ? NaN : Number(raw);
  const hours = Number.isFinite(n) && n > 0 ? n : 6;
  return Math.floor(hours * 3600);
}

/**
 * Called from completeJob for every scraping-kind success. Re-arms the alert
 * so the next outage emails again — but no faster than the rearm cooldown,
 * or a flapping proxy emails on every dip. A provably failed send (the rearm
 * caller in notifyScrapeFailure) bypasses this: retrying a send that never
 * happened cannot duplicate anything. Never throws.
 */
export async function markScrapeSuccess(kind: string): Promise<void> {
  try {
    if (!SCRAPE_ALERT_KINDS.has(kind)) return;
    await db.$executeRaw`UPDATE "ScrapeAlertState" SET "notifiedAt" = NULL, "lastError" = NULL, "updatedAt" = now()
      WHERE id = 'scrape' AND "notifiedAt" IS NOT NULL
        AND "notifiedAt" < now() - (${rearmCooldownSeconds()} * interval '1 second')`;
  } catch (err) {
    console.warn(`[scrape-alert] rearm skipped: ${(err as Error).message.slice(0, 160)}`);
  }
}
