# Media Storage Plan

Persisting thumbnails and video binaries in **Supabase Storage** behind a
per-workspace retention setting (**default 3 days**), so the feed renders
reliably, re-analysis stops re-paying Apify, and the MCP App gallery (see the
Claude Desktop UI work) has a stable origin to load media from.

**TikTok only** — Reels and Shorts have no scraper. See §0.3; it constrains
every write path in Phase 1.

Companion to [`stripe-implementation-plan.md`](./stripe-implementation-plan.md).
Same repo, same deploy, same migration discipline.

---

## 0. What exists today

There is no media persistence at all. Nothing to migrate, no dual-read, no
backfill — this is net-new, which makes Phase 1 unusually cheap.

### 0.1 Thumbnails are other people's URLs

`Video.thumbnailUrl` stores a string pointing at the source CDN
(`src/normalizers.ts:77,106,142`):

| Platform | Source field | Durability | Reachable today |
|---|---|---|---|
| TikTok | `videoMeta.coverUrl` | Signed, expires in hours–days | **yes** |
| Reels | `imageVersions2.candidates[0].url` | Signed, expires | no — §0.3 |
| Shorts | `snippet.thumbnails.*.url` (`i.ytimg.com`) | Stable indefinitely | no — §0.3 |

Every image in the feed goes broken shortly after a scrape. Today nobody notices
because the output is a markdown table. The moment a gallery renders `<img>`
tags, it is the most visible bug in the product.

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

### 0.3 Scope: TikTok only — and Reels/Shorts rows are mock data

**This whole plan is TikTok-only.** Not a simplification for later expansion —
a correctness requirement, because the non-TikTok rows that exist today contain
fabricated URLs.

Four distinct levels of "not implemented", which matter differently:

1. **No scraper.** `scrapeSource` throws for `reels` and `shorts`
   (`src/lib/apify.ts:253-262`). `downloadTikTokVideo` is the only downloader.
2. **Unverified normalizers.** `normalizeReels` and `normalizeShorts`
   (`src/normalizers.ts:99,133`) are shape-guesses stacked with `||` fallbacks
   against payloads no scraper has ever produced. Their field paths have never
   been checked against a real response.
3. ~~**The seed inserts fake ones anyway.**~~ **Fixed.** `src/seed.ts` used to
   create reels and shorts *sources* plus videos with synthesized
   `instagram.com/reel/{randomId}` and `youtube.com/shorts/{randomId}` URLs.
   The seed is now TikTok-only. Note the thumbnails were always `placehold.co`
   URLs, not fake CDN links — so the storage-side hazard was storing meaningless
   placeholder images, not failed fetches. The `url` field was the dangerous one.
4. **Users can still create them.** `create_source` accepts all three platforms
   (`src/tools/sources.ts:84`) and only fails later, at refresh. This is why the
   `platform === 'tiktok'` gate in §1.7 stays required even with the seed
   cleaned up — a user-created reels source produces real rows with no scraper
   behind them.

**Budget leak this surfaced — fixed ahead of Phase 1.**
`analyzeVideoWithDownload` gated only on `backend === 'gemini-native' &&
video.url`, never on platform, so `analyze_video` on any reels/shorts row handed
an Instagram URL to the TikTok actor and spent the Apify pre-authorization
before failing inside the actor. Now gated on `video.platform === 'tiktok'`
(`src/analysis/index.ts:291`); non-TikTok videos fall through to `gemini-text`,
which is the correct backend for them anyway.

What TikTok-only buys, beyond avoiding the above: one cover-URL shape, one CDN,
one set of anti-hotlink headers (all three already proven by the existing video
download), and one `mediaKey` producer, so Phase 3's queue has a single job kind.

**When a real scraper lands**, the extension is: verify that platform's
normalizer against an actual payload, add the platform to the gate, and call the
same ingest hook from its persist loop. Storage will be the first thing that
genuinely exercises those normalizer field paths — expect to fix them then. The
design stays platform-agnostic where that's free: `{workspaceId}/{videoId}`
paths carry no platform, and `thumbStatus` means the same thing everywhere.

### 0.4 Supabase Storage has no lifecycle rules

The one thing to know before designing retention. S3 and R2 expire objects with
a bucket lifecycle policy; **Supabase does not expose one**. Objects accumulate
until something deletes them. Retention is a job we own — see §1.8.

---

## 1. Phase 1 — Supabase Storage, configurable retention, both assets

### 1.1 Why Supabase over R2 for this phase

Storage cost is a rounding error either way at this volume (80GB of MP4s is
~$1.70/mo on Supabase, ~$1.20 on R2). The real difference is egress: Supabase
meters it at ~$0.09/GB past the plan allowance, R2 charges nothing.

The **short retention window is what makes Supabase the right call now** — it
bounds the resident set and the traffic, which is precisely where Supabase is
weak against R2. At a 3-day default the resident set is roughly a tenth of what
the original 30-day design would hold, which pushes the R2 decision point out
correspondingly far. Against that, Supabase is already in the stack: same
project, same dashboard, credentials one env var away, and `storage.objects` is
a Postgres table the retention sweeper can query directly instead of paginating
an S3 API.

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
+ a few days' expiry keeps this defensible as research tooling.

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
MEDIA_SIGNED_URL_TTL_SECONDS=86400
CRON_SECRET=                      # guards /api/cron/* against public invocation

# Seed values for NEW workspaces only. Retention itself is a per-workspace
# setting (§1.4) — changing these does not touch existing rows.
THUMB_RETENTION_DAYS_DEFAULT=3
MEDIA_RETENTION_DAYS_DEFAULT=3
# Absolute server-side ceiling, above any plan's allowance. Backstop only.
RETENTION_DAYS_MAX=90
```

`SUPABASE_URL` already exists. `SUPABASE_ANON_KEY` is the browser key used by
the login page and must not be used here — Storage writes need the secret key.

### 1.4 Retention is a per-workspace setting

Two `Workspace` columns, surfaced through the existing settings tools rather
than hardcoded or env-driven:

```prisma
  /// Days to keep cover images before the sweeper deletes them. User-writable
  /// via update_settings, but clamped server-side to the plan ceiling — this
  /// is a COGS lever, see docs/stripe-implementation-plan.md §0.2.
  thumbRetentionDays   Int      @default(3)
  mediaRetentionDays   Int      @default(3)
```

**Why a column and not just an env var.** Retention drives storage and egress —
the same class of field as `monthlyBudgetCents`, and the Stripe plan's §0.2 is
explicit about what happens when a cost lever is user-writable and uncapped: one
`update_settings` call and the customer grants themselves unlimited COGS. So the
value is per-workspace (customers legitimately differ), writable, and **clamped
on write**:

```
effective = clamp(requested, 1, min(PLAN_RETENTION_MAX[planKey], RETENTION_DAYS_MAX))
```

Out-of-range requests are rejected with the ceiling named in the error, not
silently clamped — a user who asks for 365 and gets 3 should be told why.

Proposed plan ceilings, which also makes retention a real upgrade reason
consistent with [`pricing-research.md`](./pricing-research.md):

| Plan | Max retention days |
|---|---|
| `free` | 3 |
| `creator` | 14 |
| `pro` | 30 |

Flatten this to a single `RETENTION_DAYS_MAX` if you'd rather not tie it to
plans yet — the clamp is one function either way.

**Reads.** `get_settings` returns both values plus the effective ceiling, so a
client knows what it's allowed to ask for. `update_settings` gains
`thumbRetentionDays` / `mediaRetentionDays` as optional integers.

**Semantics of a change.** Lowering retention takes effect on the next sweep —
objects already past the new cutoff are deleted within 24h. Raising it does not
resurrect anything already deleted; it only extends the life of what's still
resident. Both worth stating in the tool description, because "I set it to 30,
where are my old thumbnails" is otherwise a support question.

### 1.5 `src/lib/storage.ts` — no new dependency

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

### 1.6 Schema

`prisma/schema.prisma` — purely additive. `model Workspace` gets the two
retention columns from §1.4; `model Video` gets the object keys:

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

### 1.7 Write paths

**Thumbnails — at scrape time.** In the persist loop in `src/tools/sources.ts:227-250`,
after `db.video.create`, fetch the cover and upload. Rules:

- **Pull from Apify, not from TikTok.** The scrape sets
  `shouldDownloadCovers: true`, so the actor copies each cover into its
  key-value store and lists the KV URL in `mediaUrls`. Those URLs are public,
  unsigned and not referer-gated, where `videoMeta.coverUrl` is TikTok's own
  CDN with a signed, short-lived URL that 403s bare requests. This mirrors what
  the video path already does — `downloadTikTokVideo` fetches the MP4 from the
  KV store, never from TikTok. `mediaUrls` can hold both the cover and the MP4
  with no guaranteed order, so pick by file extension, not by index.
- Keep the source CDN as a **fallback only**, with `User-Agent` + `Referer`
  spoofing, for when the actor returns no KV URL — `mediaUrls` is documented as
  sometimes empty. Log when this happens; a rising fallback rate means the
  actor input regressed.
- Fire ingests **concurrently in batches** (10 at a time) after the insert loop,
  not serially inside it. A 50-video refresh must not become 50 sequential
  round-trips inside a 60s function.
- **Never fail the refresh on a thumbnail miss.** Set `thumbStatus: 'failed'`
  and move on. Scrapes are the expensive thing; images are cosmetic.
- **Gate on `platform === 'tiktok'`** (§0.3). Still required after the seed
  cleanup, because `create_source` accepts reels/shorts and those rows have no
  scraper behind them. Non-TikTok rows keep `thumbStatus: 'none'` — not
  `'failed'`, because nothing was attempted. When Shorts eventually lands, keep
  it excluded on purpose: `i.ytimg.com` is stable and free to hotlink, so
  `thumbKey: null` + fallback to `thumbnailUrl` beats storing a copy.

**Video — on the analyze path.** In `analyzeVideoWithDownload`
(`src/analysis/index.ts:290-317`), after the size sanity check and before the
`finally` cleanup, upload the temp file to `media`. Phase 1 keeps the existing
buffer-to-tmpfile flow untouched; streaming is Phase 3. Upload failure logs and
continues — analysis has already succeeded by then and must not be lost.

The platform gate on that same download condition is **already in** — it shipped
ahead of this phase as a standalone bug fix (§0.3), so the upload lands inside a
block that only TikTok reaches.

### 1.8 Retention sweeper — the part Supabase doesn't give you

`api/cron/media-retention.ts`, daily at 03:00 UTC:

```json
"crons": [{ "path": "/api/cron/media-retention", "schedule": "0 3 * * *" }]
```

Because the cutoff is now per-workspace (§1.4), the sweep can't compare against
one constant — it joins through to the owning workspace and uses that row's
value:

```sql
SELECT v.id, v."mediaKey"
FROM "Video" v
JOIN "Source" s   ON s.id = v."sourceId"
JOIN "Workspace" w ON w.id = s."workspaceId"
WHERE v."mediaStatus" = 'stored'
  AND v."mediaStoredAt" < now() - (w."mediaRetentionDays" * INTERVAL '1 day')
ORDER BY v."mediaStoredAt"
LIMIT 1000;
```

Per run, per bucket:

1. Run the query above (`thumbStoredAt` / `thumbRetentionDays` for thumbs).
2. Bulk-delete those paths, grouped by workspace prefix.
3. `UPDATE` the rows to `mediaStatus: 'expired'`, `mediaKey: null`.
4. **Orphan sweep:** objects present in `storage.objects` with no matching
   `Video` row — from failed writes or deleted sources. Weekly is enough.

The `LIMIT 1000` means a backlog drains over several days rather than in one
run. That's fine at steady state, but the first sweep after someone *lowers*
their retention can have a large backlog — order by `mediaStoredAt` so the
oldest (and most certainly expired) go first, and let it catch up.

Vercel Cron over pg_cron + pg_net deliberately: the DB and the bucket must go
out of sync in one direction only (object deleted, then row updated), and a
Postgres function making REST calls can't roll that back coherently. It also
keeps retention logic in TypeScript next to the code that wrote the objects.

Guard the route with `CRON_SECRET` compared against the `Authorization` header —
a public endpoint that deletes media is not acceptable.

**Known consequence, sharper at 3 days than at 30.** A feed item older than the
window loses its image, and re-ingest usually fails because the original
TikTok/IG cover URL has expired too. At `thumbRetentionDays = 3` that means
**most of the feed renders as placeholders** — anything scraped earlier in the
week. The UI degrades gracefully via `thumbStatus = 'expired'`, so this is
survivable and correct for testing the pipeline, but it is not a shippable
default for a gallery.

The asymmetry is worth keeping in mind when you revisit it: thumbnails are ~60KB
and the cheapest thing in the system, while video is 2–30MB and carries the
storage cost, the egress, and the re-hosting exposure. They do not want the same
number. My expectation is you land near `thumb: 90+, media: 3–7` once the
gallery is real — which is exactly why this is a setting and not a constant.

### 1.9 Read path

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

### 1.10 Acceptance

- [ ] `refresh_source` on a TikTok source: every new row lands `thumbStatus='stored'` and a `thumbKey` that 200s publicly
- [ ] **Covers are fetched from `api.apify.com`, not from `*.tiktokcdn.com`** — check the egress, not just the outcome; the CDN fallback succeeds too and would mask a regression
- [ ] Confirm the real per-run Apify cost delta from `shouldDownloadCovers: true` against the pre-auth estimate in `scrapeTikTok`
- [ ] A refresh with the thumbs bucket misconfigured still persists videos and scores — `thumbStatus='failed'`, no thrown error
- [ ] **A user-created `reels` source's rows are never fetched** — all stay `thumbStatus='none'` (§0.3)
- [ ] `analyze_video` with `gemini-native`: `mediaKey` set, `mediaBytes` matches the logged download size, tmpdir still cleaned
- [ ] Retention endpoint deletes objects, nulls the keys, sets `expired` — verified by backdating `mediaStoredAt` past the workspace's 3 days
- [ ] Retention endpoint returns 401 without `CRON_SECRET`
- [ ] **Two workspaces with different `mediaRetentionDays` sweep at different cutoffs in the same run** — the per-workspace join is the one genuinely new failure mode
- [ ] `update_settings` with `thumbRetentionDays: 365` is rejected, error names the plan ceiling; `3` is accepted; `0` and negatives rejected
- [ ] `get_settings` reports both retention values and the effective ceiling
- [ ] Lowering retention then running the sweep deletes the newly-out-of-window objects
- [ ] `get_feed` returns a working `thumbUrl` for TikTok, `null` + `expired` after a sweep
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
cost was incurred. Re-running analysis inside the retention window becomes free.

**2.2 Reuse the Gemini upload.** The Files API keeps an upload ~48h and returns
a `fileUri` (`src/analysis/gemini-native.ts:74`), which is currently discarded.
Store `geminiFileUri` + `geminiFileExpiresAt` on `Analysis`; within 48h a
re-analysis needs no download at all, from any source.

**2.3 Schema-version reprocessing.** With 2.1 in place, a `schemaVersion` bump
becomes a batch job over stored media instead of a full re-scrape. Worth a
`reanalyze_stale` tool once v3 is real — out of scope until then.

**What a 3-day default does to this phase.** 2.1's window shrinks to ~3 days,
which is barely wider than 2.2's free 48h — so most of the Apify savings
collapse into the cheaper change, and 2.1 stops being worth much on its own.
2.3 stops working entirely: a `schemaVersion` bump lands weeks or months after
the scrape, by which point every MP4 is gone and it's a full re-scrape again.

None of that argues against 3 days for testing. It does mean **the retention
setting is the lever that decides whether Phase 2 is worth building** — pick the
`mediaRetentionDays` you actually want before scheduling 2.1, and if it stays at
3, ship 2.2 and skip the rest.

Ordering note: 2.2 is ~20 lines, independent of everything, and unaffected by
retention. Ship it first regardless.

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
CSP fields. If it works, `get_video` mints the signed URL on demand (§1.9).
If not, the card opens the source URL externally and nothing else changes.

---

## 5. Escape hatch — R2, if egress shows up on the bill

Supabase Storage is S3-compatible. Switching means: point the S3 credentials at
R2, reimplement the four functions in `src/lib/storage.ts` against R2's API,
change one CSP origin in §4.1, and re-point `publicUrl` at the R2 custom domain.
Stored objects need no mirroring at all — at a 3-day window you switch the write
path, wait out the retention period, and the old bucket is empty. The short
default that makes the gallery worse (§1.8) makes this migration free.

The retention sweeper gets *simpler*: R2 has native lifecycle rules, so §1.8
becomes a bucket setting and the cron job only reconciles DB columns.

Triggers to watch: Supabase egress past the plan allowance two months running,
or Phase 4.3 succeeding and video playback becoming a load-bearing feature.

---

## Sequencing

| Phase | Ships | Blocked by |
|---|---|---|
| 1 | Buckets, `src/lib/storage.ts`, migration, retention setting, both TikTok write paths, sweeper, feed read | — |
| 2.2 | Gemini `fileUri` reuse (~20 lines) | — |
| 2.1 | Skip Apify when `mediaKey` exists | 1 |
| 4 | Gallery reads Storage, playback spike | 1 |
| 3 | Streaming, then the job queue | 1 |
| 5 | R2, only if egress justifies it | 1 |

Phase 1 and 2.2 are independent and can land in either order. Everything else
waits on Phase 1's schema.
