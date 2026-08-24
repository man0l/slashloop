// ---------------------------------------------------------------------------
// MCP Tools: AI hook tests (feature #7 v1).
//
// One proven video → one editable insight + 4 generated openings. Start and
// re-roll are the only metered moves (one Gemini text call each); picking,
// exporting and closing are bookkeeping. The guardrail from the plan applies
// verbatim: agents never auto-render or auto-post — v1 has nothing to render
// WITH, which makes the rule easy to keep.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import { requireWorkspace } from '../context.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, insufficientCreditsPayload, creditBalance } from '../lib/credits.js';
import { costBlock, withNextSteps } from '../lib/next-steps.js';
import {
  HookTestError,
  startHookTest, getHookTest, getOpenTestForVideo,
  rerollHooks, pickHookVersions, closeHookTest, exportShotlist,
} from '../lib/hook-tests.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** One error shape for service-layer rejections (ownership, lifecycle, input). */
function errorPayload(err: unknown) {
  const status = err instanceof HookTestError ? err.httpStatus : 500;
  return {
    error: err instanceof Error ? err.message : 'Hook test failed',
    ...(status !== 400 ? { status } : {}),
  };
}

/** Steps that follow every generation result (start + re-roll share them). */
function afterGenerateSteps(testId: string) {
  return [
    { label: 'Pick the openings worth producing', tool: 'pick_hook_versions', args: { testId }, why: 'Name the labels you actually want ("A" and "C") — unpicked proposals stay on the table.' },
    { label: 'Re-roll all four openings', tool: 'reroll_hooks', args: { testId }, cost: `${CREDIT_COSTS.rerollHooks} credits`, spendsMoney: true, why: 'Discards these proposals and generates a fresh batch under the same insight.' },
  ];
}

export function registerHookTestTools(server: McpServer) {

  server.tool('start_hook_test',
    'Turn one analyzed outlier video into an AI hook test: distill why its opening grabbed attention, then generate 4 alternative openings that keep everything else the same (recognition / specific number / contrarian / demo-first). Costs 2 credits.',
    {
      videoId: z.string(),
      brandContext: z.string().optional().describe('Your product/angle, so openings fit your context'),
      insight: z.string().optional().describe('Override the distilled insight with your own one-liner — it becomes the lock every re-roll obeys'),
    },
    async ({ videoId, brandContext, insight }) => {
      const workspace = await requireWorkspace();

      // Free pre-check BEFORE metering: an open test already existing is the
      // common case on a second attempt, and double-charging for guidance
      // would be theft.
      const existing = await getOpenTestForVideo(workspace.id, videoId).catch(() => null);
      if (existing) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `This video already has an open hook test — nothing charged.`,
          testId: existing.id,
          status: existing.status,
          insight: existing.insight,
          versions: existing.versions.map((v) => `${v.label}: ${v.hookText}`),
        }, [
          { label: 'Re-roll all four openings', tool: 'reroll_hooks', args: { testId: existing.id }, cost: `${CREDIT_COSTS.rerollHooks} credits`, spendsMoney: true, why: 'Fresh batch inside the same locked frame.' },
          { label: 'Pick the openings worth producing', tool: 'pick_hook_versions', args: { testId: existing.id }, why: 'Narrows the shot list to what you actually want.' },
        ]), null, 2) }] };
      }

      const opId = randomUUID();
      try {
        await debitCredits(workspace.id, CREDIT_COSTS.startHookTest, 'start_hook_test', `${opId}:preauth`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        throw err;
      }

      try {
        const result = await startHookTest(workspace.id, videoId, { brandContext, insight });
        const balance = await creditBalance(workspace.id);
        return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: 'Hook test created — 4 openings proposed',
          ...result,
          creditsCharged: CREDIT_COSTS.startHookTest,
          creditsRemaining: balance.total,
          cost: costBlock(CREDIT_COSTS.startHookTest, { remaining: balance.total }),
        }, afterGenerateSteps(result.id)), null, 2) }] };
      } catch (err) {
        const balance = await refundCredits(workspace.id, CREDIT_COSTS.startHookTest, 'start_hook_test', `${opId}:fail`, 'call_failed');
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          ...errorPayload(err),
          creditsCharged: 0,
          creditsRemaining: balance.total,
          cost: costBlock(0, { remaining: balance.total, note: 'Call failed — pre-auth refunded, nothing charged.' }),
        }) }], isError: true };
      }
    });

  server.tool('get_hook_test',
    'Get a hook test with all versions. Pass either testId or videoId (videoId resolves the open test). Free.',
    { testId: z.string().optional(), videoId: z.string().optional() },
    async ({ testId, videoId }) => {
      const workspace = await requireWorkspace();
      if (!testId && !videoId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ error: 'Pass testId or videoId' }) }], isError: true };
      }
      try {
        const result = testId ? await getHookTest(testId, workspace.id) : await getOpenTestForVideo(workspace.id, videoId!);
        if (!result) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
            message: `No open hook test for this video yet.`,
          }, [
            { label: 'Start a hook test', tool: 'start_hook_test', args: { videoId }, cost: `${CREDIT_COSTS.startHookTest} credits`, spendsMoney: true },
          ]), null, 2) }] };
        }
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err)) }], isError: true };
      }
    });

  server.tool('reroll_hooks',
    'Discard a hook test\'s live proposals and generate 4 fresh ones under the same locked insight. Previously picked versions count as discarded too. Costs 2 credits.',
    { testId: z.string() },
    async ({ testId }) => {
      const workspace = await requireWorkspace();
      const opId = randomUUID();
      try {
        await debitCredits(workspace.id, CREDIT_COSTS.rerollHooks, 'reroll_hooks', `${opId}:preauth`);
      } catch (err) {
        if (err instanceof InsufficientCreditsError) {
          return { content: [{ type: 'text' as const, text: JSON.stringify(insufficientCreditsPayload(err), null, 2) }], isError: true };
        }
        throw err;
      }

      try {
        const result = await rerollHooks(testId, workspace.id);
        const balance = await creditBalance(workspace.id);
        return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: 'New round generated — previous proposals discarded',
          ...result,
          creditsCharged: CREDIT_COSTS.rerollHooks,
          creditsRemaining: balance.total,
          cost: costBlock(CREDIT_COSTS.rerollHooks, { remaining: balance.total }),
        }, afterGenerateSteps(result.id)), null, 2) }] };
      } catch (err) {
        const balance = await refundCredits(workspace.id, CREDIT_COSTS.rerollHooks, 'reroll_hooks', `${opId}:fail`, 'call_failed');
        return { content: [{ type: 'text' as const, text: JSON.stringify({
          ...errorPayload(err),
          creditsCharged: 0,
          creditsRemaining: balance.total,
          cost: costBlock(0, { remaining: balance.total, note: 'Call failed — pre-auth refunded, nothing charged.' }),
        }) }], isError: true };
      }
    });

  server.tool('pick_hook_versions',
    'Mark hook-test versions as picked (e.g. ["A","C"] by label, or by ID). Picked ones feed the shot list; unpicked proposals stay on the table. Free.',
    {
      testId: z.string(),
      picks: z.array(z.string()).min(1).describe('Version labels ("A".."D") or version IDs'),
    },
    async ({ testId, picks }) => {
      const workspace = await requireWorkspace();
      try {
        const test = await getHookTest(testId, workspace.id);
        const byLabel = new Map(test.versions.filter((v) => v.status === 'proposed').map((v) => [v.label, v]));
        const ids = picks.map((p) => byLabel.get(p.toUpperCase())?.id ?? p);
        const result = await pickHookVersions(testId, workspace.id, ids);
        const picked = result.versions.filter((v) => v.status === 'picked');
        return { content: [{ type: 'text' as const, text: JSON.stringify(withNextSteps({
          message: `Picked ${picked.length === 1 ? picked[0].label : picked.length + ' versions'}`,
          ...result,
        }, [
          { label: 'Export the shot list', tool: 'export_shotlist', args: { testId: result.id }, why: 'One markdown brief per picked opening — ready to shoot or feed to a generator.' },
          { label: 'Close the test', tool: 'close_hook_test', args: { testId: result.id }, why: 'Done comparing openings? Closing frees the video for another test later.' },
        ]), null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err)) }], isError: true };
      }
    });

  server.tool('export_shotlist',
    'Export a hook test as a markdown shot list — one section per picked opening (or every live proposal if nothing is picked). Free.',
    { testId: z.string() },
    async ({ testId }) => {
      const workspace = await requireWorkspace();
      try {
        const md = await exportShotlist(testId, workspace.id);
        return { content: [{ type: 'text' as const, text: md }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err)) }], isError: true };
      }
    });

  server.tool('close_hook_test',
    'Close a hook test (status won | closed). Closed tests stop appearing as the video\'s open test, freeing it for a fresh one later. Free.',
    {
      testId: z.string(),
      outcome: z.enum(['won', 'closed']).optional().describe("'won' records that an opening beat the original"),
    },
    async ({ testId, outcome }) => {
      const workspace = await requireWorkspace();
      try {
        const result = await closeHookTest(testId, workspace.id, outcome);
        return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text' as const, text: JSON.stringify(errorPayload(err)) }], isError: true };
      }
    });
}
