// /api/cron/social — engine tick (called by the */1 cron) and the daily
// token-refresh scan (0 5 * * *). Same auth shape as the other cron routes:
// CRON_SECRET bearer, dispatched internally by src/cf/worker.ts scheduled().
//
// The tick is deliberately small (indexed claims, LIMIT-bounded) — the
// minute-drain cron was disabled in 2025 for racing the VPS containers on
// D1; this handler must never repeat that: no sweeps, no queue wakes, just
// the state machine.

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
  console.log(`[social] tick: ${JSON.stringify(report)}`);
  return json(200, report, request);
}

async function runRefresh(request: Request): Promise<Response> {
  if (!authorized(request)) return json(401, { error: 'unauthorized' }, request);

  const report = await socialRefreshScan(socialConfigFromEnv());
  console.log(`[social] refresh scan: ${JSON.stringify(report)}`);
  return json(200, report, request);
}

/** GET  /api/cron/social          → engine tick
 *  GET  /api/cron/social?refresh=1 → token refresh scan */
export async function GET(request: Request): Promise<Response> {
  const isRefresh = new URL(request.url).searchParams.get('refresh') === '1';
  return isRefresh ? runRefresh(request) : runTick(request);
}

export const POST = GET;
