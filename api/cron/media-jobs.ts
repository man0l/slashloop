// GET /api/cron/media-jobs — daily backstop for the analyze queue.
//
// The fast path is the dispatch analyze_video fires at enqueue time
// (src/lib/jobs.ts). This is what makes the queue reliable rather than merely
// usually-working: it requeues jobs whose worker died without reporting, then
// drains whatever is still waiting.
//
// Daily is not a design choice — the Vercel plan caps cron at one run per day,
// and sub-daily expressions fail deployment outright. That is precisely why the
// dispatch exists: without it, an analysis would wait up to 24 hours. Read this
// as the floor on how late a job can run, not the expected latency.
//
// Guarded by CRON_SECRET, which Vercel Cron sends automatically.

import { reclaimStuckJobs, STUCK_AFTER_MINUTES } from '../../src/lib/jobs.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { error: 'Unauthorized' });
  }

  const startedAt = Date.now();

  // Order matters: reclaim first so anything abandoned is back in `queued`
  // before the drain runs, otherwise it waits another full day.
  const reclaimed = await reclaimStuckJobs();

  // Drain by calling the worker rather than duplicating its loop — one
  // implementation of claim/run/refund, one place for it to be wrong.
  let drain: unknown = null;
  try {
    const base = process.env.PUBLIC_URL?.replace(/\/$/, '')
      ?? (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null);
    if (base) {
      const res = await fetch(`${base}/api/jobs/analyze`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
      });
      drain = await res.json().catch(() => ({ status: res.status }));
    } else {
      drain = { skipped: 'no PUBLIC_URL or VERCEL_URL' };
    }
  } catch (err) {
    drain = { error: (err as Error).message };
  }

  return json(200, {
    stuckAfterMinutes: STUCK_AFTER_MINUTES,
    reclaimed,
    drain,
    durationMs: Date.now() - startedAt,
  });
}
