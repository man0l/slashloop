# Compute target (Phase 2b) — where heavy jobs run

Heavy job kinds — `fetch` / `analyze` / `refresh` / `discover` — do 60–170s
scrapes via Playwright / impit / xbogus through a residential proxy. They
CANNOT run inside a Worker (CPU time limits, no browser, no native modules).

Decision: **(b) retained-VPS worker in D1 mode now; (a) Queues + Workflows +
Containers follow-up.** Path (b) is implemented on `cf/compute-target`; path
(a) is scaffolded as unwired stubs so the follow-up merges conflict-free.

## Path (b) — retained VPS, D1 mode (implemented)

Same container, same loop (`src/worker/index.ts`), new transport:
`DB_DIALECT=sqlite` + `D1_ACCOUNT_ID` / `D1_DATABASE_ID` / `D1_API_TOKEN`
replaces `DATABASE_URL` (`src/db.ts` auto-selects the D1 HTTP client).
No Postgres regression: unset `DB_DIALECT` keeps the old behavior bit for bit.

D1 single-writer hardening (all in `src/worker/index.ts`):

| Concern | Rule |
|---|---|
| Poll cadence | `WORKER_IDLE_MS` defaults to **10000 in D1 mode**, 3000 on Postgres; explicit value wins either way |
| Recovery sweeps | `reclaimStuckJobs` **and** `failAbandonedQueuedJobs` share one `WORKER_RECLAIM_INTERVAL_MS` gate (default 5 min), maintenance worker only, randomly staggered at startup |
| Env | Startup fails fast if the D1 trio is incomplete; warns when `WORKER_INTERNAL_URL`/`CRON_SECRET` are missing (rawBatch loses atomicity without them) |
| Shutdown | SIGTERM/SIGINT finish in-flight jobs, wake the idle sleep early (~250ms); deploy keeps `stop_grace_period: 300s` (already in `worker/Dockerfile` + `.env.example`) |

Env matrix (`worker/.env.example` has the full comments):

| Var | Postgres mode | D1 mode |
|---|---|---|
| `DATABASE_URL` / `DIRECT_URL` | required | omit (ignored) |
| `DB_DIALECT=sqlite` | omit | required |
| `D1_ACCOUNT_ID` / `D1_DATABASE_ID` / `D1_API_TOKEN` | omit | required |
| `WORKER_IDLE_MS` | default 3000 | default 10000 (explicit wins) |
| `WORKER_RECLAIM_INTERVAL_MS` | default 300000 | default 300000 (do not lower) |
| `WORKER_INTERNAL_URL` + `CRON_SECRET` | n/a | required in prod (atomic rawBatch via `/internal/raw-batch`) |
| everything else (R2, Apify, AI, proxy) | unchanged | unchanged |

## Path (a) — Cloudflare-native follow-up (scaffolded, not wired)

Stubs: `src/cf/queues.ts` (producer + consumer routing), `src/cf/workflows.ts`
(retry wrapper), `src/cf/compute-containers.ts` (container runtime spec).
None are imported by `src/cf/worker.ts` / `router.ts` — wiring them is the
follow-up's diff.

Kind mapping:

| Kind | Runs on | Why |
|---|---|---|
| `fetch`, `analyze`, `refresh`, `discover` | Queue → Workflow → **Container** | 60–170s, browser/native modules, residential proxy |
| `thumb`, `rescore` | Worker inline (queue consumer) | seconds of CPU, no browser, no native deps |

Invariants the follow-up must keep:

1. **The D1 `MediaJob` table stays the queue of record.** Queues carry
   wake-up messages (`{ jobId, kind }`), never job state — no second state
   machine, no dual claim logic. If a Queue send fails, the container poll
   loop still claims the row.
2. **`processClaimedJob` runs verbatim in the Container** (same Bun image,
   `WORKER_KINDS=fetch,analyze,refresh,discover`, D1-over-HTTP). It is never
   forked; the retry/refund policy stays single-owner in
   `src/worker/process-job.ts`. The Worker-side consumer only routes; light
   kinds dynamic-import the processor (never static — bundle safety).
3. **Credentials flow, not bindings, into the Container:** D1-over-HTTP trio
   + `WORKER_INTERNAL_URL`/`CRON_SECRET` (atomic rawBatch) + R2-over-S3
   (`R2_ENDPOINT`/`R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`) + existing
   scraper/AI keys. The Worker keeps R2/D1 bindings.
4. **Playwright/impit/xbogus/warm-signer stay out of the Workers bundle:**
   container-only dynamic imports + the existing wrangler `alias` stubs
   (`src/cf/node-only-stub.ts`).

Wrangler snippet for the follow-up (do NOT apply yet — `wrangler.jsonc` is
deliberately untouched by this change):

```jsonc
{
  "queues": {
    "producers": [{ "binding": "JOB_WAKE", "queue": "slashloop-job-wake" }],
    "consumers": [{
      "queue": "slashloop-job-wake",
      "max_batch_size": 10,
      "max_retries": 3,
      "retry_delay": 30
    }]
  },
  "workflows": [{ "binding": "JOB_WORKFLOW", "name": "heavy-job", "class_name": "HeavyJobWorkflow" }],
  "containers": [{
    "binding": "HEAVY_CONTAINER",
    "image": "registry.example.com/slashloop-worker:latest",
    "instances": 2,
    "env": { "WORKER_KINDS": "fetch,analyze,refresh,discover", "DB_DIALECT": "sqlite" }
    // + secrets: D1_* / CRON_SECRET / R2 S3 keys / APIFY_* / AI keys
  }]
}
```

Transition: run (a) alongside (b) with disjoint `WORKER_KINDS` — claims are
atomic on D1's single writer, so no double-claim during the soak; then drain
(b) down to zero.
