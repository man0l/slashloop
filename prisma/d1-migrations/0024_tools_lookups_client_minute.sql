-- Per-client minute window for public tools lookups (SLA-1083): the 4th new
-- lookup from one client inside 60s is refused by counting its recent rows
-- (src/cf/tools-lookup.ts). The LOOKUP_RL binding is per-colo and approximate,
-- so it let a 4th lookup through in live acceptance.
--
-- Apply with: wrangler d1 migrations apply slashloop --remote
CREATE INDEX IF NOT EXISTS tools_lookups_client_created ON tools_lookups (client_hash, created_at);
