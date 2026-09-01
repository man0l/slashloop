// Cloudflare Worker entry — fetch (all HTTP routes) + scheduled (crons).
//
// Replaces three hosting pieces at once:
//   • Vercel functions (api/*)        → this fetch handler, via src/cf/router.ts
//   • Vercel Cron (daily-only)        → the 0 3 / 0 9 triggers below
//   • Supabase pg_cron + pg_net queue wake (supabase/migrations/*_pgcron_*)
//     → the */1 trigger poking the same /api/jobs/analyze drain logic
//
// Crons authenticate internally with the same CRON_SECRET the HTTP routes
// expect, by dispatching through the router — one auth path, no shadow logic.

import { ensureStore, type Env } from './env.js';
import { route } from './router.js';

// Per-isolate request gate.
//
// The D1 binding intermittently never settles concurrent prepared-statement
// promises (cpuTime ~1ms, wallTime until the client gives up). A JS mutex
// around the binding deadlocks Prisma's wasm engine, which fans `_count`
// includes out as concurrent adapter calls and waits for all of them before
// yielding. Serializing whole handlers keeps in-flight D1 work at one
// request; handlers themselves must not Promise.all Prisma queries.
let gate: Promise<unknown> = Promise.resolve();

function gated<T>(fn: () => Promise<T>): Promise<T> {
  const run = gate.then(fn, fn);
  gate = run.catch(() => {});
  return run;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    await ensureStore(env);
    return gated(() => route(request));
  },

  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Register the store first — every drain/sweep touches the DB.
    await ensureStore(env);

    const cron = event.cron;
    // Real triggers carry their expression; wrangler's local
    // /cdn-cgi/local/scheduled endpoint sends an empty string — default that
    // to the drain (the most frequent trigger) so the path stays testable.
    const path =
      cron === '*/1 * * * *' || cron === '' ? '/api/jobs/analyze'
      : cron === '0 3 * * *' ? '/api/cron/media-retention'
      : cron === '0 9 * * 1' ? '/api/cron/digest'
      : null;
    if (!path) {
      console.warn(`[worker] unknown cron: ${cron}`);
      return;
    }

    const secret = process.env.CRON_SECRET ?? '';
    const request = new Request(`https://internal${path}`, {
      method: 'POST',
      headers: secret ? { Authorization: `Bearer ${secret}` } : {},
    });

    // waitUntil: the response body is only log output — let the drain finish
    // without blocking the scheduler's slot accounting.
    ctx.waitUntil(
      gated(() => route(request))
        .then(async (res) => {
          const body = await res.text();
          console.log(`[worker] cron ${cron} ${path} → ${res.status} ${body.slice(0, 500)}`);
        })
        .catch((err) => {
          console.error(`[worker] cron ${cron} ${path} failed: ${(err as Error).message}`);
        }),
    );
  },
} satisfies ExportedHandler<Env>;
