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

Require 1–20 distinct `videoIds`. They must be Gallery slideshow cards or
videos with a Recreate deck; the server creates one isolated experiment per
video and rejects the others with `video_not_slideshow`.

Build `instructions`:

- `goal` required.
- `variables`: 1–7 values from `hook`, `character`, `visualStyle`, `caption`,
  `cta`, `concept`/`angle`, or `slides`.
- `mode`: `controlled` by default; `concept`/`slides` require `exploration`.
- `language`, `brand`, `audience`, `direction`, and `lockedConstraints` when
  supplied.

Defaults: `variantCount=3` including baseline and `slideCount=5`, overridden by
the source deck when known. Call `create_experiment`; the draft is free.
Return each created experiment ID and its `planEstimate`, plus failures. Do not
plan or generate without the next approval gate.

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
