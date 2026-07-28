-- Billing: credit ledger + Stripe event gate
--
-- Adds the Phase 1 (credit ledger) and Phase 2 (Stripe) schema on top of the
-- pre-billing schema. Generated with:
--
--   prisma migrate diff \
--     --from-schema-datamodel <prisma/schema.prisma @ 9d4e992> \
--     --to-schema-datamodel   <prisma/schema.prisma @ HEAD> \
--     --script
--
-- ...then hardened with IF NOT EXISTS guards. Every statement here is
-- idempotent: re-running is a no-op rather than an error. That matters
-- because this is the first migration in a database that was previously
-- managed by `prisma db push` (no migration history), so we can't assume
-- anything about what has or hasn't already been applied.
--
-- Purely additive — no DROP, no ALTER of an existing column's type, no data
-- rewrite. Existing rows get the DEFAULTs (free plan, 300 credits).

-- ---------------------------------------------------------------------------
-- Workspace: billing columns
-- ---------------------------------------------------------------------------
ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "planKey"              TEXT NOT NULL DEFAULT 'free',
  ADD COLUMN IF NOT EXISTS "planCredits"          INTEGER NOT NULL DEFAULT 300,
  ADD COLUMN IF NOT EXISTS "packCredits"          INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "billingStatus"        TEXT NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "periodStart"          TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "periodEnd"            TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "autoTopUp"            BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "stripeCustomerId"     TEXT,
  ADD COLUMN IF NOT EXISTS "stripeSubscriptionId" TEXT;

-- ---------------------------------------------------------------------------
-- CreditLedger: append-only audit trail for every credit grant/debit.
-- The live balance lives on Workspace (for atomic conditional UPDATEs);
-- this table explains how it got there. The [workspaceId, refId] unique
-- index doubles as the idempotency key — see src/lib/credits.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "CreditLedger" (
    "id"           TEXT NOT NULL,
    "workspaceId"  TEXT NOT NULL,
    "delta"        INTEGER NOT NULL,
    "bucket"       TEXT NOT NULL,
    "reason"       TEXT NOT NULL,
    "tool"         TEXT,
    "balanceAfter" INTEGER NOT NULL,
    "refId"        TEXT NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditLedger_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- StripeEvent: webhook idempotency gate, keyed on the Stripe event id.
-- Inserted in the same transaction as the event's mutation, so a duplicate
-- id rolls the whole thing back — see api/stripe/webhook.ts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS "StripeEvent" (
    "id"          TEXT NOT NULL,
    "type"        TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- ---------------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS "CreditLedger_workspaceId_createdAt_idx"
  ON "CreditLedger"("workspaceId", "createdAt");

CREATE UNIQUE INDEX IF NOT EXISTS "CreditLedger_workspaceId_refId_key"
  ON "CreditLedger"("workspaceId", "refId");

CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeCustomerId_key"
  ON "Workspace"("stripeCustomerId");

CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeSubscriptionId_key"
  ON "Workspace"("stripeSubscriptionId");

-- ---------------------------------------------------------------------------
-- Foreign key. ADD CONSTRAINT has no IF NOT EXISTS in Postgres, so guard it
-- by catalog lookup instead.
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CreditLedger_workspaceId_fkey'
  ) THEN
    ALTER TABLE "CreditLedger"
      ADD CONSTRAINT "CreditLedger_workspaceId_fkey"
      FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END
$$;
