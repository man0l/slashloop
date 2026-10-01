---
name: slashloop-refresh
description: Refresh named Slashloop sources, source IDs, or all active sources after explicit spend confirmation. Live scraping; the successful refresh renders its scoped gallery.
---

# Slashloop refresh

Inputs:

- `workspace`: workspace ID or exact workspace name. **Required.** If absent,
  stop and ask for it.
- `sources`: one or more source IDs/names, or `all`. **Required.** No stalest
  source is selected implicitly.
- `videoLimit`: optional hard cap for this run.
- `maxCredits`: required for `all` and for multi-source batches.

Resolve `workspace` exactly as `slashloop-sources` does, and pass its ID as
`workspaceId`. This skill performs refreshes only; it does not present a source
catalog as its output. It may call `list_sources` solely to resolve names.

## Safety gate

Before any scrape, call `get_apify_spend_status`. Present each planned source
and its worst-case `videoLimit * 1.5` credit estimate; note that an established
source normally uses the smaller incremental page (often ≤5) unless the user
sets `videoLimit`. Get an explicit user approval for the exact batch and credit
ceiling. Treat a last refresh job still queued/running as outstanding and skip
that source rather than double-paying.

## Named sources or IDs

For each confirmed source, call `refresh_source` with the resolved
`workspaceId` and `sourceId`, plus `videoLimit` only if the user supplied one.
Keep the default queued mode. When a `jobId` returns, call `await_job`; repeat
only while `shouldKeepPolling` is true, never more than 12 times. Do not start a
duplicate job after `already_queued`.

After a successful refresh with content, call `show_gallery` with the same
`workspaceId` and `sourceId`; surface `galleryUrl` if the UI does not render.

## All active sources

Call `list_sources` with `isActive=true`, then build a plan containing every
active source (including already-refreshed manual sources), excluding sources
with outstanding jobs. Show that batch plan and `maxCredits`; after approval,
run the confirmed sources with `refresh_source` as above. Stop when the next
source would exceed `maxCredits` or the Apify cap. Do not substitute
`refresh_due_sources`: it omits already-refreshed manual sources.
