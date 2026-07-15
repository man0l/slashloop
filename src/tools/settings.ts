// ---------------------------------------------------------------------------
// MCP Tools: Usage Tracking + Settings + Cost Controls
// ---------------------------------------------------------------------------

import { z } from 'zod/v4';
import { db } from '../db.js';
import { loadAnalysisConfig, updateAnalysisConfig, DEFAULT_CONFIG, COST_ESTIMATES, BATCH_COST_ESTIMATES } from '../analysis/index.js';
import { analyzeVideoWithDownload } from '../analysis/index.js';
import { getApifyCapStatus } from '../lib/spend-cap.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSettingsTools(server: McpServer) {

  // ---- get_usage ----
  server.tool('get_usage',
    'Get cost and usage dashboard data. Shows scraping + AI costs by provider, monthly totals, and budget status.',
    {
      period: z.enum(['this_month', 'last_month', 'all']).default('this_month'),
    },
    async ({ period }) => {
      const workspace = await db.workspace.findFirst();
      if (!workspace) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No workspace' }) }], isError: true };

      // Build date filter
      const now = new Date();
      let dateFilter: any = {};
      if (period === 'this_month') {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFilter = { gte: startOfMonth };
      } else if (period === 'last_month') {
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        dateFilter = { gte: startOfLastMonth, lt: startOfThisMonth };
      }

      const logs = await db.usageLog.findMany({
        where: { workspaceId: workspace.id, createdAt: dateFilter },
        orderBy: { createdAt: 'desc' },
      });

      // Aggregate
      const byKind = { scrape: { costCents: 0, units: 0 }, ai: { costCents: 0, units: 0 } };
      const byProvider: Record<string, { costCents: number; units: number }> = {};
      let totalCost = 0;

      for (const log of logs) {
        totalCost += log.costCents;
        if (byKind[log.kind as keyof typeof byKind]) {
          byKind[log.kind as keyof typeof byKind].costCents += log.costCents;
          byKind[log.kind as keyof typeof byKind].units += log.units;
        }
        if (!byProvider[log.provider]) byProvider[log.provider] = { costCents: 0, units: 0 };
        byProvider[log.provider].costCents += log.costCents;
        byProvider[log.provider].units += log.units;
      }

      const budgetUsed = (totalCost / workspace.monthlyBudgetCents * 100).toFixed(1);
      const budgetRemaining = workspace.monthlyBudgetCents - totalCost;

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          period,
          workspace: { name: workspace.name, monthlyBudgetCents: workspace.monthlyBudgetCents },
          summary: {
            totalCostCents: totalCost,
            totalCostDisplay: `$${(totalCost / 100).toFixed(2)}`,
            budgetUsedPercent: `${budgetUsed}%`,
            budgetRemainingCents: budgetRemaining,
            budgetRemainingDisplay: `$${(budgetRemaining / 100).toFixed(2)}`,
            budgetWarning: totalCost >= workspace.monthlyBudgetCents * 0.8,
            budgetExceeded: totalCost >= workspace.monthlyBudgetCents,
          },
          byKind,
          byProvider,
          recentLogs: logs.slice(0, 20),
        }, null, 2) }],
      };
    });

  // ---- get_settings ----
  server.tool('get_settings',
    'Get workspace settings including analysis config, auto-analyze rules, and budget.',
    {},
    async () => {
      const workspace = await db.workspace.findFirst();
      if (!workspace) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No workspace' }) }], isError: true };

      const analysisConfig = await loadAnalysisConfig(workspace.id);
      const autoAnalyzeRules = JSON.parse(workspace.autoAnalyzeRulesJson);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          workspace: {
            id: workspace.id,
            name: workspace.name,
            monthlyBudgetCents: workspace.monthlyBudgetCents,
            createdAt: workspace.createdAt,
          },
          analysisConfig,
          costEstimates: COST_ESTIMATES,
          batchCostEstimates: BATCH_COST_ESTIMATES,
          autoAnalyzeRules,
        }, null, 2) }],
      };
    });

  // ---- update_settings ----
  server.tool('update_settings',
    'Update workspace settings. Pass only fields you want to change.',
    {
      name: z.string().optional(),
      monthlyBudgetCents: z.number().min(100).optional(),
      autoAnalyzeRules: z.object({
        minOutlierScore: z.number().default(5.0),
        minViews: z.number().default(10000),
        minEngagementRate: z.number().default(3),
        dailyLimit: z.number().default(10),
      }).optional(),
      analysisBackend: z.enum(['gemini-native', 'gemini-text']).optional(),
      analysisFallback: z.enum(['gemini-native', 'gemini-text']).optional(),
      geminiModel: z.enum(['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro']).optional(),
    },
    async (params) => {
      const workspace = await db.workspace.findFirst();
      if (!workspace) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No workspace' }) }], isError: true };

      // Update workspace fields
      const workspaceUpdate: any = {};
      if (params.name) workspaceUpdate.name = params.name;
      if (params.monthlyBudgetCents) workspaceUpdate.monthlyBudgetCents = params.monthlyBudgetCents;
      if (params.autoAnalyzeRules) workspaceUpdate.autoAnalyzeRulesJson = JSON.stringify(params.autoAnalyzeRules);

      if (Object.keys(workspaceUpdate).length > 0) {
        await db.workspace.update({ where: { id: workspace.id }, data: workspaceUpdate });
      }

      // Update analysis config
      const configUpdate: any = {};
      if (params.analysisBackend) configUpdate.backend = params.analysisBackend;
      if (params.analysisFallback) configUpdate.fallback = params.analysisFallback;
      if (params.geminiModel) configUpdate.geminiModel = params.geminiModel;

      let config = await loadAnalysisConfig(workspace.id);
      if (Object.keys(configUpdate).length > 0) {
        config = await updateAnalysisConfig(workspace.id, configUpdate);
      }

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          message: 'Settings updated',
          workspace: { name: params.name ?? workspace.name, monthlyBudgetCents: params.monthlyBudgetCents ?? workspace.monthlyBudgetCents },
          analysisConfig: config,
        }, null, 2) }],
      };
    });

  // ---- get_refresh_logs ----
  server.tool('get_refresh_logs',
    'Get refresh run logs showing scraping history, costs, and errors.',
    {
      sourceId: z.string().optional(),
      limit: z.number().min(1).max(100).default(20),
    },
    async ({ sourceId, limit }) => {
      const logs = await db.refreshRun.findMany({
        where: { sourceId: sourceId ?? undefined },
        include: { source: { select: { query: true, platform: true } } },
        orderBy: { ranAt: 'desc' },
        take: limit,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify(logs.map(l => ({
          id: l.id,
          source: l.source.query,
          platform: l.source.platform,
          itemsPulled: l.itemsPulled,
          newVideos: l.newVideos,
          errors: JSON.parse(l.errorsJson),
          costCents: l.costCents,
          ranAt: l.ranAt.toISOString(),
        })), null, 2) }],
      };
    });

  // ---- run_auto_analyze ----
  // Batch analyzer: walks the rules in Workspace.autoAnalyzeRulesJson, finds
  // candidate videos (above the outlier/views/engagement thresholds, no
  // existing analysis), caps at dailyLimit, calls analyzeVideoWithDownload
  // with batch:true so the 50% Gemini discount kicks in.
  //
  // Designed to be invoked either:
  //   - Manually from Claude Code / OpenCode ("run tonight's auto-analyze")
  //   - From an external cron (e.g. `bun src/scripts/auto_analyze_cron.ts`)
  //
  // MCP servers spawned by Claude Code / OpenCode are short-lived, so we
  // cannot keep a long-running scheduler inside the server process. The
  // external cron pattern is the recommended production setup.
  server.tool('run_auto_analyze',
    'Run a batch AI-analysis pass over outlier videos that have not yet been analyzed. Reads Workspace.autoAnalyzeRulesJson (minOutlierScore, minViews, minEngagementRate, dailyLimit) and applies the 50% Gemini batch discount. Each video is analyzed sequentially with the workspace default backend. Returns a summary including cost — also persists an AutoAnalyzeRun row for audit. Safe to call repeatedly; already-analyzed videos are skipped.',
    {
      dryRun: z.boolean().default(false).describe('If true, list candidates and estimated cost without actually analyzing.'),
      limitOverride: z.number().min(1).max(100).optional().describe('Override dailyLimit for this run (e.g. to catch up after downtime).'),
    },
    async ({ dryRun, limitOverride }) => {
      const workspace = await db.workspace.findFirst();
      if (!workspace) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No workspace' }) }], isError: true };

      // Parse rules with defaults
      const rawRules = JSON.parse(workspace.autoAnalyzeRulesJson || '{}');
      const rules = {
        minOutlierScore: rawRules.minOutlierScore ?? 5.0,
        minViews: rawRules.minViews ?? 10000,
        minEngagementRate: rawRules.minEngagementRate ?? 3,
        dailyLimit: rawRules.dailyLimit ?? 10,
      };
      const limit = limitOverride ?? rules.dailyLimit;

      // Find candidates: outlier score >= threshold, views >= threshold,
      // no existing analysis. Engagement filter is applied client-side
      // because it's a derived field.
      const candidates = await db.video.findMany({
        where: {
          views: { gte: rules.minViews },
          score: { outlierScore: { gte: rules.minOutlierScore } },
          analyses: { none: {} },
        },
        include: {
          score: true,
          source: { select: { workspaceId: true } },
        },
        orderBy: { score: { outlierScore: 'desc' } },
        take: limit * 3, // over-fetch to allow engagement-rate filtering
      });

      // Filter by engagement rate (likes / views * 100)
      const engFiltered = candidates.filter(v => {
        if (v.views <= 0) return false;
        const rate = (v.likes / v.views) * 100;
        return rate >= rules.minEngagementRate;
      });

      const capped = engFiltered.slice(0, limit);

      // Estimate cost using batch rates (50% Gemini discount)
      const config = await loadAnalysisConfig(workspace.id);
      const { getCostCents } = await import('../analysis/types.js');
      const perVideoCost = getCostCents(
        config.backend as 'gemini-native' | 'gemini-text',
        config.geminiModel,
        true,
      );
      const estimatedCostCents = Math.round(perVideoCost * capped.length * 100) / 100;

      if (dryRun) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({
            mode: 'dry-run',
            rules,
            limit,
            candidateCount: capped.length,
            estimatedCostCents,
            estimatedCostDisplay: `$${(estimatedCostCents / 100).toFixed(2)}`,
            candidates: capped.map(v => ({
              videoId: v.id,
              creator: v.creatorHandle,
              platform: v.platform,
              views: v.views,
              outlierScore: v.score?.outlierScore,
              caption: v.caption.slice(0, 100),
            })),
            note: 'Re-run without dryRun:true to analyze. Each video uses the batch cost table (Gemini 50% off).',
          }, null, 2) }],
        };
      }

      // Execute
      const results: Array<{ videoId: string; status: 'ok' | 'skipped' | 'failed'; error?: string; costCents?: number }> = [];
      let totalCostCents = 0;
      let analyzedCount = 0;
      let failedCount = 0;

      for (const v of capped) {
        try {
          // Double-check no analysis exists (could have changed during run)
          const existing = await db.analysis.findFirst({ where: { videoId: v.id }, select: { id: true } });
          if (existing) {
            results.push({ videoId: v.id, status: 'skipped' });
            continue;
          }

          const result = await analyzeVideoWithDownload(v.id, { batch: true });
          totalCostCents += result.costCents;
          analyzedCount++;
          results.push({ videoId: v.id, status: 'ok', costCents: result.costCents });
        } catch (err) {
          failedCount++;
          results.push({ videoId: v.id, status: 'failed', error: (err as Error).message });
        }
      }

      // Persist AutoAnalyzeRun for audit
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

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          message: 'Auto-analyze complete',
          runId: run.id,
          rules,
          candidateCount: capped.length,
          analyzedCount,
          skippedCount: results.filter(r => r.status === 'skipped').length,
          failedCount,
          totalCostCents: Math.round(totalCostCents * 100) / 100,
          totalCostDisplay: `$${(totalCostCents / 100).toFixed(4)}`,
          estimatedCostCents,
          savingsFromBatchDiscountCents: Math.max(0, Math.round((estimatedCostCents - totalCostCents) * 100) / 100),
          results,
        }, null, 2) }],
      };
    });

  // ---- get_apify_spend_status ----
  // Testing guardrail: shows current Apify spend vs cap, breach state, and
  // recent cap_breach events. Use this before/after refresh_source to
  // confirm you're still under the $5 testing cap.
  server.tool('get_apify_spend_status',
    'Check Apify spend against the testing cap (default $5). Shows current monthly spend, cap, percent used, breach state, and recent cap_breach audit events. Useful before/after refresh_source to confirm spend is within bounds.',
    {},
    async () => {
      const workspace = await db.workspace.findFirst();
      if (!workspace) return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'No workspace' }) }], isError: true };

      const status = await getApifyCapStatus(workspace.id);

      // Recent cap_breach events (last 30 days)
      const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const breaches = await db.usageLog.findMany({
        where: { workspaceId: workspace.id, kind: 'cap_breach', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      // Recent apify scrape events
      const scrapeLogs = await db.usageLog.findMany({
        where: { workspaceId: workspace.id, kind: 'scrape', provider: 'apify' },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          status,
          message: status.breached
            ? '⚠️  CAP BREACHED — refresh_source will refuse new Apify calls. Raise APIFY_SPEND_CAP_CENTS in .env to continue.'
            : status.warning
              ? `⚠️  Approaching cap (${status.percentUsed}% used). ${status.remainingDisplay} remaining.`
              : `OK — ${status.remainingDisplay} remaining of ${status.capDisplay} cap.`,
          recentCapBreaches: breaches.map(b => ({
            at: b.createdAt.toISOString(),
            attemptedCostCents: b.costCents,
          })),
          recentScrapeEvents: scrapeLogs.map(l => ({
            at: l.createdAt.toISOString(),
            costCents: l.costCents,
            refId: l.refId,
          })),
        }, null, 2) }],
      };
    });
}