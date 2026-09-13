// /api/cron/social — engine tick, chained onto the worker's */2 scheduled
// handler (src/cf/worker.ts) because a dedicated */1 cron would exceed the
// Workers Free account cap of 5 triggers (and the old */1 drain was disabled
// for D1 contention — this handler must never repeat that: no sweeps, no
// queue wakes, just the bounded state machine).
//
// The token-refresh scan rides inside every tick: when nothing is due it is
// ONE indexed LIMIT-5 query returning zero rows, so running it per tick is
// cheaper than a separate daily cron. ?refresh=1 raises the scan limit for
// a manual full pass.

import { socialEngineTick, socialRefreshScan } from '../../src/social/index.js';
import { socialConfigFromEnv } from '../social.js';
import { corsHeaders } from '../../src/lib/cors.js';

function json(status: number, body: unknown, request: Request): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(request) } });
}

function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET ?? '';
  return Boolean(secret) && request.headers.get('authorization') === `Bearer ${secret}`;
}

export async function OPTIONS(request: Request): Promise<Response> {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

async function runTick(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'unauthorized' }, request);

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get('limit'));
  const report = await socialEngineTick(
    socialConfigFromEnv(),
    Number.isFinite(limit) && limit > 0 ? { batchLimit: Math.min(limit, 25) } : {},
  );

  // Bounded token refresh — see header comment.
  const refresh = await socialRefreshScan(socialConfigFromEnv(), { limit: url.searchParams.get('refresh') === '1' ? 25 : 5 });
  if (refresh.scanned > 0) console.log(`[social] refresh: ${JSON.stringify(refresh)}`);

  console.log(`[social] tick: ${JSON.stringify(report)}`);
  return json(200, { ...report, refresh }, request);
}

/** GET /api/cron/social           → engine tick + bounded refresh scan
 *  GET /api/cron/social?refresh=1 → same, with a wider refresh scan */
export async function GET(request: Request): Promise<Response> {
  return runTick(request);
}

export const POST = GET;
