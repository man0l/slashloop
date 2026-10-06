---
name: slashloop-experiments
description: List Slashloop slideshow experiments or create free drafts from gallery slideshow IDs. Running a draft requires explicit plan and generation estimates.
---

# Slashloop experiments

Inputs:

- `workspace`: workspace ID or exact workspace name. **Required.** If absent,
  stop and ask for it.
- `operation`: `create` or `list`. Ambiguity stops the skill.

Resolve `workspace` with `list_workspaces`; accept exact ID or
case-insensitive exact name. Stop rather than choosing primary by default. Pass
the resolved ID as `workspaceId` in every experiment call.

## Create

Require 1–20 distinct `videoIds`. Ids that are the same post (same platform
and external id; the feed can list one post under two ids) are collapsed to one
experiment, preferring the already-analyzed id, and returned as
`skippedDuplicates`. They must be Gallery slideshow cards or
videos with a Recreate deck; the server creates one isolated experiment per
video and rejects the others with `video_not_slideshow`.

Build `instructions`:

- `goal` required.
- `sourceFormat` (recommended): what the source is — `statue-collage`,
  `sprite-vs-real`, `annotated-face`, `ai-render`, `sketch`,
  `portrait-collage`, or `photo-person`. It fills `variables`, `mode`,
  `direction` and `lockedConstraints`, so `goal` + `sourceFormat` is a complete
  request. Your own `variables`, `mode` and `direction` win; your
  `lockedConstraints` are added to the preset's, never replacing them. When
  omitted the server infers it from the source's analysis (an unanalyzed draft
  usually cannot be inferred, so set it). Never write hair, eye, complexion,
  wardrobe or jewelry locks yourself for a statue, sprite, sketch or food
  source: there is no person to preserve. Person-appearance locks come only
  from `photo-person` (and framing-only locks for `annotated-face`,
  `portrait-collage`, and `ai-render` with a visible person). Every preset
  also locks: no source watermarks, handles or competitor brands; only our own
  app on the closing CTA slide; no real or celebrity likeness; adults only.
  Do not paste source analysis text into `direction` or `lockedConstraints`
  (it names real people and the source's own brand).
- `variables`: 1–7 values from `hook`, `character`, `visualStyle`, `caption`,
  `cta`, `concept`/`angle`, or `slides`. Required unless a `sourceFormat` is
  given or inferred.
- `mode`: `controlled` by default; each alternate changes one selected variable.
  `exploration` permits combined changes in a variant; `concept`/`slides` require it.
  For the SaaS "Explore combinations" test mode, use `mode:"create"` with
  `instructions.mode:"exploration"` and all selected `instructions.variables`,
  e.g. `["hook","character","visualStyle"]`. Put desired values in
  `instructions.direction`. This uses the same service and locks as the SaaS;
  top-level edit `variables` is the bounded single-variable shortcut.
- `language`, `brand`, `audience`, `direction`, and `lockedConstraints` when
  supplied.

Defaults: `variantCount=3` including baseline and `slideCount=5`, overridden by
the source deck when known. Call `create_experiment`; the draft is free.
Return each created experiment ID and its `planEstimate`, plus failures. Do not
plan or generate without the next approval gate.

For a bounded character-only edit of one deck, call `create_experiment` with
`mode:"edit"`, `variables:["character"]`, and `character` containing visible
casting direction (up to 1000 characters). Omit `hook`, `overlayTexts`, and
`instructions`: source text, style, setting and story stay locked. Edit mode
creates two variants with a 100-credit ceiling; the same approval gates apply.
Copy edits default to `variables:["hook"]`. Use create mode with
`instructions.variables:["character"]` and `instructions.direction` when you
need custom goals or counts. Never put create instructions into edit mode.

To run a confirmed draft: call `estimate_experiment(stage="plan")`; after the
user approves that exact `totalCredits`, pass it as `approvedCredits` to
`plan_experiment`, then poll `get_experiment` no faster than about a minute.
At `review`, optionally edit a variant, call
`estimate_experiment(stage="generate", variantIds)`, get approval, and pass the
approved total to `generate_experiment` with each variant's current revision.

## List

Call `list_experiments` with `limit<=50`; follow `nextOffset` only if asked.
Return ID, status, goal, source video IDs, variant/slide counts, credit ceiling,
credits charged, and error. Use `get_experiment` only to resolve a specific
experiment ID. Do not create, spend, edit, retry, cancel, or delete in list mode.
