---
name: analyze
description: Analyze hand-picked outlier videos with Gemini, then turn what worked into hooks, ideas, and briefs. Use after viewing the gallery or feed, when the user wants to know WHY a video performed — or says "analyze", "break this down", "what's the hook", "why did this pop".
argument-hint: "<videoId | creator handle | 'the top outliers'>"
allowed-tools: mcp__plugin_slashloop_slashloop__get_outlier_summary, mcp__plugin_slashloop_slashloop__get_feed, mcp__plugin_slashloop_slashloop__get_video, mcp__plugin_slashloop_slashloop__analyze_video, mcp__plugin_slashloop_slashloop__extract_hook, mcp__plugin_slashloop_slashloop__generate_hook_variations, mcp__plugin_slashloop_slashloop__create_idea, mcp__plugin_slashloop_slashloop__create_brief, mcp__plugin_slashloop_slashloop__save_to_board, mcp__plugin_slashloop_slashloop__get_usage
---

Turn a scored outlier into something the user can act on. This is the half of
the product where the value is — tracking and viewing are setup.

## 1. Pick the right videos

If `$ARGUMENTS` names a video id or creator, use it. Otherwise call
`get_outlier_summary` and choose candidates yourself.

**Prefer `scoreType: "actual"` over `"estimated"`, always.**

- `actual` — measured against that creator's own median. A real breakout.
- `estimated` — measured against the *source's* median. Mostly tracks account
  size: a 5M-follower account posting normally into a tracked hashtag scores
  in the hundreds and teaches you nothing repeatable.

A 686× actual on a 794K-view video is a far better use of credits than a 272×
estimated on a 119M-view one. Say this out loud when it comes up — users
naturally read the bigger view count as the bigger signal.

Skip anything already analyzed (`hasAnalysis: true`); re-analysis costs the
same and returns the same schema version.

## 2. Confirm the spend — every time

`analyze_video` costs **5 credits per video** and calls Gemini.

State the exact total and the videos it covers, then wait for a clear yes:

> Three of these beat their own creator's baseline — @take_the_black_pill_ at
> 686×, @dubskii___ at 25× and 15×. Analyzing all three is 15 credits. Want me
> to?

Rules:

- Confirm **each batch of spend separately**. Never fold a refresh, an analysis
  and a brief behind one "yes" — the user is agreeing to a number, not a plan.
- If the user says "analyze everything", quote the full total first. Twenty
  videos is 100 credits.
- Check `get_usage` when the balance might not cover it, and say what's left.
- `analyze_video` handles one video per call. Loop, and report as you go rather
  than in silence.

## 3. Report what actually transfers

Don't paraphrase the JSON. Lead with the reusable mechanic:

- The hook — what happens in the first 2 seconds, and why it stops the scroll.
- Structure — pacing, cuts, where the payoff lands.
- What is copyable versus what is specific to that creator's face or audience.

## 4. Keep going — do not stop at the analysis

Offer the next move, with cost attached:

| Next | Tool | Cost |
|---|---|---|
| Pull the hook out verbatim | `extract_hook` | free |
| Rewrite it for the user's niche | `generate_hook_variations` | 2 credits |
| Save a content idea | `create_idea` | free |
| Full creative brief | `create_brief` | 2 credits |
| Keep it for later | `save_to_board` | free |

Recommend one rather than listing all five. After analyzing a strong hook,
`generate_hook_variations` is usually the right call — say so.

If the analysis was thin (no stored video, text-only backend), say that plainly
and suggest `fetch_videos` for the outliers worth seeing play, rather than
pretending the result is richer than it is.
