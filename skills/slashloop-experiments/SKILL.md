---
name: slashloop-experiments
description: List Slashloop slideshow experiments, create free drafts from gallery slideshow IDs, and run them draft to completed. Spending needs approval; a standing credit cap in the task counts as approval.
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
- `preserveSourceCtaSlide`: optional boolean, default `false`. A source deck
  whose last slide is a detected call-to-action loses that slide from the count
  by default. Pass `true` to keep the source deck's own closing CTA slide. The
  flag is structural only: it changes the slide count, nothing else.

Write `goal` yourself and keep it free of source captions, creator handles and
competitor names. The server no longer appends the source caption to `goal`
(`tagGoalWithSource` defaults to false; leave it off).

**Always pass `ran_by`** (the alias `ranBy` is accepted too) on every
`create_experiment` call so the owner can see who ran it: `"user"` when the user asked directly, or
`"agent:<your name>"` when you act for them (e.g. `"agent:Leo"`). Pass only
your agent name, not who you act for; any `on behalf of ...` suffix is dropped.
Free text, trimmed and capped at 120 characters; use the same string every time so the owner can filter by it. An
experiment created without it keeps `ranBy: null` and cannot be attributed.

Defaults: `variantCount=3` including baseline and `slideCount=5`, overridden by
the source deck when known. Call `create_experiment`; the draft is free.
Return each created experiment ID and its `planEstimate`, plus failures. Do not
plan or generate before the spend is approved (next section).

For a bounded character-only edit of one deck, call `create_experiment` with
`mode:"edit"`, `variables:["character"]`, and `character` containing visible
casting direction (up to 1000 characters). Omit `hook`, `overlayTexts`, and
`instructions`: source text, style, setting and story stay locked. Edit mode
creates two variants with a 100-credit ceiling; the same approval gates apply.
Copy edits default to `variables:["hook"]`. Use create mode with
`instructions.variables:["character"]` and `instructions.direction` when you
need custom goals or counts. Never put create instructions into edit mode.

## Approval and lifecycle

### Approval: a standing budget is the approval

Spending steps (`plan_experiment`, `generate_experiment`, `retry_experiment`) run
only when the fresh estimate is `<= approvedCredits`. Decide where
`approvedCredits` comes from once, up front, for the whole batch:

1. **The task or issue grants a credit cap** (per experiment, e.g. "up to 200
   credits per experiment", or per batch). That is the approval. Price each step
   with `estimate_experiment`; if the estimate is within the remaining cap, pass
   the remaining cap as `approvedCredits` and run it. Do not create a
   confirmation card, do not ask in a comment. Track the remaining cap as you
   spend (`creditsCharged` on `get_experiment`). Ask only when an estimate
   exceeds the remaining cap, and then ask once with the numbers.
2. **No cap is stated.** Ask for approval ONCE with a single batched
   `request_confirmation` covering every experiment and both stages (plan and
   generate): list the experiments, the plan estimate for each, the expected
   generate cost, and the total. Never one card per experiment and never one per
   stage: Paperclip allows one active confirmation per issue, so each new card
   supersedes the last and generation never gets approved.
3. A cap or approval never covers more than it says. If the work needs more
   credits than approved, stop and ask for the difference.

### Lifecycle playbook

Drive every experiment all the way to `completed`; do not leave drafts or
`review` experiments parked.

1. **draft** (free): from `create_experiment`. Price it with
   `estimate_experiment(stage="plan")`, then `plan_experiment` with
   `approvedCredits` as above.
2. **planning**: wait. Nothing to do and nothing is editable.
3. **review**: briefs are ready and nothing is spent on images yet. Read each
   variant brief with `get_experiment` and check it against the task (locks,
   brand, forbidden names, the variable under test). Fix any problem for free with
   `update_experiment_variant` (send the complete brief and the variant's current
   `revision`; use the returned revision afterwards). Then
   `estimate_experiment(stage="generate", variantIds)` and
   `generate_experiment` with each variant's current revision and
   `approvedCredits` as above.
4. **generating**: wait.
5. **completed**: read the image URLs from `get_experiment`
   (`progress`), post them (and the experiment ID, variants and credits spent) on
   the task, and close the task. Do not re-run a completed experiment.
6. **paused** or **failed**: get the `retryableJobs` from `get_experiment`,
   price them with `estimate_experiment(taskIds)` (or `variantIds`/`stage`),
   and `retry_experiment` with `approvedCredits` as above. Completed images are
   kept.

**Edit, don't cancel.** If a brief is wrong, or the task changed mid-run (new
guardrails, a different angle), fix the briefs with `update_experiment_variant`
at `review`. Do not cancel and recreate: cancelled is terminal and the planning
credits are lost. Use `cancel_experiment` only when the source itself is
unusable (not a slideshow, deleted, or wrongly chosen) and say why in the
comment.

**Tracking.** Use `get_experiment` for status, never `await_job` /
`get_job_status`: experiment job ids are not valid there (`Job not found`). When
you cannot use the completion notification below, check `get_experiment` about
every 1 to 2 minutes (not faster) until the status changes. Paperclip agents use
the notification and the issue monitor below instead of a loop: end the heartbeat
after `plan_experiment` or `generate_experiment`, and continue the playbook from
the child task that wakes you.

Which fields you may edit: a variant may differ from the baseline only in the
experiment's chosen `instructions.variables` (read them from `get_experiment`);
every other brief field is shared. Change a shared field (topic, caption, CTA,
character, visual style, and slides unless `slides`/`concept` is a variable) on
any one draft variant and the same change is applied to the others, so to
retarget a whole experiment you edit one variant and read the returned
revisions of the rest. A chosen variable (for example `hook`) is edited per
variant. Pass `title` (and optionally `hypothesis`) to rename a variant. A
`422 unapproved_variable` now means a sibling is frozen/rendered, or the
variants would stop differing in a chosen variable; its message names the
fields.

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
- Paperclip agents: set `metadata` to `{paperclipIssueId: <the current task's
  UUID>, agentId: <your own agent ID>}` and omit `url`. When the experiment
  reaches a terminal status slashloop creates one child task of that task,
  assigned to you (the key is picked by `agentId`), which wakes you. A task that
  opens four experiments gets four child tasks. The description names the
  experiment, its status, variants and credits. Both ids are required: with no
  key for `agentId` (or no `agentId`) the delivery fails permanently and nothing
  is created.

**Paperclip agents: notify, never poll.** Do not loop on `get_experiment`.
After `plan_experiment` or `generate_experiment` starts a run, end the heartbeat
and let the child task wake you (`issue_assigned`). Create every experiment with
`notify:{metadata:{paperclipIssueId:<this task's UUID>, agentId:<your agent ID>}}`
(omit `url` and `secret`). When woken, the child task whose title starts `Slashloop experiment <id> <status>` is the
result: run `get_experiment` once for that `experimentId` and act on it. The
webhook can be lost or its keys can be unconfigured, so also set a monitor on the
same issue as a safety net. It needs no slashloop change:

```json
PATCH /api/issues/<issue UUID>
{"executionPolicy":{"monitor":{
  "kind":"external_service", "serviceName":"slashloop",
  "externalRef":"<experimentId>", "scheduledBy":"assignee",
  "nextCheckAt":"<now + 2h, ISO-8601>",
  "notes":"Webhook is the primary wake. If woken by this monitor, call get_experiment once, then clear or re-arm."}}}
```

Pick `nextCheckAt` well past the expected run time (a plan or generation
run takes minutes; two hours is a safe default) so the monitor fires only when
the webhook did not. When the completion comment arrives first, clear the monitor.
If the monitor fires instead, check the experiment once with `get_experiment`:
a terminal status means act on it; a non-terminal status means re-arm with a
later `nextCheckAt`. An issue holds one monitor: with several experiments, set
`externalRef` to a comma-separated list of their IDs and check each on a wake.

## List

Call `list_experiments` with `limit<=50`; follow `nextOffset` only if asked.
Return ID, status, goal, source video IDs, variant/slide counts, credit ceiling,
credits charged, `ranBy`, and error. Pass `ran_by` (exact match) to list only
the experiments run by one runner. Use `get_experiment` only to resolve a specific
experiment ID. Do not create, spend, edit, retry, cancel, or delete in list mode.
