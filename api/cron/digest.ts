// GET /api/cron/digest — weekly outlier digest.
//
// For every workspace that is digest-enabled, has an owner with a resolvable
// email, and is due (never digested or ≥7 days since the last one):
//   1. buildDigest() computes the payload (watermark = lastDigestAt).
//   2. The payload persists on the workspace BEFORE sending — get_digest can
//      serve it even if the email fails.
//   3. Payloads are grouped by RECIPIENT (Workspace.digestEmail override,
//      else the owner's auth email): an owner with several workspaces gets
//      ONE combined email, not one per workspace (grouping happens per
//      INVOCATION — see the paging note below).
//   4. sendEmail() delivers via Resend; failures are recorded, never thrown —
//      one bad recipient must not skip the rest of the sweep.
//
// D1 limits: 1000 queries per invocation (Paid), a 30s batch ceiling, and a
// single-threaded database (~10 qps at 100ms). One due workspace costs ~7
// queries (video.count, score.findMany, 2× chunked analysis.findMany,
// idea.findMany, workspace.update, ownerEmail — plus a video refetch when a
// thumb was backfilled). The historical one-shot sweep of up to 200
// workspaces therefore ran ~1400 queries: over the cap. The sweep now PAGES:
// DIGEST_PAGE_SIZE workspaces (default 10, env-tunable) per invocation, each
// invocation resuming where the previous left off via a cursor in the
// SHARD_DIRECTORY KV binding. Worst case ≈ 1 findMany + 10×9 + backfill 1 +
// 2 KV ops ≈ 94 D1 queries per invocation — an hour of headroom under the
// cap and well inside the 60s function budget.
//
// Cursor semantics (src/cf/kv.ts): one KV value — the index of the next due
// workspace — under a Monday-scoped key (`digest:cursor:<YYYY-MM-DD>`).
//   • crash between "process page" and "write cursor" → ≤ page workspaces
//     re-processed; each payload is rebuilt and lastDigestAt overwritten with
//     the same value, so the worst case is a duplicate email.
//   • stale cursor → benign: a workspace's lastDigestAt is persisted before
//     emailing, so it drops out of the due list and the index re-sits on the
//     next unprocessed workspace.
//   • a new week → new key, fresh sweep from 0.
// The KV binding exists only on the Worker runtime (where wrangler.jsonc's
// weekly trigger will eventually run this). On the Vercel invocation there
// is no binding, so the historical one-shot sweep runs unchanged — still
// over the 1000-query cap once more than ~125 workspaces are due (see
// docs/cf-cutover-checklist.md, step 8: the digest moves to the Worker at
// final cutover).
//
// Guarded by CRON_SECRET. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
// automatically when that env var is set on the project.

import { db } from '../../src/db.js';
import { clampCursorIndex, digestCursorKey, getShardDirectory } from '../../src/cf/kv.js';
import {
  buildDigest, digestSubject, renderDigestText, renderDigestHtml, ownerEmail,
  type DigestPayload, type DigestSection,
} from '../../src/lib/digest.js';
import { sendEmail } from '../../src/lib/email.js';

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap per run — a large backlog drains over consecutive weekly runs. */
const MAX_WORKSPACES_PER_RUN = 200;
/** Default DIGEST_PAGE_SIZE — see the D1-cap note in the header comment. */
const DEFAULT_PAGE_SIZE = 10;

type DueWorkspace = {
  id: string;
  ownerId: string | null;
  name: string;
  digestEmail: string | null;
  createdAt: Date;
  lastDigestAt: Date | null;
  planCredits: number;
  packCredits: number;
};
type RunResult = { email: string; emailed: boolean; workspaces: string[]; detail?: string };
type Built = { name: string; payload: DigestPayload };

/** How many due workspaces one invocation processes (env-tunable). */
function pageSize(): number {
  const raw = process.env.DIGEST_PAGE_SIZE ? Number(process.env.DIGEST_PAGE_SIZE) : NaN;
  if (!Number.isInteger(raw) || raw < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(raw, MAX_WORKSPACES_PER_RUN);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build + persist the payloads of due[start..end). Returns them grouped by
 * RECIPIENT — an owner with several workspaces gets one combined email, not
 * N, as long as they land in the same invocation.
 */
async function buildBatch(
  due: DueWorkspace[],
  start: number,
  end: number,
  record: (r: RunResult) => void,
  backfillBudget: { remaining: number },
): Promise<Map<string, Built[]>> {
  const byRecipient = new Map<string, Built[]>();

  for (const ws of due.slice(start, end)) {
    try {
      const payload = await buildDigest(ws, ws.planCredits + ws.packCredits, backfillBudget);
      await db.workspace.update({
        where: { id: ws.id },
        data: { lastDigestAt: new Date(payload.generatedAt), digestJson: JSON.stringify(payload) },
      });

      // Explicit per-workspace override wins; else the owner's auth email.
      const email = ws.digestEmail ?? await ownerEmail(ws.ownerId!);
      if (!email) {
        record({ email: '(unresolvable)', emailed: false, workspaces: [ws.name], detail: 'no owner email resolved — payload stored' });
        continue;
      }
      const bucket = byRecipient.get(email) ?? [];
      bucket.push({ name: ws.name, payload });
      byRecipient.set(email, bucket);
    } catch (err) {
      record({ email: '(error)', emailed: false, workspaces: [ws.name], detail: (err as Error).message.slice(0, 200) });
    }
  }

  return byRecipient;
}

async function deliver(byRecipient: Map<string, Built[]>, record: (r: RunResult) => void): Promise<void> {
  for (const [email, built] of byRecipient) {
    try {
      // Quiet workspaces stay out of the email entirely — but their payload
      // was persisted above, so get_digest still serves them.
      const sections: DigestSection[] = built.filter(
        b => b.payload.newOutliersCount > 0 || b.payload.ideas.overdue > 0,
      );
      if (sections.length === 0) {
        record({ email, emailed: false, workspaces: built.map(b => b.name), detail: 'nothing to report — payloads stored' });
        continue;
      }

      const sent = await sendEmail({
        to: email,
        subject: digestSubject(sections),
        html: renderDigestHtml(sections),
        text: renderDigestText(sections),
      });
      record({
        email,
        emailed: sent.sent,
        workspaces: sections.map(s => s.name),
        ...(sent.sent ? { detail: `resend:${sent.id ?? 'ok'}` } : { detail: sent.reason }),
      });
    } catch (err) {
      record({ email, emailed: false, workspaces: built.map(b => b.name), detail: (err as Error).message.slice(0, 200) });
    }
  }
}

// Named GET (not export default) — Vercel only hands Web-Request objects to
// method-named exports; a default export receives Node-style (req, res).
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(500, { error: 'CRON_SECRET is not configured' });

  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' });

  const due = await db.workspace.findMany({
    where: {
      digestEnabled: true,
      ownerId: { not: null },
      OR: [
        { lastDigestAt: null },
        { lastDigestAt: { lte: new Date(Date.now() - DIGEST_INTERVAL_MS) } },
      ],
      // Never email an empty workspace — nothing to say yet.
      sources: { some: {} },
    },
    select: {
      id: true, ownerId: true, name: true, digestEmail: true,
      createdAt: true, lastDigestAt: true, planCredits: true, packCredits: true,
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_WORKSPACES_PER_RUN,
  });

  const results: RunResult[] = [];
  const record = (r: RunResult) => {
    console.log(`[digest] ${JSON.stringify(r)}`);
    results.push(r);
  };

  // Paged sweep: with a KV binding (Worker runtime) resume from the stored
  // index and process only DIGEST_PAGE_SIZE workspaces, so every invocation
  // stays under D1's 1000-query cap. Without KV (Vercel cron), fall back to
  // the historical one-shot sweep.
  const kv = getShardDirectory();
  const size = pageSize();
  let start = 0;
  if (kv && due.length > size) {
    start = clampCursorIndex(await kv.get(digestCursorKey()), due.length);
  }
  const end = Math.min(due.length, start + size);
  const paged = kv !== undefined && (start > 0 || end - start < due.length);

  // Thumb captures are bounded per invocation (oEmbed fetch + image fetch +
  // upload per video) so a page can't crowd the 60s function budget.
  const backfillBudget = { remaining: 15 };

  const byRecipient = await buildBatch(due, start, end, record, backfillBudget);
  await deliver(byRecipient, record);

  // Always advance — even out of range: clampCursorIndex restarts from 0
  // once the sweep has wrapped or the due list has shrunk.
  if (kv) await kv.put(digestCursorKey(), String(Math.min(end, due.length)));

  console.log(`[digest] run: ${JSON.stringify({
    dueWorkspaces: due.length,
    processed: end - start,
    cursor: paged ? `${start}..${end}` : null,
    recipients: byRecipient.size,
    emailed: results.filter(r => r.emailed).length,
  })}`);

  return json(200, {
    dueWorkspaces: due.length,
    processed: end - start,
    recipients: byRecipient.size,
    emailed: results.filter(r => r.emailed).length,
    cursor: paged ? { start, end, pageSize: size } : null,
    results,
  });
}