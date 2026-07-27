// ---------------------------------------------------------------------------
// MCP Tools: Usage Tracking + Settings + Cost Controls
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { db } from '../db.js';
import { requireWorkspace } from '../context.js';
import { loadAnalysisConfig, updateAnalysisConfig, DEFAULT_CONFIG, COST_ESTIMATES, BATCH_COST_ESTIMATES } from '../analysis/index.js';
import { analyzeVideoWithDownload } from '../analysis/index.js';
import { getApifyCapStatus } from '../lib/spend-cap.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, creditBalance } from '../lib/credits.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerSettingsTools(server: McpServer) {

  // ---- get_usage ----
  server.tool('get_usage',
    'Get cost and usage dashboard data. Shows scraping + AI costs by provider, monthly totals, and budget status.',
    {
      period: z.enum(['this_month', 'last_month', 'all']).default('this_month'),
    },
    async ({ period }) => {
      const workspace = await requireWorkspace();

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
      const credits = { planCredits: workspace.planCredits, packCredits: workspace.packCredits, total: workspace.planCredits + workspace.packCredits };

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          period,
          workspace: { name: workspace.name, planKey: workspace.planKey, monthlyBudgetCents: workspace.monthlyBudgetCents },
          // Credits are what the customer actually spends against (see
          // src/lib/credits.ts). monthlyBudgetCents/budget* below is COGS
          // (what we pay Apify/Google) and is informational only now.
          credits,
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
      const workspace = await requireWorkspace();

      const analysisConfig = await loadAnalysisConfig(workspace.id);
      const autoAnalyzeRules = JSON.parse(workspace.autoAnalyzeRulesJson);

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          workspace: {
            id: workspace.id,
            name: workspace.name,
            planKey: workspace.planKey,
            billingStatus: workspace.billingStatus,
            periodEnd: workspace.periodEnd?.toISOString() ?? null,
            createdAt: workspace.createdAt,
          },
          credits: {
            planCredits: workspace.planCredits,
            packCredits: workspace.packCredits,
            total: workspace.planCredits + workspace.packCredits,
          },
          creditCosts: CREDIT_COSTS,
          analysisConfig,
          costEstimates: COST_ESTIMATES,
          batchCostEstimates: BATCH_COST_ESTIMATES,
          autoAnalyzeRules,
        }, null, 2) }],
      };
    });

  // ---- update_settings ----
  server.tool('update_settings',
    'Update workspace settings. Pass only fields you want to change. Note: credit balance and plan are billing-controlled and cannot be changed here — see get_billing status via get_apify_spend_status, or upgrade/buy credits at the billing URL.',
    {
      name: z.string().optional(),
      autoAnalyzeRules: z.object({
        minOutlierScore: z.number().default(5.0),
        minViews: z.number().default(10000),
        minEngagementRate: z.number().default(3),
        dailyLimit: z.number().default(10),
      }).optional(),
      analysisBackend: z.enum(['gemini-native', 'gemini-text']).optional(),
      analysisFallback: z.enum(['gemini-native', 'gemini-text']).optional(),
      geminiModel: z.enum([
        'gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro',
        'gemini-3.1-flash-lite', 'gemini-3.5-flash', 'gemini-3-pro-preview',
      ]).optional(),
    },
    async (params) => {
      const workspace = await requireWorkspace();

      // Update workspace fields. Credits/plan/billing fields are deliberately
      // not settable here — they're server-controlled (see planKey/planCredits
      // comments in prisma/schema.prisma) and change only via the Stripe
      // webhook or a trusted admin path, never a user-facing tool input.
      const workspaceUpdate: any = {};
      if (params.name) workspaceUpdate.name = params.name;
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
          workspace: { name: params.name ?? workspace.name, planKey: workspace.planKey },
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
      const workspace = await requireWorkspace();
      const logs = await db.refreshRun.findMany({
        where: {
          sourceId: sourceId ?? undefined,
          source: { workspaceId: workspace.id },
        },
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
      const workspace = await requireWorkspace();

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
          source: { workspaceId: workspace.id },
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
      let totalCreditsCharged = 0;
      let stoppedForCredits = false;

      for (const v of capped) {
        // Double-check no analysis exists (could have changed during run)
        const existing = await db.analysis.findFirst({ where: { videoId: v.id }, select: { id: true } });
        if (existing) {
          results.push({ videoId: v.id, status: 'skipped' });
          continue;
        }

        const opId = randomUUID();
        try {
          await debitCredits(workspace.id, CREDIT_COSTS.analyzeVideo, 'run_auto_analyze', `${opId}:preauth`);
        } catch (err) {
          if (err instanceof InsufficientCreditsError) {
            // Out of credits mid-batch: stop gracefully, report how far we
            // got. Remaining candidates are simply not attempted — nothing
            // to refund since nothing was charged for them.
            stoppedForCredits = true;
            break;
          }
          throw err;
        }

        try {
          const result = await analyzeVideoWithDownload(v.id, { batch: true });
          totalCostCents += result.costCents;
          totalCreditsCharged += CREDIT_COSTS.analyzeVideo;
          analyzedCount++;
          results.push({ videoId: v.id, status: 'ok', costCents: result.costCents });
        } catch (err) {
          await refundCredits(workspace.id, CREDIT_COSTS.analyzeVideo, 'run_auto_analyze', `${opId}:fail`, 'call_failed');
          failedCount++;
          results.push({ videoId: v.id, status: 'failed', error: (err as Error).message });
        }
      }

      const balance = await creditBalance(workspace.id);

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
          message: stoppedForCredits
            ? `Auto-analyze stopped early — out of credits after ${analyzedCount} of ${capped.length} candidates`
            : 'Auto-analyze complete',
          runId: run.id,
          rules,
          candidateCount: capped.length,
          analyzedCount,
          skippedCount: results.filter(r => r.status === 'skipped').length,
          failedCount,
          stoppedForCredits,
          totalCostCents: Math.round(totalCostCents * 100) / 100,
          totalCostDisplay: `$${(totalCostCents / 100).toFixed(4)}`,
          estimatedCostCents,
          savingsFromBatchDiscountCents: Math.max(0, Math.round((estimatedCostCents - totalCostCents) * 100) / 100),
          creditsCharged: totalCreditsCharged,
          creditsRemaining: balance.total,
          results,
        }, null, 2) }],
      };
    });

  // ---- get_apify_spend_status ----
  // Testing guardrail: shows current Apify spend vs cap, breach state, and
  // recent cap_breach events. Use this before/after refresh_source to
  // confirm you're still under the $5 testing cap.
  server.tool('get_apify_spend_status',
    'Check Apify spend against the platform-wide testing cap (default $5), and this workspace\'s own credit balance (what refresh_source/analyze_video/etc actually draw against). Shows current monthly spend, cap, percent used, breach state, and recent cap_breach audit events.',
    {},
    async () => {
      const workspace = await requireWorkspace();

      const status = await getApifyCapStatus(workspace.id);
      const credits = { planCredits: workspace.planCredits, packCredits: workspace.packCredits, total: workspace.planCredits + workspace.packCredits, planKey: workspace.planKey };

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
          credits,
          message: status.breached
            ? '⚠️  CAP BREACHED — refresh_source will refuse new Apify calls. Raise APIFY_SPEND_CAP_CENTS in .env to continue.'
            : status.warning
              ? `⚠️  Approaching cap (${status.percentUsed}% used). ${status.remainingDisplay} remaining.`
              : `OK — ${status.remainingDisplay} remaining of ${status.capDisplay} cap.`,
          creditsMessage: `${credits.total} credits remaining (${credits.planCredits} plan + ${credits.packCredits} pack) on the ${credits.planKey} plan.`,
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