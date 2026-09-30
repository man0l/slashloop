// Publish the Cloudflare Worker deploy signal that a later green run cannot erase.
//
// A failed deploy-worker run is not retried. Run 182 failed on the D1 daily
// row-read quota before wrangler, so a re-run of that SHA would fail again
// and still skip the publish. The recovery is a later successful deploy of a
// descendant SHA. That success used to be the only visible signal, which made
// the failed run look like it had never happened.
//
// This script, run at the end of every deploy-worker workflow:
//   - on a publish (wrangler + smoke passed): move the `worker-live` tag to
//     this SHA, mark `cloudflare-worker/published` success, and mark
//     `cloudflare-worker/shipped-via` on ancestor SHAs whose own run failed
//     after the previous successful publish
//   - otherwise: leave the tag where it is and mark
//     `cloudflare-worker/published` failure on this SHA
//
// The tag move and status posts are best-effort. This process exits 0 even
// when GitHub rejects a write, and records the failure as a workflow
// annotation. A signal-write error must not turn a finished wrangler publish
// into a red workflow — that is the masking bug this script exists to stop.
// Manual `wrangler rollback` does not move the tag; move it in the same step.

import { appendFileSync } from 'node:fs';

const PUBLISHED = 'cloudflare-worker/published';
const SHIPPED_VIA = 'cloudflare-worker/shipped-via';
const TAG = process.env.WORKER_LIVE_TAG || 'worker-live';

// Failures whose own SHA never has a successful deploy-worker run.
// Unlike selectFailedAncestors, this ignores the previous-success floor so
// the first publish after this script ships can still mark older holes
// (run 182) that a later green run had already covered.
export function selectUnshippedFailures(runs, { headSha, runId }) {
  const list = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && String(run.id) !== String(runId) && run.head_sha && run.head_sha !== headSha);
  const publishedShas = new Set(
    list.filter((run) => run.conclusion === 'success').map((run) => run.head_sha),
  );
  const seen = new Set();
  const failed = [];
  for (const run of list.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))) {
    if (run.conclusion !== 'failure') continue;
    if (publishedShas.has(run.head_sha) || seen.has(run.head_sha)) continue;
    seen.add(run.head_sha);
    failed.push(run);
  }
  return failed;
}

export function selectFailedAncestors(runs, { headSha, runId }) {
  const previous = (Array.isArray(runs) ? runs : [])
    .filter((run) => run && String(run.id) !== String(runId) && run.head_sha && run.head_sha !== headSha)
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const prevSuccess = previous.find((run) => run.conclusion === 'success') ?? null;
  const floor = prevSuccess ? Date.parse(prevSuccess.created_at) : Number.NEGATIVE_INFINITY;
  const publishedShas = new Set(
    previous.filter((run) => run.conclusion === 'success').map((run) => run.head_sha),
  );
  const seen = new Set();
  const failed = [];
  for (const run of previous) {
    if (run.conclusion !== 'failure') continue;
    const at = Date.parse(run.created_at);
    if (Number.isNaN(at) || at <= floor) continue;
    if (publishedShas.has(run.head_sha) || seen.has(run.head_sha)) continue;
    seen.add(run.head_sha);
    failed.push(run);
  }
  return { prevSuccess, failed };
}

export function ancestorCompare(status) {
  return status === 'ahead' || status === 'identical';
}

function clip(text) {
  const value = String(text ?? '');
  return value.length <= 140 ? value : value.slice(0, 137) + '...';
}

function summary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, markdown.endsWith('\n') ? markdown : `${markdown}\n`);
  else process.stdout.write(`${markdown}\n`);
}

function annotate(level, message) {
  process.stdout.write(`::${level}::${String(message).replace(/\n/g, ' ')}\n`);
}

async function github(method, path, body) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GH_TOKEN is not set');
  const base = process.env.GITHUB_API_URL || 'https://api.github.com';
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  return { status: response.status, data };
}

async function postStatus(repo, sha, context, state, description, targetUrl) {
  const result = await github('POST', `/repos/${repo}/statuses/${sha}`, {
    state,
    context,
    description: clip(description),
    target_url: targetUrl,
  });
  if (result.status >= 300) {
    throw new Error(`status ${context} on ${sha.slice(0, 7)} -> HTTP ${result.status}`);
  }
}

async function moveTag(repo, sha) {
  const refPath = `/repos/${repo}/git/refs/tags/${TAG}`;
  const current = await github('GET', refPath);
  if (current.status === 404) {
    const created = await github('POST', `/repos/${repo}/git/refs`, {
      ref: `refs/tags/${TAG}`,
      sha,
    });
    if (created.status >= 300) throw new Error(`create ${TAG} -> HTTP ${created.status}`);
    return 'created';
  }
  if (current.status >= 300) throw new Error(`read ${TAG} -> HTTP ${current.status}`);
  if (current.data?.object?.sha === sha) return 'unchanged';
  const updated = await github('PATCH', refPath, { sha, force: true });
  if (updated.status >= 300) throw new Error(`move ${TAG} -> HTTP ${updated.status}`);
  return 'moved';
}

async function listRuns(repo, branch) {
  const query = new URLSearchParams({
    branch,
    status: 'completed',
    per_page: '100',
  });
  const result = await github(
    'GET',
    `/repos/${repo}/actions/workflows/deploy-worker.yml/runs?${query}`,
  );
  if (result.status >= 300) throw new Error(`list deploy-worker runs -> HTTP ${result.status}`);
  return result.data?.workflow_runs ?? [];
}

async function isAncestor(repo, base, head) {
  const result = await github('GET', `/repos/${repo}/compare/${base}...${head}`);
  if (result.status >= 300) return false;
  return ancestorCompare(result.data?.status);
}

async function statusContexts(repo, sha) {
  const result = await github('GET', `/repos/${repo}/commits/${sha}/status`);
  if (result.status >= 300) throw new Error(`read status ${sha.slice(0, 7)} -> HTTP ${result.status}`);
  return new Set((result.data?.statuses ?? []).map((status) => status.context));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const sha = process.env.GITHUB_SHA;
  const runId = process.env.GITHUB_RUN_ID;
  const runNumber = process.env.GITHUB_RUN_NUMBER || runId;
  const branch = process.env.GITHUB_REF_NAME || 'master';
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const published = process.env.DEPLOY_PUBLISHED === 'true';
  const targetUrl = `${server}/${repo}/actions/runs/${runId}`;
  const errors = [];

  if (!repo || !sha || !runId) {
    annotate('error', 'deploy lineage: GITHUB_REPOSITORY, GITHUB_SHA, and GITHUB_RUN_ID are required');
    summary('### Cloudflare Worker publish\n\nLineage signal skipped: missing GitHub run context.\n');
    return;
  }

  const lines = [
    '### Cloudflare Worker publish',
    '',
    published
      ? `- Result: **published** \`${sha.slice(0, 7)}\` (deploy-worker run ${runNumber})`
      : `- Result: **not published**. \`${sha.slice(0, 7)}\` did not finish wrangler + smoke. The \`${TAG}\` tag was left where it is.`,
    `- Own-run status: \`${PUBLISHED}\``,
    '- A later green run does not clear a failure on this SHA.',
    `- Do not read the GitHub \`production\` deployment status as the Worker result. Vercel posts onto that same environment.`,
    '',
  ];

  try {
    await postStatus(
      repo,
      sha,
      PUBLISHED,
      published ? 'success' : 'failure',
      published
        ? `Published by deploy-worker run ${runNumber}. wrangler deploy and smoke passed.`
        : `Not published by deploy-worker run ${runNumber}. worker-live was not moved.`,
      targetUrl,
    );
  } catch (error) {
    errors.push(error.message);
  }

  if (published) {
    try {
      const tagResult = await moveTag(repo, sha);
      lines.push(`- \`${TAG}\` tag: ${tagResult} -> \`${sha}\``);
    } catch (error) {
      errors.push(error.message);
      lines.push(`- \`${TAG}\` tag: **not moved** (${error.message})`);
    }

    try {
      const runs = await listRuns(repo, branch);
      const { prevSuccess, failed: windowFailed } = selectFailedAncestors(runs, { headSha: sha, runId });
      const windowIds = new Set(windowFailed.map((run) => String(run.id)));
      const shipped = [];
      let statusReads = true;
      for (const run of selectUnshippedFailures(runs, { headSha: sha, runId })) {
        if (!(await isAncestor(repo, run.head_sha, sha))) continue;
        let contexts = null;
        if (statusReads) {
          try {
            contexts = await statusContexts(repo, run.head_sha);
          } catch (error) {
            // One read failure is enough. Keep marking the open window;
            // historical holes wait until statuses are readable.
            statusReads = false;
            errors.push(error.message);
          }
        }
        if (!statusReads && !windowIds.has(String(run.id))) continue;
        if (contexts?.has(SHIPPED_VIA)) continue;
        if (!contexts?.has(PUBLISHED)) {
          await postStatus(
            repo,
            run.head_sha,
            PUBLISHED,
            'failure',
            `Not published by deploy-worker run ${run.run_number}. Own run failed before a later publish.`,
            targetUrl,
          );
        }
        await postStatus(
          repo,
          run.head_sha,
          SHIPPED_VIA,
          'success',
          `Included in ${TAG} ${sha.slice(0, 7)} via deploy-worker run ${runNumber}. This SHA's own run failed.`,
          targetUrl,
        );
        shipped.push(`${run.head_sha.slice(0, 7)} (run ${run.run_number})`);
      }
      lines.push(
        prevSuccess
          ? `- Previous publish: \`${prevSuccess.head_sha.slice(0, 7)}\` (run ${prevSuccess.run_number})`
          : '- Previous publish: none in the last 100 completed runs',
      );
      lines.push(
        shipped.length
          ? `- Failed ancestor runs now marked \`${SHIPPED_VIA}\`: ${shipped.join(', ')}`
          : `- Failed ancestor runs now marked \`${SHIPPED_VIA}\`: none`,
      );
    } catch (error) {
      errors.push(error.message);
    }
  }

  if (errors.length) {
    lines.push('', `- Signal errors: ${errors.join('; ')}`);
    annotate('error', `deploy lineage incomplete: ${errors.join('; ')}`);
  }
  summary(lines.join('\n'));
}

const invoked = process.argv[1] && process.argv[1].endsWith('deploy-lineage.mjs');
if (invoked) {
  main().catch((error) => {
    annotate('error', `deploy lineage crashed: ${error.message}`);
    summary(`### Cloudflare Worker publish\n\nLineage signal crashed: ${error.message}\n`);
  });
}
