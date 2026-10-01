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

### The account-wide D1 read ceiling

The VPS loop reaches D1 through `POST /internal/raw-batch`, so it reads with the
Worker's D1 binding but against the same Cloudflare **account**. On the free
tier that account gets 5M rows read per UTC day, and the cap is account-wide:
once it is reached, **every** D1 read on **every** database in the account fails
with Cloudflare error 7500 until midnight. A runaway caller therefore takes down
reads it has nothing to do with.

This happened on 2026-09-30: the worker loop ran `rawBatch` ~2,800 times an hour
(~2,200 rows each) and spent 74.3M rows in twelve hours. The circuit breaker
(`src/lib/circuit-breaker.ts`) could not help — that only opens when D1 is
already *failing*, and the runaway was succeeding.

`src/cf/d1-read-budget.ts` is the volume ceiling that was missing. It meters the
bridge's rows-read per UTC day and answers `429` (with `Retry-After` at the
reset) instead of spending the account. The counter lives in KV, never D1 — a
D1 counter would consume the rows it exists to protect.

| Var | Default | Notes |
|---|---|---|
| `D1_DAILY_READ_LIMIT` | `4000000` | Rows/day the bridge will spend before refusing. `0` / `off` disables. Raise only with a paid plan. Worker-side var (`wrangler.jsonc`), not a VPS `.env` value. |

The ceiling is on the **bridge**, deliberately: ordinary reads keep working, and
the money paths (credit refunds in `src/lib/credits.ts`) are only refused when
the account's read budget is genuinely spent. One request may cross the ceiling
by its own row count — the check is before the batch, so the overshoot is
bounded by one request rather than open-ended.

#### The guard's own budget: KV writes are capped, and it knows when it is flying blind

KV's free tier allows **1,000 writes/day for the whole account**, shared with
every other namespace including the digest cursor. Cloudflare *rejects* writes
past that cap rather than queueing them, so an account that blows the write cap
loses its counter — and the first cut of this guard then inverted: every fresh
isolate read the absent counter as 0, granted itself the full 4,000,000, and
replayed the 2026-09-30 runaway to **8,003,600 rows** at one isolate and
**32,014,400** at four, against the 5,000,000 platform cap. The 429 read like
protection while the outage arrived anyway.

Two defenses, because one was measured failing:

1. **Writes are budgeted.** Each isolate stops writing after
   `DAILY_FLUSH_BUDGET` (200) flushes per UTC day — 200 x the ~4 isolates this
   account runs is 800 of the 1,000 available. The flush size is *derived*
   rather than tuned: `syncRows(limit) = limit / DAILY_FLUSH_BUDGET` (floored at
   `MIN_SYNC_ROWS`), so 200 writes walk the whole ceiling exactly once. Treat
   `SYNC_MS` and `syncRows()` as budget knobs, not accuracy knobs.
2. **The ceiling shrinks when the counter cannot be persisted.** Every flush
   that fails to advance the shared total — write rejected, or budget spent —
   increments a stall counter; `STALL_FLUSH_FAILURES` (3) consecutive failures
   and the ceiling drops to `limit / DEGRADED_DIVISOR` (16), i.e. 250,000 at the
   default. Sixteen isolates each spending a sixteenth still total exactly the
   ceiling, so isolate turnover cannot breach the account cap even if the counter
   has been unreadable since the first request. A 429 body carries
   `degraded: true` when this is the ceiling that refused, which is the
   difference between "the day is spent" and "we can no longer see the day".

The honest limits: degraded mode cannot see other isolates, so it bounds the
account only by bounding each isolate, and it assumes at most 16 concurrent
isolates. It is still the safe direction — the failure mode is a loud,
reversible 429, never an overrun. A precise meter would need a Durable Object
counter, which is not worth a new migration class on the incident path.

Accounting is deliberately soft (KV is eventually consistent) and the default
ceiling carries 20% headroom for that; the module header carries the full
trade-off. Metering never blocks the caller: `recordDailyReads()` applies the
accounting synchronously and returns only the KV write, which `internal.ts`
pins with `ctx.waitUntil`, so a batch does not hold its 200 on a KV round trip.

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
