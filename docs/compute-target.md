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
D1 counter would consume the rows it exists to protect. Accounting is
deliberately soft (KV is eventually consistent) and the default ceiling carries
20% headroom for that; see the module header for the full trade-off.

| Var | Default | Notes |
|---|---|---|
| `D1_DAILY_READ_LIMIT` | `4000000` | Rows/day the bridge will spend before refusing. `0` / `off` disables. Raise only with a paid plan. Worker-side var (`wrangler.jsonc`), not a VPS `.env` value. |

The ceiling is on the **bridge**, deliberately: ordinary reads keep working, and
the money paths (credit refunds in `src/lib/credits.ts`) are only refused when
the account's read budget is genuinely spent. One request may cross the ceiling
by its own row count — the check is before the batch, so the overshoot is
bounded by one request rather than open-ended.

#### The counter spends the account's KV *write* budget

The KV free tier allows **1,000 writes/day, account-wide**, shared with every
other namespace here including the digest cursor — so the accounting is itself
on a budget, and `SYNC_MS` / `SYNC_ROWS` / `MAX_DAILY_WRITES` are budget knobs,
not accuracy knobs. A flush-per-minute floor is 1,440 writes/day before the
second isolate is counted; replaying the 2026-09-30 runaway through it measured
1,403 writes at **one** isolate.

Two things bound that instead of tuning it:

- **`MAX_DAILY_WRITES` (50/isolate/day).** Account-wide cost becomes
  `50 x live isolates` rather than `1,440 x isolates`. After it is spent the
  isolate stops writing, keeps counting locally, and runs on the reduced ceiling.
- **Degraded mode fails *down*.** Cloudflare fails writes past the cap rather
  than queuing them, so once accounting is unavailable each isolate would
  otherwise read 0 from an unwritten key and grant itself the whole 4,000,000.
  An isolate that cannot read or persist the counter drops to
  `DEGRADED_LIMIT_FRACTION` (1/16 → 250,000) instead. Same replay, writes
  exhausted: 1 isolate 4,001,800 → **250,800** rows; 8 isolates → **2,006,400**,
  16 isolates → **4,012,800**, all inside the 5,000,000 platform cap.

  The divisor is the safety argument, not the numerator. With no shared state
  there is no account-wide number, only a per-isolate one, so the account total
  is `live isolates x reduced ceiling` — the only way to buy headroom is to
  shrink each slice. At 1/4 the same replay still spends **8,008,000 rows at
  eight isolates**, past the cap by nothing more than the isolate count; at
  1/16 it holds to sixteen. That sixteen is the honest limit of the design:
  nothing here can count the account, so removing the bound entirely needs
  shared state that is not eventually consistent (a Durable Object). It is also
  the price of blindness paid in throughput — 250,000 rows/day/isolate is ~113
  bridge requests — and it is unreachable in normal operation, because the
  reduced ceiling only engages after three consecutive flushes fail to advance
  the counter.

The price is cross-isolate accuracy: KV's read-then-write loses whatever
another isolate had pending, and cheap writes widen that window. The module
header carries the measured trade-off. Recording is also kept off the response
path — `recordDailyReads` is pinned with `ctx.waitUntil`, so a batch's 200
never waits on a KV write.

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
