-- Public tools lookups (SLA-1056): one row per slashloop.dev/tools live lookup.
-- Raw SQL only (src/cf/tools-lookup.ts); not a Prisma model. The result JSON
-- lives on the row so the status poll never depends on KV propagation.
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
CREATE TABLE IF NOT EXISTS tools_lookups (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  subject TEXT NOT NULL,
  status TEXT NOT NULL,
  result_json TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  client_hash TEXT
);

CREATE INDEX IF NOT EXISTS tools_lookups_kind_subject_created ON tools_lookups (kind, subject, created_at);
