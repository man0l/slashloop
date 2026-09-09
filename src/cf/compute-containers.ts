// ===========================================================================
// Phase 2b path (a) — Cloudflare-native compute: Container runtime stub.
// NOT WIRED IN. Nothing imports this module. This file documents how the
// heavy-kind Container reuses the CURRENT VPS worker code verbatim — it is
// the spec the follow-up's Dockerfile/container entry implements.
//
// Key point: processClaimedJob (src/worker/process-job.ts) is NOT forked.
// The Container image is the same Bun codebase as today's VPS worker; only
// the transport changes (D1-over-HTTP instead of Postgres, R2-over-S3
// instead of Supabase Storage). The retry/refund policy stays in one place.
//
// What runs where (see docs/compute-target.md for the full matrix):
//   Container (this file's sketch): fetch, analyze, refresh, discover.
//   Worker inline (queue consumer):  thumb, rescore.
// ===========================================================================

/** Secrets the Container receives (Container env — never the Worker bundle). */
export interface ContainerEnv {
  DB_DIALECT: 'sqlite';
  /** D1-over-HTTP credentials — same trio as the retained-VPS D1 mode. */
  D1_ACCOUNT_ID: string;
  D1_DATABASE_ID: string;
  D1_API_TOKEN: string;
  /** Atomic money paths: batches POST to the Worker's /internal/raw-batch. */
  WORKER_INTERNAL_URL: string;
  CRON_SECRET: string;
  /** R2-over-S3: the Container has no R2 bindings, so it uses the S3 API. */
  R2_ENDPOINT: string;
  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  R2_MEDIA_BUCKET: string;
  R2_THUMB_BUCKET: string;
  /** Scraper + AI keys: identical names to worker/.env.example. */
  APIFY_API_KEY: string;
  SCRAPER_PROVIDER?: string;
  SCRAPER_PROXY_URL?: string;
  OPENROUTER_API_KEY?: string;
  GEMINI_API_KEY?: string;
}

/**
 * Container entry sketch — this is src/worker/index.ts with a narrower
 * WORKER_KINDS and D1-mode env, no code fork:
 *
 *   WORKER_KINDS=fetch,analyze,refresh,discover \
 *   DB_DIALECT=sqlite D1_ACCOUNT_ID=… D1_DATABASE_ID=… D1_API_TOKEN=… \
 *   WORKER_INTERNAL_URL=https://<worker> CRON_SECRET=… \
 *   WORKER_IDLE_MS=10000 \
 *   bun src/worker/index.ts
 *
 * The loop claims via claimNextJob (atomic on D1's single writer), runs
 * withMeterScope(() => processClaimedJob(job)) under jobTimeoutMs(kind),
 * and exits between jobs on SIGTERM (stop_grace_period 300s — the image
 * already declares STOPSIGNAL SIGTERM; see worker/Dockerfile).
 *
 * Bundle-safety note: this code runs on Bun INSIDE the container, where
 * Playwright/impit/xbogus/warm-signer are real installed dependencies. It
 * must never be imported by src/cf/worker.ts — the wrangler `alias` stubs
 * exist precisely because those modules cannot load on workerd.
 */
export const __containerSketch = 'see docblock above';
