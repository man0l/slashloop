-- Stripe test-mode customer/subscription ids
--
-- Live and test mode each have their own Customer/Subscription id space in
-- Stripe — a Customer created under a live secret key doesn't exist under a
-- test key (and vice versa). Workspace.stripeCustomerId /
-- stripeSubscriptionId were single columns shared across modes, so flipping
-- STRIPE_MODE=test on a workspace that already has a live customer sent
-- "No such customer" back from Stripe (a live id used with a test key).
--
-- Adds the mirrored test-mode columns; api/billing/checkout.ts and
-- api/billing/portal.ts now read/write whichever pair matches the active
-- STRIPE_MODE (src/lib/stripe.ts customerIdField()/subscriptionIdField()).
-- Purely additive, idempotent — safe to re-run.
ALTER TABLE "Workspace"
  ADD COLUMN IF NOT EXISTS "stripeTestCustomerId"     TEXT,
  ADD COLUMN IF NOT EXISTS "stripeTestSubscriptionId" TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeTestCustomerId_key"
  ON "Workspace"("stripeTestCustomerId");

CREATE UNIQUE INDEX IF NOT EXISTS "Workspace_stripeTestSubscriptionId_key"
  ON "Workspace"("stripeTestSubscriptionId");
