---
name: slashloop-gallery
description: Show or list Slashloop gallery items ranked by outlier score. Read-only display; use the refresh skill to scrape and this skill only to view results.
---

# Slashloop gallery

Inputs:

- `workspace`: workspace ID or exact workspace name. **Required.** If absent,
  stop and ask for it.
- Optional filters: `sourceId`, `minOutlierScore`, `minViews`, `analyzedBy`,
  `limit`, and `density`.

Resolve `workspace` with `list_workspaces` using exact ID or case-insensitive
exact name; stop if absent, unmatched, or ambiguous. Do not default to primary.

This is display-only: call `show_gallery` once with `workspaceId` and the
requested filters. Omit `minOutlierScore` when the user asks for all ranked
items; use `5`, `10`, `25`, `50`, or `100` when they ask for stronger outliers.
Default `limit=48` unless told otherwise. `show_gallery` ranks by outlier score
descending; do not re-rank by views. Do not refresh, analyze, fetch media, or
run experiments here.

Return item index, ID, creator, caption when useful, outlier score, and the
scoped filters. If the host does not render the MCP App, give the returned
`galleryUrl` as a clickable link.
