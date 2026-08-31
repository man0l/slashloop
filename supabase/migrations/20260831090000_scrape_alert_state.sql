-- One-row incident marker for the scraping-failure email alert
-- (src/lib/scrape-alert.ts). notifiedAt IS NULL = armed: the next scrape
-- outage emails once. Setting notifiedAt opens the incident so repeat
-- failures stay silent; the first successful scrape re-arms by clearing it.
-- Raw SQL in scrape-alert.ts flips the column atomically
-- (UPDATE ... WHERE notified_at IS NULL), so two worker containers racing on
-- the same outage cannot both email.
CREATE TABLE IF NOT EXISTS "ScrapeAlertState" (
    "id" TEXT NOT NULL DEFAULT 'scrape',
    "notifiedAt" TIMESTAMPTZ,
    "lastError" TEXT,
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "ScrapeAlertState_pkey" PRIMARY KEY ("id")
);

INSERT INTO "ScrapeAlertState" ("id") VALUES ('scrape')
    ON CONFLICT ("id") DO NOTHING;
