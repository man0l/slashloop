#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// External cron entry point for run_auto_analyze.
//
// MCP servers spawned by Claude Code / OpenCode are short-lived processes —
// they come up for one tool call and exit. A long-running scheduler cannot
// live inside the MCP server. Use this script as the production cron entry.
//
// Usage:
//   DATABASE_URL="file:$PWD/prisma/slashloop.db" \
//   GEMINI_API_KEY=... \
//   bun src/scripts/auto_analyze_cron.ts
//
// Crontab (example: 03:00 daily):
//   0 3 * * * cd /path/to/mcp-server && \
//             DATABASE_URL="file:$PWD/prisma/slashloop.db" \
//             GEMINI_API_KEY=... \
//             bun src/scripts/auto_analyze_cron.ts >> /var/log/slashloop-cron.log 2>&1
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { loadAnalysisConfig } from '../analysis/config.js';
import { analyzeVideoWithDownload } from '../analysis/index.js';
import { getCostCents } from '../analysis/types.js';

async function main() {
  console.log(`[auto-analyze-cron] starting at ${new Date().toISOString()}`);
  const workspace = await db.workspace.findFirst();
  if (!workspace) {
    console.error('[auto-analyze-cron] no workspace found — exiting');
    process.exit(0);
  }

  // Parse rules
  const rawRules = JSON.parse(workspace.autoAnalyzeRulesJson || '{}');
  const rules = {
    minOutlierScore: rawRules.minOutlierScore ?? 5.0,
    minViews: rawRules.minViews ?? 10000,
    minEngagementRate: rawRules.minEngagementRate ?? 3,
    dailyLimit: rawRules.dailyLimit ?? 10,
  };

  console.log('[auto-analyze-cron] rules:', rules);

  // Find candidates
  const candidates = await db.video.findMany({
    where: {
      views: { gte: rules.minViews },
      score: { outlierScore: { gte: rules.minOutlierScore } },
      analyses: { none: {} },
    },
    include: { score: true, source: { select: { workspaceId: true } } },
    orderBy: { score: { outlierScore: 'desc' } },
    take: rules.dailyLimit * 3,
  });

  const engFiltered = candidates.filter(v => v.views > 0 && (v.likes / v.views) * 100 >= rules.minEngagementRate);
  const capped = engFiltered.slice(0, rules.dailyLimit);

  const config = await loadAnalysisConfig(workspace.id);
  // openrouter-video is billed per-token via OpenRouter's own meter, not
  // the credit ledger — the estimate is 0 for that backend.
  const perVideoCost = config.backend === 'openrouter-video'
    ? 0
    : getCostCents(config.backend, config.geminiModel, true);
  console.log(`[auto-analyze-cron] ${capped.length} candidates, est cost $${(perVideoCost * capped.length / 100).toFixed(4)}`);

  let analyzedCount = 0;
  let failedCount = 0;
  let totalCostCents = 0;
  const results: Array<{ videoId: string; status: string; error?: string; costCents?: number }> = [];

  for (const v of capped) {
    try {
      const existing = await db.analysis.findFirst({ where: { videoId: v.id }, select: { id: true } });
      if (existing) {
        results.push({ videoId: v.id, status: 'skipped' });
        continue;
      }
      const result = await analyzeVideoWithDownload(v.id, { batch: true });
      totalCostCents += result.costCents;
      analyzedCount++;
      results.push({ videoId: v.id, status: 'ok', costCents: result.costCents });
      console.log(`[auto-analyze-cron] ok: ${v.id} (${result.backend}, ${result.costCents}c)`);
    } catch (err) {
      failedCount++;
      results.push({ videoId: v.id, status: 'failed', error: (err as Error).message });
      console.error(`[auto-analyze-cron] failed: ${v.id} — ${(err as Error).message}`);
    }
  }

  const run = await db.autoAnalyzeRun.create({
    data: {
      workspaceId: workspace.id,
      candidateCount: capped.length,
      analyzedCount,
      skippedCount: results.filter(r => r.status === 'skipped').length,
      failedCount,
      totalCostCents: Math.round(totalCostCents * 100) / 100,
      batchMode: true,
      resultsJson: JSON.stringify(results),
    },
  });

  console.log(`[auto-analyze-cron] done. runId=${run.id} analyzed=${analyzedCount} failed=${failedCount} cost=$${(totalCostCents / 100).toFixed(4)}`);
  await db.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error('[auto-analyze-cron] fatal:', err);
  process.exit(1);
});
