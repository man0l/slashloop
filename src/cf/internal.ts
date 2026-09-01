// POST /internal/raw-batch — atomic batch execution for the VPS worker.
//
// The D1 REST API has no batch (one statement per /raw call), so a Node/Bun
// runtime cannot execute a transaction against D1 directly. This endpoint is
// the bridge: the VPS rawBatch executor (src/store.ts) POSTs its statements
// here, and they run through the D1 BINDING's batch() — one transaction, all
// or nothing. This is what keeps credit refunds on the VPS atomic after the
// cutover (src/lib/credits.ts refund paths in failJob/reclaimStuckJobs).
//
// Auth: Bearer CRON_SECRET — the same shared secret the job-drain endpoints
// already use. Not in vercel.json (Vercel never served it); Worker-only.

import { rawBatch, type RawStatement } from '../store.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Sanity caps — this endpoint executes raw SQL, so keep the blast radius small. */
const MAX_STATEMENTS = 50;
const MAX_SQL_LENGTH = 100_000;
const MAX_TOTAL_PARAMS = 500;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { error: 'unauthorized' });
  }

  let body: { statements?: Array<{ sql?: unknown; params?: unknown }> };
  try {
    body = await request.json() as typeof body;
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  const statements = (body.statements ?? []).filter(
    (s): s is RawStatement =>
      typeof s?.sql === 'string' && s.sql.length > 0 && s.sql.length <= MAX_SQL_LENGTH,
  );
  if (statements.length === 0 || statements.length > MAX_STATEMENTS) {
    return json(400, { error: `statements must number 1..${MAX_STATEMENTS}` });
  }
  const totalParams = statements.reduce((n, s) => n + (s.params?.length ?? 0), 0);
  if (totalParams > MAX_TOTAL_PARAMS) {
    return json(400, { error: `too many bound parameters (${totalParams} > ${MAX_TOTAL_PARAMS})` });
  }

  try {
    const results = await rawBatch(statements);
    return json(200, { success: true, results });
  } catch (err) {
    return json(500, { success: false, error: (err as Error).message });
  }
}

export async function GET(): Promise<Response> {
  return json(405, { error: 'method_not_allowed' });
}
