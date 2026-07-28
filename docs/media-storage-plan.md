# Media Storage Plan

Persisting thumbnails and video binaries in **Supabase Storage** with a 30-day
retention window, so the feed renders reliably, re-analysis stops re-paying
Apify, and the MCP App gallery (see the Claude Desktop UI work) has a stable
origin to load media from.

Companion to [`stripe-implementation-plan.md`](./stripe-implementation-plan.md).
Same repo, same deploy, same migration discipline.

---

## 0. What exists today

There is no media persistence at all. Nothing to migrate, no dual-read, no
backfill — this is net-new, which makes Phase 1 unusually cheap.

### 0.1 Thumbnails are other people's URLs

`Video.thumbnailUrl` stores a string pointing at the source CDN
(`src/normalizers.ts:77,106,142`):

| Platform | Source field | Durability |
|---|---|---|
| TikTok | `videoMeta.coverUrl` | Signed, expires in hours–days |
| Reels | `imageVersions2.candidates[0].url` | Signed, expires |
| Shorts | `snippet.thumbnails.*.url` (`i.ytimg.com`) | Stable indefinitely |

Two-thirds of the feed goes to broken images shortly after a scrape. Today
nobody notices because the output is a markdown table. The moment a gallery
renders `<img>` tags, it is the most visible bug in the product.

### 0.2 Video binaries are a temp handle, not storage

`analyzeVideoWithDownload` (`src/analysis/index.ts:290-317`) mkdtemps into
`os.tmpdir()`, `downloadTikTokVideo` buffers the whole MP4 in memory and writes
it (`src/lib/apify.ts:225-232`), Gemini's Files API gets it
(`src/analysis/gemini-native.ts:55-75`), and a `finally` block deletes both file
and directory (`src/analysis/index.ts:324-327`).

The Apify key-value-store URL that `downloadTikTokVideo` fetches from is a
per-run artifact. Apify garbage-collects unnamed run storages on a
plan-dependent schedule, so it is not a URL worth storing.

Consequence: **every re-analysis pays Apify again.** With
`Analysis.schemaVersion` already at `"v2"`, the first schema bump re-scrapes the
entire corpus — and any video deleted from TikTok in the interim is
unrecoverable.

### 0.3 Supabase Storage has no lifecycle rules

The one thing to know before designing retention. S3 and R2 expire objects with
a bucket lifecycle policy; **Supabase does not expose one**. Objects accumulate
until something deletes them. Retention is a job we own — see §1.7.

---

## 1. Phase 1 — Supabase Storage, 30-day retention, both assets

### 1.1 Why Supabase over R2 for this phase

Storage cost is a rounding error either way at this volume (80GB of MP4s is
~$1.70/mo on Supabase, ~$1.20 on R2). The real difference is egress: Supabase
meters it at ~$0.09/GB past the plan allowance, R2 charges nothing.

The **30-day window is what makes Supabase the right call now** — it bounds the
resident set and the traffic, which is precisely where Supabase is weak against
R2. Against that, Supabase is already in the stack: same project, same dashboard,
credentials one env var away, and `storage.objects` is a Postgres table the
retention sweeper can query directly instead of paginating an S3 API.

If egress ever shows up on the bill, §5 is the escape hatch and it touches one
file.

### 1.2 Buckets

Two buckets, different postures:

| Bucket | Visibility | Contents | Path |
|---|---|---|---|
| `thumbs` | **public** | cover images, ~60KB | `{workspaceId}/{videoId}.jpg` |
| `media` | **private** | MP4s, 2–30MB | `{workspaceId}/{videoId}.mp4` |

Thumbnails go public deliberately: they are low-risk, they are requested on
every feed render, and public objects are cached by Supabase's CDN. Signed URLs
carry a unique token per call, which defeats CDN caching and sends every
thumbnail request to origin — exactly the egress we are trying not to pay.

Video stays private and is reached only through short-lived signed URLs. Serving
a public, permanent mirror of other people's copyrighted video is a materially
different posture from linking to tiktok.com; private + signed + workspace-scoped
+ 30-day expiry keeps this defensible as research tooling.

Set an explicit per-bucket file size limit (`media`: 100MB) — the default is
50MB and a long Reel will 413 without a clear error.

RLS on `storage.objects`: deny all direct client access. Every write is
server-side with the secret key; every private read is a signed URL.

### 1.3 Env

```bash
# ---- Media storage (Supabase Storage) ----
SUPABASE_SECRET_KEY=              # sb_secret_... — server-side only, NEVER shipped to a client
STORAGE_THUMB_BUCKET=thumbs
STORAGE_MEDIA_BUCKET=media
THUMB_RETENTION_DAYS=30
MEDIA_RETENTION_DAYS=30
MEDIA_SIGNED_URL_TTL_SECONDS=86400
CRON_SECRET=                      # guards /api/cron/* against public invocation
```

`SUPABASE_URL` already exists. `SUPABASE_ANON_KEY` is the browser key used by
the login page and must not be used here — Storage writes need the secret key.

### 1.4 `src/lib/storage.ts` — no new dependency

The repo has no `@supabase/supabase-js`, and doesn't need one. Storage is a REST
API and the codebase already hand-rolls `fetch` clients for Apify and Gemini.
Adding the SDK to a Vercel function bundle to make four HTTP calls is not worth
it.

```ts
export async function putObject(opts: {
  bucket: string; path: string; body: Uint8Array | ReadableStream;
  contentType: string; upsert?: boolean;
}): Promise<{ path: string; sizeBytes: number }>;

// Public bucket -> permanent URL. No round-trip.
export function publicUrl(bucket: string, path: string): string;

// Private bucket -> POST /storage/v1/object/sign/{bucket}/{path}
export async function signUrl(bucket: string, path: string, ttlSeconds: number): Promise<string>;

export async function deleteObjects(bucket: string, paths: string[]): Promise<void>;
```

Endpoints: `POST /storage/v1/object/{bucket}/{path}` (add `x-upsert: true` to
overwrite), `POST /storage/v1/object/sign/{bucket}/{path}` with
`{"expiresIn": n}`, `DELETE /storage/v1/object/{bucket}` with
`{"prefixes": [...]}` for bulk. All with `Authorization: Bearer $SUPABASE_SECRET_KEY`.

This module is the entire vendor surface. §5 replaces it and nothing else.

### 1.5 Schema

`prisma/schema.prisma`, `model Video` — purely additive:

```prisma
  thumbnailUrl     String    @default("")     // unchanged: original source URL, provenance
  thumbKey         String?                     // thumbs bucket path once ingested
  thumbStatus      String    @default("none")  // none | stored | expired | failed
  thumbStoredAt    DateTime?
  mediaKey         String?                     // media bucket path
  mediaStatus      String    @default("none")  // none | stored | expired | failed
  mediaBytes       Int?
  mediaStoredAt    DateTime?

  @@index([thumbStatus])
  @@index([mediaStoredAt])
```

Keep `thumbnailUrl` — it is the only way to re-ingest, and it costs nothing.

Migration: `supabase/migrations/<ts>_media_storage.sql`, generated with
`prisma migrate diff` and hardened with `ADD COLUMN IF NOT EXISTS`, same as the
billing migration. Additive only, no backfill.

### 1.6 Write paths

**Thumbnails — at scrape time.** In the persist loop in `src/tools/sources.ts:227-250`,
after `db.video.create`, fetch the cover and upload. Rules:

- Send `User-Agent` + `Referer: https://www.tiktok.com/` — TikTok's CDN 403s
  bare requests, same as the video download already does (`src/lib/apify.ts:212-217`).
- Fire ingests **concurrently in batches** (10 at a time) after the insert loop,
  not serially inside it. A 50-video refresh must not become 50 sequential
  round-trips inside a 60s function.
- **Never fail the refresh on a thumbnail miss.** Set `thumbStatus: 'failed'`
  and move on. Scrapes are the expensive thing; images are cosmetic.
- Skip YouTube. `i.ytimg.com` is stable and free to hotlink — store `thumbKey:
  null`, let the feed fall back to `thumbnailUrl`. Saves a third of the writes.

**Video — on the analyze path.** In `analyzeVideoWithDownload`
(`src/analysis/index.ts:290-317`), after the size sanity check and before the
`finally` cleanup, upload the temp file to `media`. Phase 1 keeps the existing
buffer-to-tmpfile flow untouched; streaming is Phase 3. Upload failure logs and
continues — analysis has already succeeded by then and must not be lost.

### 1.7 Retention sweeper — the part Supabase doesn't give you

`api/cron/media-retention.ts`, daily at 03:00 UTC:

```json
"crons": [{ "path": "/api/cron/media-retention", "schedule": "0 3 * * *" }]
```

Per run, per bucket:

1. `SELECT` videos where `mediaStoredAt < now() - MEDIA_RETENTION_DAYS` and
   `mediaStatus = 'stored'`, cap at 1000 per run.
2. Bulk-delete those paths.
3. `UPDATE` the rows to `mediaStatus: 'expired'`, `mediaKey: null`.
4. Same for thumbs against `THUMB_RETENTION_DAYS`.
5. **Orphan sweep:** objects present in `storage.objects` with no matching
   `Video` row — from failed writes or deleted sources. Weekly is enough.

Vercel Cron over pg_cron + pg_net deliberately: the DB and the bucket must go
out of sync in one direction only (object deleted, then row updated), and a
Postgres function making REST calls can't roll that back coherently. It also
keeps retention logic in TypeScript next to the code that wrote the objects.

Guard the route with `CRON_SECRET` compared against the `Authorization` header —
a public endpoint that deletes media is not acceptable.

**Known consequence of 30-day thumbnails:** feed items older than 30 days lose
their image. Re-ingest usually fails too, because the original TikTok/IG cover
URL has expired by then. The UI degrades to a placeholder card driven by
`thumbStatus = 'expired'` — deliberate, not a bug. If the gallery ends up
looking thin, `THUMB_RETENTION_DAYS=365` is a one-variable change and costs
~$0.02/mo per 10k thumbnails. Video retention should stay at 30.

### 1.8 Read path

`get_feed` (`src/tools/feed.ts:96`) and `get_video` (`src/tools/video.ts:54`)
resolve in order:

```
thumbKey ? publicUrl(thumbs, thumbKey) : thumbnailUrl || null
```

`publicUrl` is string concatenation — no round-trip, no added latency in the
tool call. Emit both `thumbUrl` (resolved, what the UI renders) and
`thumbStatus` (so the UI can show a placeholder rather than a broken image).

Video signed URLs are **not** minted in `get_feed`. They cost a round-trip each
and nothing in the current output plays video. Add them in Phase 4, on demand,
for the single video being opened.

### 1.9 Acceptance

- [ ] `refresh_source` on a TikTok source: every new row lands `thumbStatus='stored'` and a `thumbKey` that 200s publicly
- [ ] A refresh with the thumbs bucket misconfigured still persists videos and scores — `thumbStatus='failed'`, no thrown error
- [ ] `analyze_video` with `gemini-native`: `mediaKey` set, `mediaBytes` matches the logged download size, tmpdir still cleaned
- [ ] Retention endpoint deletes objects, nulls the keys, sets `expired` — verified by backdating `mediaStoredAt`
- [ ] Retention endpoint returns 401 without `CRON_SECRET`
- [ ] `get_feed` returns a working `thumbUrl` for TikTok, falls back to `i.ytimg.com` for Shorts, `null` + `expired` after a sweep
- [ ] Cold `bun run remote:dev` with no storage env vars set: everything still works, all statuses `none`

That last one matters — Phase 1 must be **additive and skippable**. If
`SUPABASE_SECRET_KEY` is absent, `src/lib/storage.ts` no-ops and the server
behaves exactly as it does today. That's the rollback: unset one variable.

---

## 2. Phase 2 — Stop re-paying Apify for re-analysis

Phase 1 is what makes this possible; this is where it starts paying.

**2.1 Reuse the stored MP4.** `analyzeVideoWithDownload` checks `mediaKey`
before calling Apify. On hit: sign a URL, download from Supabase, skip the actor
call entirely — and skip `recordApifySpend`/`assertApifyCap`, because no Apify
cost was incurred. Re-running analysis inside the 30-day window becomes free.

**2.2 Reuse the Gemini upload.** The Files API keeps an upload ~48h and returns
a `fileUri` (`src/analysis/gemini-native.ts:74`), which is currently discarded.
Store `geminiFileUri` + `geminiFileExpiresAt` on `Analysis`; within 48h a
re-analysis needs no download at all, from any source.

**2.3 Schema-version reprocessing.** With 2.1 in place, a `schemaVersion` bump
becomes a batch job over stored media instead of a full re-scrape. Worth a
`reanalyze_stale` tool once v3 is real — out of scope until then.

Ordering note: 2.2 is ~20 lines and independent of everything. Ship it first.

---

## 3. Phase 3 — Get media off the request path

`api/mcp.ts` has `maxDuration: 60`. A single `analyze_video` currently spends
that budget on: Apify actor run (sync, seconds to a minute) → full MP4 into
function memory → disk → multipart upload to Gemini → poll for `ACTIVE` →
`generateContent`. It works for 30-second TikToks and will not survive longer
video or a slow actor.

**3.1 Stream instead of buffering.** `downloadTikTokVideo` does
`Buffer.from(await res.arrayBuffer())` (`src/lib/apify.ts:225-226`) — the whole
file in memory. Pipe the response body straight into `putObject`, then read back
from Supabase for the Gemini upload. Removes the memory ceiling and the tmpdir.

**3.2 Hand Gemini a URL.** `uploadFileToGemini` reads the file into a `Blob` and
posts multipart. Once the MP4 is in Supabase, a signed URL can replace the
byte-for-byte re-upload — one fewer full transfer of the file through the
function.

**3.3 Queue it.** A `MediaJob` table (`videoId`, `kind`, `status`, `attempts`,
`lastError`). `analyze_video` enqueues and returns immediately with a job id; a
Vercel Cron worker drains the queue; `get_video` reports job status. This is
also what makes bulk `run_auto_analyze` safe — today it is N sequential
downloads inside one invocation.

3.3 is the real fix and the biggest change. 3.1 and 3.2 are worth doing on their
own if the queue slips.

---

## 4. Phase 4 — Wire the MCP App gallery to Storage

Depends on Phase 1 only.

**4.1 CSP.** The `ui://` resource declares
`_meta.ui.csp.resourceDomains: ["https://<project>.supabase.co"]`. One origin
covers both buckets, images and video.

**4.2 Resized thumbnails.** Supabase's image transformation endpoint
(`/storage/v1/render/image/public/{bucket}/{path}?width=400&resize=cover`,
Pro plan) serves a 400px WebP instead of a full-res cover. On a 20-card
carousel that is roughly an order of magnitude less egress — the single biggest
lever on the Supabase-vs-R2 cost gap.

**4.3 Spike inline playback.** `resourceDomains` maps to `media-src` as well as
`img-src`, so `<video src="<signed supabase url>">` *should* play inside the
conversation — the only route to real playback, since Claude blocks
`frameDomains` and a TikTok embed is therefore impossible. Verify before
designing UI around it: the Claude host has a track record of dropping declared
CSP fields. If it works, `get_video` mints the signed URL on demand (§1.8).
If not, the card opens the source URL externally and nothing else changes.

---

## 5. Escape hatch — R2, if egress shows up on the bill

Supabase Storage is S3-compatible. Switching means: point the S3 credentials at
R2, reimplement the four functions in `src/lib/storage.ts` against R2's API,
change one CSP origin in §4.1, and re-point `publicUrl` at the R2 custom domain.
Stored objects can be mirrored with `rclone` or simply left to expire — the
30-day window means a no-op migration if you just switch the write path and wait
a month.

The retention sweeper gets *simpler*: R2 has native lifecycle rules, so §1.7
becomes a bucket setting and the cron job only reconciles DB columns.

Triggers to watch: Supabase egress past the plan allowance two months running,
or Phase 4.3 succeeding and video playback becoming a load-bearing feature.

---

## Sequencing

| Phase | Ships | Blocked by |
|---|---|---|
| 1 | Buckets, `src/lib/storage.ts`, migration, both write paths, sweeper, feed read | — |
| 2.2 | Gemini `fileUri` reuse (~20 lines) | — |
| 2.1 | Skip Apify when `mediaKey` exists | 1 |
| 4 | Gallery reads Storage, playback spike | 1 |
| 3 | Streaming, then the job queue | 1 |
| 5 | R2, only if egress justifies it | 1 |

Phase 1 and 2.2 are independent and can land in either order. Everything else
waits on Phase 1's schema.
