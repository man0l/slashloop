-- Media storage: create the two buckets
--
-- Companion to 20260728120000_media_storage.sql, which added the DB columns.
-- This provisions the buckets themselves so the setup is tracked in git and
-- applied on merge, rather than clicked into the dashboard where it can drift
-- between environments.
--
--   thumbs  PUBLIC   cover images. Public so Supabase's CDN can cache them and
--                    so get_feed can resolve N URLs without N round-trips — a
--                    signed URL's per-call token defeats both.
--   media   PRIVATE  MP4s. Reached only through short-lived signed URLs minted
--                    server-side. Never a public mirror of other people's video.
--
-- On RLS: storage.objects has RLS enabled by default and we deliberately add
-- NO policies. The service/secret key bypasses RLS, so server-side writes work;
-- anon and authenticated get nothing, which is exactly right — no browser talks
-- to these buckets directly. Public reads on `thumbs` go through the public
-- object endpoint, which does not consult RLS. If someone later adds a
-- permissive policy on storage.objects, `bun run verify:media` will flag it.
--
-- Permissions caveat: storage.buckets is owned by supabase_storage_admin. The
-- migration runner usually has rights to write it, but not on every project
-- configuration — so a failure here is caught and downgraded to a NOTICE
-- rather than failing the migration and blocking an otherwise good deploy.
-- Verify with `bun run verify:media`; if the buckets are missing, create them
-- in the dashboard with the same settings.

DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'thumbs', 'thumbs', true,
    5242880,  -- 5MiB; covers are ~60KB, this is a sanity ceiling
    ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
  )
  ON CONFLICT (id) DO UPDATE SET
    public             = EXCLUDED.public,
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'media', 'media', false,
    104857600,  -- 100MiB; the default 50MiB 413s on longer video
    ARRAY['video/mp4']
  )
  ON CONFLICT (id) DO UPDATE SET
    public             = EXCLUDED.public,
    file_size_limit    = EXCLUDED.file_size_limit,
    allowed_mime_types = EXCLUDED.allowed_mime_types;

  RAISE NOTICE 'media storage buckets provisioned (thumbs public, media private)';
EXCEPTION
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'skipped bucket creation: no privileges on storage.buckets. Create `thumbs` (public) and `media` (private, 100MiB) in the dashboard, then run: bun run verify:media';
  WHEN undefined_table THEN
    RAISE NOTICE 'skipped bucket creation: storage schema not present in this database';
END $$;
