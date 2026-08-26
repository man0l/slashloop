// GET   /api/videos/:id?workspaceId=...            — video detail (analysis, playback URL, job status).
// POST  /api/videos/:id/analyze { workspaceId, forceBackend? } — trigger AI analysis.
// GET   /api/videos/:id/hook-test                  — the video's open AI hook test (or {test:null}).
// POST  /api/videos/:id/hook-test { brandContext?, insight? } — start one (2 credits).
// PATCH /api/videos/:id/hook-test { insight?, sameIn? }        — edit the lock (free).
// POST  /api/videos/:id/hook-test/pick { picks }   — mark openings picked (free).
// POST  /api/videos/:id/hook-test/reroll           — discard proposals, generate fresh (2 credits).
// GET   /api/videos/:id/hook-test/shotlist         — markdown shot list.
// POST  /api/videos/:id/hook-test/close { outcome? } — end the test (free).
//
// One file, not two: the Hobby plan caps a deployment at 12 Serverless
// Functions (see api/sources.ts for the same constraint) and this deployment
// is AT the cap. vercel.json rewrites all of these paths onto this file with
// `id`/`action` query params — the URLs callers use are unchanged.
//
// Hook tests share the MCP metering exactly: pre-auth debit → work → refund
// on failure, costBlock on every spending response. The service layer
// (src/lib/hook-tests.ts) owns ownership checks; this file only meters and
// shapes HTTP.
import { randomUUID } from 'node:crypto';
import { corsPreflight } from '../src/lib/cors.js';
import { requireOwnedWorkspace, jsonResponse } from '../src/lib/authz.js';
import { getVideoDetailForWorkspace, analyzeVideoForWorkspace, mapAnalyzeOutcomeToHttp } from '../src/lib/video-service.js';
import { CREDIT_COSTS, InsufficientCreditsError, debitCredits, refundCredits, insufficientCreditsPayload, creditBalance } from '../src/lib/credits.js';
import { costBlock } from '../src/lib/next-steps.js';
import {
  HookTestError,
  startHookTest, getOpenTestForVideo, getLatestTestForVideo, updateHookTestMeta,
  pickHookVersions, rerollHooks, closeHookTest, exportShotlist,
} from '../src/lib/hook-tests.js';

export async function OPTIONS(): Promise<Response> {
  return corsPreflight();
}

/** Service error → HTTP status + body the site's ApiError can parse. */
function hookTestErrorResponse(err: unknown): Response {
  const status = err instanceof HookTestError ? err.httpStatus : 500;
  return jsonResponse(status, {
    error: 'hook_test_failed',
    message: err instanceof Error ? err.message : 'Hook test failed',
    ...(status !== 400 ? { status } : {}),
  });
}

/**
 * Metered wrapper around one hook-test action: pre-auth debit → work →
 * refund on failure. Identical money path to the create_brief/start_hook_test
 * tools so UI and MCP charge the same for the same move.
 */
async function runMetered(
  workspaceId: string,
  tool: string,
  cost: number,
  fn: () => Promise<object>,
): Promise<Response> {
  const opId = randomUUID();
  try {
    await debitCredits(workspaceId, cost, tool, `${opId}:preauth`);
  } catch (err) {
    if (err instanceof InsufficientCreditsError) return jsonResponse(402, insufficientCreditsPayload(err));
    throw err;
  }

  try {
    const result = await fn();
    const balance = await creditBalance(workspaceId);
    return jsonResponse(200, {
      ...result,
      creditsCharged: cost,
      creditsRemaining: balance.total,
      cost: costBlock(cost, { remaining: balance.total }),
    });
  } catch (err) {
    const balance = await refundCredits(workspaceId, cost, tool, `${opId}:fail`, 'call_failed');
    if (err instanceof HookTestError) {
      // Refunded before shaping: a rejected action never keeps the pre-auth,
      // even lifecycle rejections that fired after the debit.
      return jsonResponse(err.httpStatus === 409 ? 409 : 500, {
        error: 'hook_test_failed',
        message: err.message,
        status: err.httpStatus,
        creditsCharged: 0,
        creditsRemaining: balance.total,
        cost: costBlock(0, { remaining: balance.total, note: 'Pre-auth refunded.' }),
      });
    }
    return jsonResponse(500, {
      error: 'hook_test_failed',
      message: err instanceof Error ? err.message : 'Hook test failed',
      creditsCharged: 0,
      creditsRemaining: balance.total,
      cost: costBlock(0, { remaining: balance.total, note: 'Call failed — pre-auth refunded, nothing charged.' }),
    });
  }
}

export async function GET(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' });
  const action = url.searchParams.get('action');

  const auth = await requireOwnedWorkspace(request, url.searchParams.get('workspaceId'));
  if (!auth.ok) return auth.response;

  if (action === 'hook-test') {
    try {
      // Latest test of any status, so a won/closed test stays viewable
      // read-only behind its badge; mutations resolve through the open-only
      // lookup and keep refusing archived tests.
      const test = await getLatestTestForVideo(auth.workspace.id, videoId);
      return jsonResponse(200, { test });
    } catch (err) {
      if (err instanceof HookTestError && err.httpStatus === 404) {
        return jsonResponse(404, { error: 'video_not_found' });
      }
      throw err;
    }
  }

  if (action === 'hook-test-shotlist') {
    try {
      const markdown = await exportShotlist(await requireTestIdForVideo(auth.workspace.id, videoId), auth.workspace.id);
      return jsonResponse(200, { markdown });
    } catch (err) {
      return hookTestErrorResponse(err);
    }
  }

  const video = await getVideoDetailForWorkspace(auth.workspace, videoId);
  if (!video) return jsonResponse(404, { error: 'video_not_found' });
  return jsonResponse(200, video);
}

/** Resolve the open test id for a video, or null when none. */
async function requireTestIdForVideo(workspaceId: string, videoId: string): Promise<string> {
  const test = await getOpenTestForVideo(workspaceId, videoId);
  if (!test) throw new HookTestError('No open hook test for this video.', 404);
  return test.id;
}

export async function POST(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, (body.workspaceId as string) ?? null);
  if (!auth.ok) return auth.response;
  const wsId = auth.workspace.id;

  if (action === 'analyze') {
    const forceBackend = body.forceBackend === 'gemini-native' || body.forceBackend === 'gemini-text' || body.forceBackend === 'openrouter-video' ? body.forceBackend : undefined;
    const outcome = await analyzeVideoForWorkspace(auth.workspace, videoId, { forceBackend });

    // All error/status shaping lives in the pure mapper so it's unit-testable —
    // insufficient credits -> 402, Gemini quota -> 429 retryable, other -> 422.
    const mapped = mapAnalyzeOutcomeToHttp(outcome);
    return jsonResponse(mapped.status, mapped.body);
  }

  if (action === 'hook-test') {
    // Free pre-check first: starting on an already-tested video returns the
    // existing test WITHOUT charging — second attempts must never re-bill.
    const existing = await getOpenTestForVideo(wsId, videoId).catch(() => null);
    if (existing) return jsonResponse(200, { test: existing, alreadyOpen: true });

    return runMetered(wsId, 'start_hook_test', CREDIT_COSTS.startHookTest, async () => ({
      test: await startHookTest(wsId, videoId, {
        brandContext: typeof body.brandContext === 'string' ? body.brandContext : undefined,
        insight: typeof body.insight === 'string' ? body.insight : undefined,
      }),
    }));
  }

  if (action === 'hook-test-reroll') {
    return runMetered(wsId, 'reroll_hooks', CREDIT_COSTS.rerollHooks, async () => {
      const current = await requireTestIdForVideo(wsId, videoId);
      return { test: await rerollHooks(current, wsId) };
    });
  }

  if (action === 'hook-test-pick') {
    const picks = Array.isArray(body.picks) ? body.picks.filter((p): p is string => typeof p === 'string') : [];
    if (picks.length === 0) return jsonResponse(400, { error: 'picks array with at least one label is required' });
    try {
      const current = await requireTestIdForVideo(wsId, videoId);
      const test = await pickHookVersions(current, wsId, picks);
      return jsonResponse(200, { test });
    } catch (err) {
      return hookTestErrorResponse(err);
    }
  }

  if (action === 'hook-test-close') {
    const outcome = body.outcome === 'won' ? 'won' : undefined;
    const winner = typeof body.winner === 'string' ? body.winner : undefined;
    try {
      const current = await requireTestIdForVideo(wsId, videoId);
      const test = await closeHookTest(current, wsId, outcome, winner);
      return jsonResponse(200, { test });
    } catch (err) {
      return hookTestErrorResponse(err);
    }
  }

  return jsonResponse(404, { error: 'not_found' });
}

export async function PATCH(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const videoId = url.searchParams.get('id');
  const action = url.searchParams.get('action');
  if (!videoId) return jsonResponse(400, { error: 'video id is required' });
  if (action !== 'hook-test') return jsonResponse(404, { error: 'not_found' });

  let body: { workspaceId?: string; insight?: string; sameIn?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, { error: 'invalid_json' });
  }

  const auth = await requireOwnedWorkspace(request, body.workspaceId ?? null);
  if (!auth.ok) return auth.response;

  try {
    const current = await requireTestIdForVideo(auth.workspace.id, videoId);
    const test = await updateHookTestMeta(current, auth.workspace.id, {
      ...(typeof body.insight === 'string' ? { insight: body.insight } : {}),
      ...(Array.isArray(body.sameIn) ? { sameIn: body.sameIn.filter((c): c is string => typeof c === 'string') } : {}),
    });
    return jsonResponse(200, { test });
  } catch (err) {
    return hookTestErrorResponse(err);
  }
}
