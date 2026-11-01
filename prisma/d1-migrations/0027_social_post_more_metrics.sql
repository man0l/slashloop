-- Platform-specific post counters beyond views/likes/comments/shares
-- (SLA-1199 follow-up). NULL = the platform does not report that counter:
--   saves   — Instagram "saved", Pinterest "save"
--   reposts — Threads reposts
--   quotes  — Threads quote posts
--   reach   — Instagram unique accounts reached
--   clicks  — Pinterest outbound (link) clicks
-- Existing synced rows pick these up on their next scheduled sync.
ALTER TABLE social_posts ADD COLUMN saves INTEGER;
ALTER TABLE social_posts ADD COLUMN reposts INTEGER;
ALTER TABLE social_posts ADD COLUMN quotes INTEGER;
ALTER TABLE social_posts ADD COLUMN reach INTEGER;
ALTER TABLE social_posts ADD COLUMN clicks INTEGER;

-- Pinterest saves were stored as shares by 0026's first syncs; move them.
UPDATE social_posts SET saves = shares, shares = NULL WHERE provider = 'pinterest' AND shares IS NOT NULL;
