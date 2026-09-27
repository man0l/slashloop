-- ===========================================================================
-- SLA-14 Phase 1: PG queue foundation — 001 initial schema.
--
-- Purpose-built Postgres queue (plan rev 4 of SLA-10). Application-owned
-- schema using FOR UPDATE SKIP LOCKED — NOT pg-boss, NOT pgmq.
--
-- Apply: psql "$QUEUE_DATABASE_URL" -f 001_queue_foundation.sql
-- Rehearse restore: pg_dump -Fc queue | pg_restore into a fresh container,
-- then re-run this file (all statements are IF NOT EXISTS / idempotent).
-- ===========================================================================

-- gen_random_uuid() is built in since Postgres 13; queue-db is Postgres 17.
-- No extensions required (deliberate: no pgmq/pg_cron dependency in Phase 1).

-- ---------------------------------------------------------------------------
-- Queue jobs — the single source of truth for PG-owned queue state.
-- D1 remains the domain system of record; this table owns queued/running
-- timing, leases, attempts, cancellation, and terminal queue state.
-- Status vocabulary mirrors D1 (`done`, not `completed`) for compatibility.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queue_jobs (
  job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Idempotent publish key. Required for externally enqueued jobs
  -- (e.g. `analyze:video:<id>`, `refresh:source:<id>`, `d1:<mediaJobId>`
  -- for D1 fallback reconciliation). NULL allowed for internal rows;
  -- Postgres treats NULLs as distinct under UNIQUE.
  dedupe_key text UNIQUE,
  kind text NOT NULL,
  state text NOT NULL DEFAULT 'queued',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 3,
  claimed_by text,
  lease_expires_at timestamptz,
  workspace_id text NOT NULL,
  video_id text,
  source_id text,
  payload jsonb NOT NULL DEFAULT '{}',
  result jsonb,
  -- Billing identity: minted ONCE at enqueue, fixed across retries and
  -- transport fallback. Refunds are idempotent by op_id (see pg.ts).
  op_id text,
  pre_auth_credits int,
  deadline_at timestamptz,
  analysis_id text,
  available_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  last_error text,
  -- Queued cancellation: producer asks, worker never claims afterwards.
  cancel_requested_at timestamptz,
  -- D1 compatibility projection linkage (Phase 2+). NULL until a kind moves.
  d1_synced_at timestamptz,
  d1_job_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT queue_jobs_kind_ck CHECK (kind IN
    ('fetch','analyze','recreate','thumb','discover','rescore','refresh')),
  CONSTRAINT queue_jobs_state_ck CHECK (state IN
    ('queued','running','done','failed','cancelled'))
);

-- Claim path: WHERE state='queued' AND kind IN (...) with kind-position
-- ordering, then created_at, then job_id.
CREATE INDEX IF NOT EXISTS queue_jobs_claim_idx
  ON queue_jobs (kind, created_at, job_id)
  WHERE state = 'queued';

-- Claim path also filters available_at <= now(); this keeps the scan bounded
-- when many rows sit in backoff/yield cooldown.
CREATE INDEX IF NOT EXISTS queue_jobs_available_idx
  ON queue_jobs (available_at)
  WHERE state = 'queued';

-- Lease recovery sweep: WHERE state='running' AND lease_expires_at < now().
CREATE INDEX IF NOT EXISTS queue_jobs_running_lease_idx
  ON queue_jobs (lease_expires_at, job_id)
  WHERE state = 'running';

-- Target lookups (outstanding-job checks, reconciliation, UI pairing).
CREATE INDEX IF NOT EXISTS queue_jobs_target_state_idx
  ON queue_jobs (workspace_id, video_id, source_id, state);

-- One-time refund correlation.
CREATE INDEX IF NOT EXISTS queue_jobs_op_id_idx
  ON queue_jobs (op_id)
  WHERE op_id IS NOT NULL;

-- D1 fallback reconciliation linkage.
CREATE INDEX IF NOT EXISTS queue_jobs_d1_job_id_idx
  ON queue_jobs (d1_job_id)
  WHERE d1_job_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Producer replay nonces — one row per signed request. Inserted atomically
-- with enqueue; a duplicate (key_id, nonce) is a 409 replay_detected.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS producer_nonces (
  key_id text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, nonce)
);

CREATE INDEX IF NOT EXISTS producer_nonces_expiry_idx ON producer_nonces (expires_at);

-- ---------------------------------------------------------------------------
-- Producer keys — HMAC secrets with rotation state. Exactly two usable keys
-- during rotation: `active` (signs new requests) + `retiring` (verifies only).
-- `secret` holds the raw HMAC secret; readable only by the queue-api role.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS producer_keys (
  key_id text PRIMARY KEY,
  secret text NOT NULL,
  state text NOT NULL CHECK (state IN ('active','retiring','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  rotated_at timestamptz
);

-- ---------------------------------------------------------------------------
-- Canonical scrape locks — one Apify run per canonical query across workers.
-- TTL row (NOT pg_advisory_lock: poolers in transaction mode can strand
-- session-level locks). Same database so refresh cutover is atomic.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS canonical_scrape_locks (
  canonical_key text PRIMARY KEY,
  holder_id text NOT NULL,
  lease_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Bounded operational job logs. Container logs stay the primary console
-- source; this table keeps per-job events queryable without duplicating
-- verbose diagnostics into D1.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS queue_job_logs (
  log_id bigserial PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES queue_jobs(job_id) ON DELETE CASCADE,
  worker_id text,
  level text NOT NULL,
  event text NOT NULL,
  detail jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS queue_job_logs_job_idx ON queue_job_logs (job_id, log_id);
CREATE INDEX IF NOT EXISTS queue_job_logs_created_idx ON queue_job_logs (created_at);

-- ---------------------------------------------------------------------------
-- Retention: 14d done / 30d failed / 7d cancelled / expired nonces.
-- Run from the queue-api maintenance tick or a scheduled job; bounded deletes
-- (LIMIT) so one pass never holds a long write lock on a hot table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION queue_prune_retention(batch_limit int DEFAULT 1000)
RETURNS TABLE (pruned_jobs int, pruned_nonces int, pruned_logs int) AS $$
DECLARE
  v_jobs int := 0;
  v_nonces int := 0;
  v_logs int := 0;
BEGIN
  WITH dead AS (
    SELECT job_id FROM queue_jobs
     WHERE (state = 'done' AND finished_at < now() - make_interval(days => 14))
        OR (state = 'failed' AND finished_at < now() - make_interval(days => 30))
        OR (state = 'cancelled' AND finished_at < now() - make_interval(days => 7))
     ORDER BY finished_at
     LIMIT batch_limit
  )
  DELETE FROM queue_jobs q USING dead WHERE q.job_id = dead.job_id;
  GET DIAGNOSTICS v_jobs = ROW_COUNT;

  DELETE FROM producer_nonces WHERE expires_at < now();
  GET DIAGNOSTICS v_nonces = ROW_COUNT;

  -- Orphan-guard: logs for already-pruned jobs (CASCADE normally handles it).
  DELETE FROM queue_job_logs l WHERE NOT EXISTS
    (SELECT 1 FROM queue_jobs q WHERE q.job_id = l.job_id)
    AND l.created_at < now() - make_interval(days => 30);
  GET DIAGNOSTICS v_logs = ROW_COUNT;

  RETURN QUERY SELECT v_jobs, v_nonces, v_logs;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Least-privilege roles (plan rev 4 §VPS deployment).
--
--   queue_api    — producer path: insert/read/cancel jobs, nonces, read keys.
--   queue_worker — claim/read/update jobs, leases, locks, append logs.
--   queue_admin  — migrations, DDL, retention, backups (owner of objects).
--
-- If role separation costs too much initially, run everything on one runtime
-- role + queue_admin and document the exception (see Phase 0 baseline doc).
-- This block is safe to re-run and skips grants when the roles do not exist
-- yet (e.g. fresh restore before role creation).
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'queue_api') THEN
    GRANT SELECT, INSERT ON queue_jobs TO queue_api;
    GRANT UPDATE (state, cancel_requested_at, updated_at) ON queue_jobs TO queue_api;
    GRANT SELECT, INSERT, DELETE ON producer_nonces TO queue_api;
    GRANT SELECT ON producer_keys TO queue_api;
    GRANT USAGE, SELECT ON SEQUENCE queue_job_logs_log_id_seq TO queue_api;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'queue_worker') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE ON queue_jobs TO queue_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON canonical_scrape_locks TO queue_worker;
    GRANT SELECT, INSERT ON queue_job_logs TO queue_worker;
    GRANT USAGE, SELECT ON SEQUENCE queue_job_logs_log_id_seq TO queue_worker;
    GRANT SELECT ON producer_keys TO queue_worker;
  END IF;
END
$$;
