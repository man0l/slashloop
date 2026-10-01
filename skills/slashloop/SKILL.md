---
name: slashloop
description: Slashloop workflow that selects recent gallery slideshow candidates and pushes them into free experiment drafts for an explicit workspace.
---

# Slashloop: recent slideshows to experiments

Inputs:

- `workspace`: workspace ID or exact workspace name. **Required.** Stop and ask
  if absent.
- `count`: candidate page size, default 12 and maximum 100.
- optional `platform`, `sourceId`, `minViews`, or `postedAfter`/`postedBefore`.

Resolve `workspace` exactly via `list_workspaces` (exact ID or
case-insensitive exact name). Never silently use the primary workspace.

1. Call `get_feed` with the resolved `workspaceId`, `sortBy="newest"`, and
   `limit=count`; apply the requested filters. This is the library-side view of
   recent gallery cards.
2. Call `show_gallery` with the same `workspaceId` and optional `sourceId` so
   the user can inspect the candidates; link `galleryUrl` if needed.
3. Present the newest candidates by `postedAt` and ask which IDs to use. If the
   user pre-approved automatic selection, use at most the first 20 IDs (the
   create-tool limit) and say that ineligible cards will be rejected.
4. Follow `slashloop-experiments` create mode with the approved IDs and the
   supplied goal, variables, mode, variant count, and slide count. `create_experiment`
   is free and makes one draft per slideshow; `video_not_slideshow` failures are
   expected for plain videos.
5. Stop after reporting created experiment IDs and plan estimates. Ask before
   `plan_experiment`; never start paid planning as part of selection.

Do not refresh, analyze, or generate images inside this workflow.
