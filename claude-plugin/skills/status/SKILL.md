---
name: status
description: Dashboard view of your slashloop account — tracked sources, Apify spend vs cap, and top outlier videos. Use when the user wants an overview, a status check, or asks "what am I tracking", "how much did I spend", "show me outliers", or "dashboard".
allowed-tools: mcp__plugin_slashloop_slashloop__list_sources, mcp__plugin_slashloop_slashloop__get_apify_spend_status, mcp__plugin_slashloop_slashloop__get_outlier_summary, mcp__plugin_slashloop_slashloop__get_feed, mcp__plugin_slashloop_slashloop__show_gallery
---

Render a concise, scannable dashboard by calling tools, then formatting the
result as tables (not prose). Run the data calls, then print:

## Tracked sources
Call `list_sources`. Render a table — one row per source:
`query · platform · type · last refresh · active`.

- Format `last refresh` as relative time ("3h ago", "2d ago"); show **never** if
  `lastRefreshedAt` is null, and flag that it has no videos yet.
- Group or sort by most-recently-refreshed.

## Apify spend
Call `get_apify_spend_status`. Render one line:
`$X.XX / $Y.YY used (Z%) · $W remaining` + note if the cap is breached.

## Top outliers
Call `get_outlier_summary` (or `get_feed` sorted by `outlier_score`, top 10).
Render a table:
`creator · caption (≤60 chars) · views · engagement% · outlier score`.

- engagement% = (likes + comments + shares + saves) / views, if the fields exist.

Also call `show_gallery` so the user can browse the same outliers visually
(unless the feed is empty).

If a section is empty (no sources / no spend / no videos), say so plainly in one
line and suggest `/slashloop:track` to start. Keep the whole thing compact.
