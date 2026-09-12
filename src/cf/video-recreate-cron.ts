// POST /api/jobs/video-recreate — cron entry for the Workers-native video
// recreation stepper (src/lib/recreate-video-stream.ts).
//
// Deliberately a separate route from /api/jobs/analyze: the every-minute
// whole-queue drain is OFF on this Worker (its tick raced the Contabo drainer
// for D1 and stalled HTTP — see wrangler.jsonc triggers). The `*/2` cron hits
// ONLY this route, which advances video-mode recreate state machines — one
// cheap phase per job (Gemini plan → Stream copy → ready-wait → one
// gpt-image slide per tick). It claims no other kinds and runs no sweeps, so
// it cannot re-create the contention that got the drain cron disabled.
//
// Without Stream credentials this is a no-op (rows stay queued for the VPS
// drainer's ffmpeg path).

import { stepRecreateVideoJobs } from '../lib/recreate-video-stream.js';
import { streamRecreateConfigured } from '../lib/stream-frames.js';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// The slide-gen step is the long pole (~15-25s of OpenRouter wall clock);
// a 45s budget fits one step per job plus a second job's cheap phase.
const STEP_BUDGET_MS = 45_000;

export async function POST(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return json(401, { error: 'Unauthorized' });
  }
  if (!streamRecreateConfigured()) {
    return json(200, { skipped: 'stream-not-configured', stepped: 0 });
  }
  const startedAt = Date.now();
  const result = await stepRecreateVideoJobs(STEP_BUDGET_MS).catch((err: unknown) => ({
    stepped: 0,
    error: (err as Error).message,
  }));
  return json(200, { videoRecreate: result, durationMs: Date.now() - startedAt });
}

/** A stray GET should say so, not 405-by-crash. */
export async function GET(): Promise<Response> {
  return json(405, { error: 'Method not allowed', hint: 'POST with Authorization: Bearer $CRON_SECRET' });
}
