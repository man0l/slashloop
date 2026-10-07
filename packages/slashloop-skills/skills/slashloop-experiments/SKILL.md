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

**Always pass `ran_by`** on every `create_experiment` call so the owner can see
who ran it: `"user"` when the user asked directly, or
`"agent:<your name> on behalf of <user>"` when you act for them (e.g.
`"agent:Leo on behalf of man0l"`). Free text, trimmed and capped at 120
characters; use the same string every time so the owner can filter by it.

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

`update_experiment_variant` edits only a draft variant (never generated, no
frozen brief) with its current revision, at `review`, at `completed` (for a
variant not yet generated), or at `failed`/`paused` while no provider job is
running or unknown. It is refused while `planning`/`generating`
(`experiment_active`), when `cancelled` (`experiment_cancelled`), in a
pre-plan `draft` (`not_editable`), for a frozen or rendered variant
(`variant_frozen`), and for a stale revision (`revision_conflict`).

### Completion notification (`notify`)

Instead of polling, pass `notify:{url?, secret?, metadata?}` to
`create_experiment` (create mode only, not `mode:"edit"`). When the experiment
first moves from `draft`/`planning`/`generating` into `completed`, `review`,
`failed`, `paused` or `cancelled`, slashloop POSTs one signed JSON event:
`{type:"experiment.<status>", experimentId, status, version, summary, ...,
metadata}`. Retries use exponential backoff for about 24 hours. A retried
experiment that reaches a terminal status again sends a new event.

- `url`: https only, port 443, a public host (private, loopback, link-local and
  internal addresses are refused with `invalid_notify`). Headers follow
  Standard Webhooks: `webhook-id` (also sent as `idempotency-key`, value
  `experimentId:status:version`; dedupe on it), `webhook-timestamp`,
  `webhook-signature` (`v1,` + base64 HMAC-SHA256 of `id.timestamp.body`).
- `secret`: optional, 16 to 256 characters. When omitted, slashloop generates a
  `whsec_...` secret and returns it once as `notify.signingSecret` in the create
  response (an idempotent replay returns the same one). Store it; it is never
  readable again.
- `metadata`: up to 4 KB of JSON echoed back in the event body.
- Paperclip agents: set `metadata.paperclipIssueId` to the issue UUID and
  omit `url`. The event becomes a comment on that issue, which wakes its
  assignee. The target issue is taken from this metadata; no per-workspace
  setup is needed.

## List

Call `list_experiments` with `limit<=50`; follow `nextOffset` only if asked.
Return ID, status, goal, source video IDs, variant/slide counts, credit ceiling,
credits charged, `ranBy`, and error. Pass `ran_by` (exact match) to list only
the experiments run by one runner. Use `get_experiment` only to resolve a specific
experiment ID. Do not create, spend, edit, retry, cancel, or delete in list mode.
