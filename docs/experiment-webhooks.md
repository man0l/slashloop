# Experiment completion webhooks — Paperclip delivery runbook

When an experiment first enters a terminal status (`completed`, `review`, `failed`,
`paused`, `cancelled`) `store.save()` writes one `ExperimentWebhookOutbox` row in the
same batch. The VPS worker's experiment leader sweeps the outbox
(`src/experiments/webhook-outbox.ts`) and delivers each row
(`src/experiments/webhook-delivery.ts`). Delivery runs on the VPS worker only.

## Targets

- `notify.url`: a signed Standard Webhooks POST (unchanged).
- `notify.metadata.paperclipIssueId` (+ `agentId`): a **child task of that
  Paperclip task, created with that agent's key and assigned to that agent**.

## Paperclip child-task delivery (SLA-666)

Why not a comment: Paperclip's `POST /issues/:id/comments` requires a live heartbeat
run for any agent actor (`cross_issue_influence_run_context_required`), even on the
agent's own issue. The worker has no run, so SLA-651's comment path was refused with
403 on every row. Creating a task is the path that worked before SLA-651 (SLA-641..645),
and assigning it to the requesting agent wakes that agent inside its own run, so the
agent reads the result there. This works whether or not the originating task is
assigned to the requesting agent.

1. Key: `SLASHLOOP_PAPERCLIP_AGENT_KEYS[notify.metadata.agentId]`.
2. `GET {api}/api/issues/{paperclipIssueId}` for `companyId`, `projectId`, `identifier`.
3. `POST {api}/api/companies/{companyId}/issues` with `parentId` = the origin task,
   `assigneeAgentId` = the requesting agent, `status: "todo"`, the origin's `projectId`,
   title `Slashloop experiment <id8> <status>` and
   `idempotencyKey: slashloop-experiment:<experimentId>:<status>:<version>`. No
   `X-Paperclip-Run-Id`. A retry or replay carries the same key, so any 2xx (including a
   deduplicated create) counts as delivered.

One child task per experiment: a task that opens four experiments gets four tasks.

### Failure classes

| Outcome | Class | `lastError` |
| --- | --- | --- |
| Env fault, see below | retry | `paperclip_url_missing`, `paperclip_url_not_public_https`, `paperclip_keys_missing`, `paperclip_keys_invalid_json`, `paperclip_keys_empty` |
| No key for `agentId` / no `agentId` | permanent, also logged as a config error | `paperclip_agent_key_missing` / `paperclip_agent_id_missing` |
| `403` carrying `cross_issue_influence_run_context_required` | permanent, **config error**: logged at error level as `[webhook] CONFIG ERROR ...` on the first attempt | `paperclip_run_context_required: <redacted snippet>` |
| Origin issue body has no `companyId` | retry | `paperclip_origin_unreadable` |
| other `403`, `404`, other `4xx` (400, 409, 422) | permanent | `http_<status>: <redacted snippet>` |
| `401`, `408`, `425`, `429`, `5xx`, network error | retry (~24h backoff) | `http_<status>` / `network_error:<code>` |

Env fault reasons (the URL is checked first, then the keys):

| `lastError` | Meaning |
| --- | --- |
| `paperclip_url_missing` | `SLASHLOOP_PAPERCLIP_API_URL` unset or blank |
| `paperclip_url_not_public_https` | URL is not https, or points at a private/loopback host |
| `paperclip_keys_missing` | `SLASHLOOP_PAPERCLIP_AGENT_KEYS` unset or blank |
| `paperclip_keys_invalid_json` | not parseable JSON, or not a JSON object (an array, string or `null`) |
| `paperclip_keys_empty` | a JSON object with no entry that has a non-empty string key |

Retries stop after 10 attempts and the row goes `dead`. Snippets are length-capped
and have keys and token-shaped strings masked.

## Worker env (VPS `.env`, never committed)

| Name | Value |
| --- | --- |
| `SLASHLOOP_PAPERCLIP_API_URL` | Paperclip base URL, public https |
| `SLASHLOOP_PAPERCLIP_AGENT_KEYS` | JSON `{agentId: apiKey}`, one entry per agent allowed to request experiments (Marketing Ops (claude) and Marketing Ops (codex)) |

Retired, and no longer read: `PAPERCLIP_API_KEY_FOR_SLASHLOOP_BRIDGE_AGENT`,
`SLASHLOOP_PAPERCLIP_API_KEY`, `SLASHLOOP_PAPERCLIP_ASSIGNEE_AGENT_ID`,
`SLASHLOOP_PAPERCLIP_PROJECT_ID`, `SLASHLOOP_PAPERCLIP_COMPANY_ID` (the company id now comes from the origin issue). Remove them from
the host `.env` when installing the new ones. `WEBHOOK_DELIVERY_ENABLED=0` parks
delivery; rows keep queueing and go out after re-enabling.

## Checks

- Inspect: `SELECT state, attempts, lastError FROM ExperimentWebhookOutbox` (D1).
- A permanent row can be requeued by setting `state='pending', attempts=0` after
  the key or ids are fixed.
- At startup each worker logs one line, e.g. `[worker] webhook delivery on; paperclip delivery config: url=set keys=2 agents=[<id>, <id>] status=ok`.
  `status` is `ok` or the first reason above; key values and the URL are never logged.
  `docker compose restart` does **not** reload `env_file` changes; recreate the service with
  `docker compose -f docker-compose.prod.yml up -d <service>` and check the line again.
- After changing the key map, restart only the worker service that runs experiments; a restart is safe
  because claims are leased and the idempotency key makes a re-delivery a no-op.
