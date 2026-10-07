# Experiment completion webhooks — Paperclip delivery runbook

When an experiment first enters a terminal status (`completed`, `review`, `failed`,
`paused`, `cancelled`) `store.save()` writes one `ExperimentWebhookOutbox` row in the
same batch. The VPS worker's experiment leader sweeps the outbox
(`src/experiments/webhook-outbox.ts`) and delivers each row
(`src/experiments/webhook-delivery.ts`). Delivery runs on the VPS worker only.

## Targets

- `notify.url`: a signed Standard Webhooks POST (unchanged).
- `notify.metadata.paperclipIssueId` (+ `agentId`): a **comment on that Paperclip
  task, authored by that agent**. There is no bridge agent and no new issue.

## Paperclip comment delivery

1. Key: `SLASHLOOP_PAPERCLIP_AGENT_KEYS[notify.metadata.agentId]`.
2. `GET {api}/api/issues/{paperclipIssueId}/comments?order=desc&limit=100`. If the
   thread already holds `<!-- slashloop-experiment:{experimentId}:{status}:{version} -->`
   the row is marked delivered and nothing is posted. Paperclip only dedupes
   `clientRequestId` for user actors, so the thread is the idempotency record.
3. `POST {api}/api/issues/{paperclipIssueId}/comments` with
   `{"body": "...<marker>", "resume": true}` and no `X-Paperclip-Run-Id`.
   `resume: true` is required: Paperclip suppresses the wake on an assignee's own
   comment unless it is set (and the comment is not from the current run). It also
   reopens the task if it was already `done`.

One comment per experiment: a task that opens four experiments gets four comments.

### Failure classes

| Outcome | Class | `lastError` |
| --- | --- | --- |
| Env fault, see below | retry | `paperclip_url_missing`, `paperclip_url_not_public_https`, `paperclip_keys_missing`, `paperclip_keys_invalid_json`, `paperclip_keys_empty` |
| No key for `agentId` / no `agentId` | permanent | `paperclip_agent_key_missing` / `paperclip_agent_id_missing` |
| `403`, `404`, other `4xx` (400, 409, 422) | permanent | `http_<status>: <redacted snippet>` |
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
`SLASHLOOP_PAPERCLIP_PROJECT_ID`, `SLASHLOOP_PAPERCLIP_COMPANY_ID`. Remove them from
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
  because claims are leased and the marker check makes a re-delivery a no-op.
