-- Canonical scrape lease — one Apify run per (platform, sourceType, query)
-- across every worker container.
--
-- WORKER_KINDS lets several containers drain `refresh`. FOR UPDATE SKIP LOCKED
-- stops two of them claiming the same MediaJob, but two containers could still
-- lead batches for the same canonical query at the same instant: two Apify runs
-- for @foo, which is the exact spend multi-tenant batching exists to remove.
--
-- Why a row and not pg_advisory_lock: the workers connect through the Supabase
-- pooler in transaction pooling mode, where the backend that took a
-- session-level advisory lock is returned to the pool after the statement. The
-- matching unlock can land on a different backend and the lock leaks for the
-- life of the process. A row with an expiry needs no session affinity and
-- self-heals if a worker is SIGKILLed mid-batch (redeploy).
--
-- This table is also the seed of the Phase B CanonicalScrape lease: the result
-- cache columns (apifyRunId, resultJson, planJson) land here later.

CREATE TABLE IF NOT EXISTS "CanonicalScrapeLock" (
  "key"       TEXT        PRIMARY KEY,
  "lockedBy"  TEXT        NOT NULL,
  "lockedAt"  TIMESTAMPTZ NOT NULL DEFAULT now(),
  "expiresAt" TIMESTAMPTZ NOT NULL
);

-- Sweep support: expired leases are stolen in place by the acquire upsert, but
-- a periodic delete keeps the table from holding rows for retired queries.
CREATE INDEX IF NOT EXISTS "CanonicalScrapeLock_expiresAt_idx"
    ON "CanonicalScrapeLock" ("expiresAt");

-- Service-role only. This table holds no workspace data and must never be
-- readable from a client session.
ALTER TABLE "CanonicalScrapeLock" ENABLE ROW LEVEL SECURITY;
