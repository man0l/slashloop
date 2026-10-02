// Tests for the experiments MCP surface (src/tools/experiments.ts):
//   1. Registration — every lifecycle tool exists and takes an optional
//      workspaceId, through registerAllTools.
//   2. Success mapping — list/get/estimate/plan/generate/cancel/retry/delete
//      against a real in-memory Experiment store (SQLite through the store's
//      raw seam), not a mocked service.
//   3. Workspace scoping — an unowned workspace, and an experiment that lives
//      in another workspace.
//   4. Edit-mode payload — byte-identical to the site wizard's payload, and
//      accepted by the strict backend Create schema.
//   5. Revision conflicts — stale revisions on generate and on variant edit.
//   6. Spend gates — create/estimate are free, plan/generate/retry quote an
//      estimate and mark their next step as spending money.
//
// The fakes go in through the documented seams (swapActiveClientForTests,
// setCreditsForTests, setR2Bindings) rather than mock.module, per
// docs/test-suite-policy.md.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { z } from 'zod/v4';
import { swapActiveClientForTests, type AppPrismaClient, type RawStatement } from '../store.js';
import { setR2Bindings } from '../lib/storage-bindings.js';
import { runWithUser } from '../context.js';
import { registerExperimentTools, clampSlideCount, editInstructions } from './experiments.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

// ── environment ────────────────────────────────────────────────────────────
// store.batch() only routes to the raw executor on the sqlite dialect, so the
// in-memory database below needs DB_DIALECT=sqlite. Set inside beforeAll rather
// than at module scope: `bun test` loads every file before running any of them,
// so a module-level mutation here can be undone by another file's afterAll.
const savedDialect = process.env.DB_DIALECT;

const WS = 'ws-primary';
const OTHER_WS = 'ws-other';

const sql = new Database(':memory:');
sql.exec(`CREATE TABLE "Experiment" ("id" TEXT PRIMARY KEY, "workspaceId" TEXT, "status" TEXT,
  "version" INTEGER, "dataJson" TEXT, "createdAt" TEXT, "updatedAt" TEXT, "createKey" TEXT);
CREATE UNIQUE INDEX "Experiment_workspaceId_createKey_key" ON "Experiment" ("workspaceId", "createKey");`);

async function raw(statements: RawStatement[]): Promise<unknown[][]> {
  const out: unknown[][] = [];
  for (const s of statements) {
    out.push(sql.query(s.sql).all(...(s.params ?? []).map(v => (v instanceof Date ? v.toISOString() : v)) as never[]));
  }
  return out;
}

// ── fakes ──────────────────────────────────────────────────────────────────

const OWNERS: Record<string, string> = { [WS]: 'u1', [OTHER_WS]: 'u2' };
const WORKSPACE_CREDITS = 5000;

/** Balances live on the workspace row, so estimates read the same fake row. */
function workspaceRow(id: string) {
  return OWNERS[id] ? { id, ownerId: OWNERS[id], planCredits: WORKSPACE_CREDITS, packCredits: 0 } : null;
}

const videos = new Map<string, Record<string, unknown>>();
const deletedPaths: string[] = [];

function slideshowVideo(id: string, workspaceId: string, slides: number) {
  videos.set(id, {
    id, workspaceId, creatorHandle: 'maker', caption: 'prove me wrong', views: 75_600,
    durationSec: 0, mediaStatus: 'slideshow', thumbnailUrl: null,
    rawJson: JSON.stringify({ slideshowKeys: Array.from({ length: slides }, (_, i) => `w/${id}/${i}.jpg`) }),
  });
}

const restoreStore = swapActiveClientForTests({
  workspace: {
    findFirst: async ({ where }: { where: { id?: string; ownerId?: string } }) => {
      if (where.id) {
        const ownerId = OWNERS[where.id];
        if (!ownerId || (where.ownerId && where.ownerId !== ownerId)) return null;
        return { id: where.id, name: where.id, ownerId };
      }
      return { id: WS, name: 'primary', ownerId: where.ownerId ?? 'u1' };
    },
    // creditBalance() reads the balance through these two, so the estimates
    // come off the same fake workspace row rather than a credits stub.
    findUnique: async ({ where }: { where: { id: string } }) => workspaceRow(where.id),
    findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
      const row = workspaceRow(where.id);
      if (!row) throw new Error('workspace not found');
      return row;
    },
  },
  video: {
    findFirst: async ({ where }: { where: { id: string; source?: { workspaceId: string } } }) => {
      const v = videos.get(where.id);
      if (!v) return null;
      if (where.source?.workspaceId && v.workspaceId !== where.source.workspaceId) return null;
      return v;
    },
  },
  analysis: { findFirst: async () => null, findMany: async () => [] },
} as unknown as AppPrismaClient, raw);
afterAll(restoreStore);

beforeAll(() => {
  process.env.DB_DIALECT = 'sqlite';
  setR2Bindings({
    thumbs: { delete: async (paths: string[]) => { deletedPaths.push(...paths); } },
    media: { delete: async () => {} },
  } as unknown as Parameters<typeof setR2Bindings>[0]);
});
afterAll(() => {
  if (savedDialect === undefined) delete process.env.DB_DIALECT;
  else process.env.DB_DIALECT = savedDialect;
  setR2Bindings(null as unknown as Parameters<typeof setR2Bindings>[0]);
});

// ── tool harness ───────────────────────────────────────────────────────────

type Handler = (args: never) => Promise<ToolResult>;
interface ToolResult { content: Array<{ type: 'text'; text: string }>; isError?: true }
interface Captured { description: string; shape: Record<string, z.ZodTypeAny>; handler: Handler }

const tools = new Map<string, Captured>();
const fakeServer = {
  tool(name: string, description: string, shape: Record<string, z.ZodTypeAny>, handler: Handler) {
    tools.set(name, { description, shape, handler });
    return {};
  },
};
registerExperimentTools(fakeServer as unknown as McpServer);

/** Call a registered tool the way the SDK does: validate input (defaults!), then run. */
async function call(name: string, args: Record<string, unknown> = {}, user = 'u1') {
  const tool = tools.get(name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  const parsed = z.object(tool.shape).parse(args);
  const result = await runWithUser(user, () => tool.handler(parsed as never));
  return { ...result, json: JSON.parse(result.content[0]!.text) as Record<string, any> };
}

// ── fixtures ───────────────────────────────────────────────────────────────

function slide(role: string, overlay = '') {
  return { role, scene: 'A mug of tea on a wooden table, morning light', overlayText: overlay };
}
function brief(hook: string, overlays: string[] = []) {
  return {
    concept: 'A calmer morning', hook, character: 'A woman in her thirties', visualStyle: 'warm natural light',
    caption: 'Tea time', cta: 'Follow for more', lockedConstraints: [],
    slides: [slide('hook', overlays[0] ?? ''), slide('body', overlays[1] ?? ''), slide('body', overlays[2] ?? '')],
  };
}
function variant(id: string, hook: string, changed: Array<{ name: 'hook'; value: string }>) {
  return {
    id, title: id === 'v-base' ? 'Baseline' : 'New hook', hypothesis: 'h',
    changedVariables: changed, brief: brief(hook),
    revision: 1, status: 'draft', baselineId: null, generationBasis: 'source-referenced' as const,
    history: [], frozenBrief: null, slides: [], error: null,
  };
}
/** A planned experiment sitting in `review`, ready to be edited or generated. */
function reviewExperiment(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'e1', workspaceId: WS, status: 'review', version: 0,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    instructions: {
      goal: 'Beat the baseline hook', brand: '', audience: '', language: 'English', direction: '',
      lockedConstraints: [], variables: ['hook'], mode: 'controlled',
    },
    variantCount: 2, slideCount: 3, maxCredits: 100, creditsCharged: 6,
    report: { summary: 'Hooks win', patterns: [] }, inputs: [], error: null,
    generationBasis: 'source-referenced', assetPolicy: 'retained',
    tasks: [], commands: {}, allowPartial: false, createFingerprint: 'fp',
    variants: [variant('v-base', 'Original hook', []), variant('v-alt', 'A sharper hook', [{ name: 'hook', value: 'A sharper hook' }])],
    ...over,
  };
}

const { load, create } = await import('../experiments/store.js');
async function seedReview(experiment: Record<string, unknown> = reviewExperiment()) {
  await create(experiment as never, `seed-${experiment.id}-${experiment.status}`);
  return experiment;
}

beforeEach(() => {
  // The in-memory database outlives a single test, so every test starts empty.
  sql.exec('DELETE FROM "Experiment"');
  videos.clear();
  deletedPaths.length = 0;
});

// ── 1. registration ────────────────────────────────────────────────────────

describe('experiments tool registration', () => {
  test('every lifecycle tool is registered with an optional workspaceId', () => {
    expect([...tools.keys()].sort()).toEqual([
      'cancel_experiment', 'create_experiment', 'delete_experiment', 'edit_experiment_variant',
      'estimate_experiment', 'generate_experiment', 'get_experiment', 'list_experiments',
      'plan_experiment', 'retry_experiment',
    ]);
    const missing: string[] = [];
    for (const [name, tool] of tools) {
      const shape = tool.shape.workspaceId;
      if (!(shape instanceof z.ZodOptional) || !(shape.unwrap() instanceof z.ZodString)) missing.push(name);
    }
    expect(missing).toEqual([]);
  });

  test('registerAllTools includes the experiments module', async () => {
    const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
    const { registerAllTools } = await import('../register-tools.js');
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerAllTools(server);
    const registered = (server as unknown as { _registeredTools: Record<string, { description?: string }> })._registeredTools;
    for (const name of tools.keys()) expect(registered[name]?.description).toBeTruthy();
  });

  test('spend and draft behaviour is stated in the tool descriptions', () => {
    expect(tools.get('create_experiment')!.description).toMatch(/SPENDS NOTHING/);
    expect(tools.get('create_experiment')!.description).toMatch(/estimate_experiment/);
    for (const name of ['plan_experiment', 'generate_experiment', 'retry_experiment']) {
      expect(tools.get(name)!.description).toMatch(/SPENDS CREDITS/);
      expect(tools.get(name)!.description).toMatch(/estimate/);
    }
    for (const name of ['list_experiments', 'get_experiment', 'estimate_experiment', 'edit_experiment_variant', 'cancel_experiment']) {
      expect(tools.get(name)!.description).toMatch(/[Ff]ree/);
    }
  });
});

// ── 2/3. read, scoping and error mapping ───────────────────────────────────

describe('reading experiments', () => {
  test('list_experiments paginates and summarises, detail=full mirrors the REST record', async () => {
    await seedReview(reviewExperiment({ id: 'e1', createdAt: '2026-09-01' }));
    await seedReview(reviewExperiment({ id: 'e2', createdAt: '2026-09-02' }));

    const page = await call('list_experiments', { limit: 1 });
    expect(page.isError).toBeUndefined();
    expect(page.json.experiments.map((e: any) => e.id)).toEqual(['e2']);
    expect(page.json.nextOffset).toBe(1);
    expect(page.json.experiments[0]).toMatchObject({
      status: 'review', goal: 'Beat the baseline hook', variables: ['hook'],
      credits: { charged: 6, max: 100, remaining: 94 },
    });
    expect(page.json.experiments[0].variants).toEqual([
      { id: 'v-base', title: 'Baseline', status: 'draft', revision: 1 },
      { id: 'v-alt', title: 'New hook', status: 'draft', revision: 1 },
    ]);

    const full = await call('list_experiments', { detail: 'full' });
    expect(full.json.experiments.map((e: any) => e.id).sort()).toEqual(['e1', 'e2']);
    expect(full.json.experiments[0].providerBudget).toBeDefined();
    expect(full.json.experiments[0].jobs).toEqual([]);

    const last = await call('list_experiments', { limit: 1, offset: 1 });
    expect(last.json.experiments.map((e: any) => e.id)).toEqual(['e1']);
    expect(last.json.nextOffset).toBeNull();
  });

  test('get_experiment returns the record and points at the next free move', async () => {
    await seedReview();
    const res = await call('get_experiment', { experimentId: 'e1' });
    expect(res.isError).toBeUndefined();
    expect(res.json.experiment.id).toBe('e1');
    expect(res.json.experiment.variants.map((v: any) => v.id)).toEqual(['v-base', 'v-alt']);
    const steps = res.json.nextSteps.map((s: any) => s.tool);
    expect(steps).toContain('estimate_experiment');
    expect(steps).toContain('generate_experiment');
    expect(res.json.nextSteps.find((s: any) => s.tool === 'generate_experiment').spendsMoney).toBe(true);
  });

  test('an unowned workspace is a scoping error, not a crash', async () => {
    const res = await call('list_experiments', { workspaceId: 'ws-nope' });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe('workspace_not_found');
    expect(res.json.message).toMatch(/list_workspaces/);
  });

  test('another workspace\'s experiment reads as not found', async () => {
    await seedReview(reviewExperiment({ id: 'e-theirs', workspaceId: OTHER_WS }));
    const res = await call('get_experiment', { experimentId: 'e-theirs' });
    expect(res.isError).toBe(true);
    expect(res.json).toMatchObject({ error: 'experiment_not_found', statusCode: 404 });
  });

  test('unknown ids and schema violations map to the REST error codes', async () => {
    expect((await call('get_experiment', { experimentId: 'nope' })).json)
      .toMatchObject({ error: 'experiment_not_found', statusCode: 404 });
    // A variant that changes something the experiment never approved is a 422
    // from validateVariants, with the same code the REST route returns. The
    // seeded v-alt moves the cta, which is not in instructions.variables.
    const smuggled = variant('v-alt', 'A sharper hook', []);
    smuggled.brief = { ...smuggled.brief, cta: 'Buy now' };
    await seedReview(reviewExperiment({
      variants: [variant('v-base', 'Original hook', []), smuggled],
    }));
    const res = await call('edit_experiment_variant', {
      experimentId: 'e1', variantId: 'v-base', revision: 1, brief: brief('New baseline hook'),
    });
    expect(res.json).toMatchObject({ error: 'unapproved_variable', statusCode: 422 });
    // Nothing was written: the rejection happens before the save.
    expect((await load(WS, 'e1')).version).toBe(0);
  });

  test('editing the baseline re-derives the variant delta labels', async () => {
    await seedReview();
    const res = await call('edit_experiment_variant', {
      experimentId: 'e1', variantId: 'v-base', revision: 1, brief: { ...brief('A calmer start'), hook: 'A calmer start' },
    });
    expect(res.isError).toBeUndefined();
    const alt = res.json.experiment.variants.find((v: any) => v.id === 'v-alt');
    // Factual labels, not the stale model label: only the hook differs now.
    expect(alt.changedVariables).toEqual([{ name: 'hook', value: 'A sharper hook' }]);
  });
});

// ── 4. create (draft only) ─────────────────────────────────────────────────

describe('create_experiment', () => {
  test('edit mode reproduces the site wizard payload exactly and spends nothing', async () => {
    slideshowVideo('v1', WS, 5);
    const res = await call('create_experiment', {
      mode: 'edit', videoId: 'v1', hook: 'Stop doing this', overlayTexts: ['Three things I wish I knew', ''],
    });
    expect(res.isError).toBeUndefined();
    const { experiment, cost, estimate, nextSteps } = res.json;
    expect(experiment.status).toBe('draft');
    // Draft-only: nothing charged, and the only spending edge is flagged.
    expect(cost.credits).toBe(0);
    expect(estimate.plan.totalCredits).toBeGreaterThan(0);
    expect(nextSteps.find((s: any) => s.tool === 'plan_experiment')).toMatchObject({ spendsMoney: true });

    // Exactly the wizard's edit payload (src/ui/gallery.ts buildPayload). The
    // stored goal additionally carries the service's source tag — the list
    // title differentiator the site gets too — so compare the fixed part.
    expect(experiment.instructions.goal).toStartWith('Edit the slideshow overlay text, keeping the same images.');
    expect(experiment.instructions.variables).toEqual(['hook']);
    expect(experiment.instructions.mode).toBe('controlled');
    expect(experiment.instructions.lockedConstraints).toEqual([]);
    expect(experiment.instructions.direction).toBe(
      'Render the exact overlay texts. Slide 1 (hook): "Stop doing this" (empty clears it too) '
      + 'Slide 2: "Three things I wish I knew" Slide 3: "" (strip — no text)',
    );
    expect(experiment.variantCount).toBe(2);
    expect(experiment.maxCredits).toBe(100);
    // The source's own story count wins over the requested fallback.
    expect(experiment.slideCount).toBe(5);
  });

  test('the edit payload satisfies the strict Create schema and drops surveyMode', async () => {
    slideshowVideo('v1', WS, 5);
    await call('create_experiment', { mode: 'edit', videoId: 'v1', hook: 'A hook', overlayTexts: ['B'] });
    const created = (await sql.query('SELECT "dataJson" FROM "Experiment"').all() as Array<{ dataJson: string }>)[0]!;
    const stored = JSON.parse(created.dataJson);
    const { Create } = await import('../experiments/schema.js');
    const body = {
      workspaceId: stored.workspaceId, videoIds: stored.inputs.map((i: any) => i.videoId),
      instructions: stored.instructions, variantCount: stored.variantCount, slideCount: stored.slideCount,
      maxCredits: stored.maxCredits, idempotencyKey: '12345678',
    };
    expect(Create.safeParse(body).success).toBe(true);
    // surveyMode is a UI-only marker: the strict schema refuses it outright.
    expect(Create.safeParse({ ...body, surveyMode: 'edit' }).success).toBe(false);
  });

  test('editInstructions mirrors the site wording and order', () => {
    expect(editInstructions({ hook: ' H ', overlayTexts: [' second ', ''], language: '' }).direction).toBe(
      'Render the exact overlay texts. Slide 1 (hook): "H" (empty clears it too) '
      + 'Slide 2: "second" Slide 3: "" (strip — no text)',
    );
    expect(editInstructions({ hook: 'H', overlayTexts: [] }).language).toBe('English');
    expect(() => editInstructions({ hook: '', overlayTexts: [] })).toThrow(/Nothing to change/);
  });

  test('slide counts are clamped to 3-8 like the wizard', () => {
    expect([1, 3, 5, 9, 12].map(clampSlideCount)).toEqual([3, 3, 5, 8, 8]);
  });

  test('create mode is controlled, and angle forces exploration', async () => {
    slideshowVideo('v1', WS, 5);
    slideshowVideo('v2', WS, 4);
    const controlled = await call('create_experiment', {
      mode: 'create', videoIds: ['v1', 'v2'], goal: 'Beat the baseline', variables: ['hook', 'cta'],
    });
    expect(controlled.isError).toBeUndefined();
    expect(controlled.json.experiment.instructions.mode).toBe('controlled');
    // Story count is derived from the smallest source.
    expect(controlled.json.experiment.slideCount).toBe(4);
    expect(controlled.json.experiment.variantCount).toBe(3);
    expect(controlled.json.experiment.maxCredits).toBe(200);

    const exploratory = await call('create_experiment', {
      mode: 'create', videoIds: ['v1'], goal: 'Retell the story', variables: ['angle'],
    });
    expect(exploratory.json.experiment.instructions.mode).toBe('exploration');
    expect(exploratory.json.experiment.instructions.variables).toEqual(['concept']);
  });

  test('create mode refuses a non-slideshow and asks for the missing brief', async () => {
    videos.set('v1', { id: 'v1', workspaceId: WS, creatorHandle: 'm', caption: '', views: 1, durationSec: 12, rawJson: '{}' });
    expect((await call('create_experiment', { mode: 'create', videoIds: ['v1'], goal: 'g', variables: ['hook'] })).json)
      .toMatchObject({ error: 'video_not_slideshow', statusCode: 400 });
    slideshowVideo('v1', WS, 5);
    // Missing goal, missing variables, and missing videos each say what is
    // missing instead of failing somewhere inside the schema.
    expect((await call('create_experiment', { mode: 'create', videoIds: ['v1'], variables: ['hook'] })).json.message)
      .toMatch(/needs a goal/);
    expect((await call('create_experiment', { mode: 'create', videoIds: ['v1'], goal: 'g' })).json.message)
      .toMatch(/at least one variable/);
    expect((await call('create_experiment', { mode: 'create', goal: 'g', variables: ['hook'] })).json.message)
      .toMatch(/needs videoIds/);
    expect((await call('create_experiment', { mode: 'edit', hook: 'h' })).json.message).toMatch(/needs videoId/);
  });

  test('a strict-schema violation comes back as invalid_request, not a crash', async () => {
    slideshowVideo('v1', WS, 5);
    // Duplicate variables pass the tool's own shape but the backend's
    // Instructions refinement rejects them — the error must still be mapped.
    const res = await call('create_experiment', {
      mode: 'create', videoIds: ['v1'], goal: 'g', variables: ['hook', 'hook'],
    });
    expect(res.isError).toBe(true);
    expect(res.json.error).toBe('invalid_request');
    expect(res.json.issues[0].message).toMatch(/Duplicate variables/);
  });
});

// ── 5/6. plan, edit, generate, retry, cancel, delete ───────────────────────

describe('plan_experiment', () => {
  test('quotes the plan estimate, then moves the draft to planning', async () => {
    slideshowVideo('v1', WS, 5);
    const draft = await call('create_experiment', { mode: 'edit', videoId: 'v1', hook: 'H', overlayTexts: ['B'] });
    const id = draft.json.experiment.id;

    const res = await call('plan_experiment', { experimentId: id });
    expect(res.isError).toBeUndefined();
    expect(res.json.experiment.status).toBe('planning');
    // The estimate is quoted from the PRE-transition state: a draft with one
    // un-analysed source (5) plus report + briefs (2 + 2).
    expect(res.json.estimate.plan).toMatchObject({ analysisCredits: 5, planningCredits: 4, totalCredits: 9 });
    expect(res.json.cost).toMatchObject({ credits: 0, quoted: true });
    expect(res.json.idempotencyKey).toBeString();
    expect(res.json.nextSteps.map((s: any) => s.tool)).toEqual(['get_experiment']);

    // A draft can only be planned once: not_draft, not a second charge.
    const again = await call('plan_experiment', { experimentId: id });
    expect(again.json).toMatchObject({ error: 'not_draft', statusCode: 409 });
  });

  test('replaying an idempotency key does not plan twice', async () => {
    slideshowVideo('v1', WS, 5);
    const draft = await call('create_experiment', { mode: 'edit', videoId: 'v1', hook: 'H', overlayTexts: ['B'] });
    const id = draft.json.experiment.id;
    const key = 'plan-key-0001';
    const first = await call('plan_experiment', { experimentId: id, idempotencyKey: key });
    const replay = await call('plan_experiment', { experimentId: id, idempotencyKey: key });
    expect(replay.isError).toBeUndefined();
    expect(replay.json.experiment.version).toBe(first.json.experiment.version);
    // The same key with a different body is refused, exactly as on REST.
    expect((await call('plan_experiment', { experimentId: id, idempotencyKey: key, allowPartial: true })).json)
      .toMatchObject({ error: 'idempotency_conflict', statusCode: 409 });
  });
});

describe('estimate_experiment', () => {
  test('is free and quotes plan and generate without touching the experiment', async () => {
    await seedReview();
    const before = await load(WS, 'e1');

    // A review-state experiment has nothing left to plan, and the quote says so
    // rather than inventing a price.
    const plan = await call('estimate_experiment', { experimentId: 'e1', stage: 'plan' });
    expect(plan.isError).toBeUndefined();
    expect(plan.json.estimate).toMatchObject({
      analysisCredits: 0, planningCredits: 0, totalCredits: 0,
      maxCredits: 100, workspaceCredits: WORKSPACE_CREDITS,
    });
    expect(plan.json.cost).toMatchObject({ credits: 0, quoted: true });
    expect(plan.json.nextSteps[0]).toMatchObject({ tool: 'plan_experiment', spendsMoney: true, cost: '0 credits' });

    const generate = await call('estimate_experiment', { experimentId: 'e1', stage: 'generate', variantIds: ['v-alt'] });
    // 3 slides x 10 credits x SLIDE_FANOUT(3).
    expect(generate.json.estimate).toMatchObject({ generationCredits: 90, totalCredits: 90 });
    expect(generate.json.nextSteps[0].cost).toBe('90 credits');

    expect((await load(WS, 'e1')).version).toBe(before.version);
  });

  test('refuses the strict-estimate violations REST refuses', async () => {
    await seedReview();
    expect((await call('estimate_experiment', { experimentId: 'e1', stage: 'plan', variantIds: ['v-alt'] })).json)
      .toMatchObject({ error: 'variantIds_only_for_generation', statusCode: 400 });
    expect((await call('estimate_experiment', { experimentId: 'e1', stage: 'generate', variantIds: ['ghost'] })).json)
      .toMatchObject({ error: 'variant_not_found', statusCode: 404 });
  });
});

describe('edit_experiment_variant', () => {
  test('replaces the brief, bumps the revision, and stays free', async () => {
    await seedReview();
    const res = await call('edit_experiment_variant', {
      experimentId: 'e1', variantId: 'v-alt', revision: 1,
      brief: { ...brief('A sharper hook'), hook: 'The hook that actually worked' },
    });
    expect(res.isError).toBeUndefined();
    expect(res.json.editedVariant).toMatchObject({ id: 'v-alt', revision: 2 });
    expect(res.json.experiment.variants.find((v: any) => v.id === 'v-alt').brief.hook).toBe('The hook that actually worked');
    expect(res.json.cost).toMatchObject({ credits: 0 });
    expect(res.json.cost.note).toMatch(/free/i);
  });

  test('a stale revision is refused with revision_conflict', async () => {
    await seedReview();
    await call('edit_experiment_variant', {
      experimentId: 'e1', variantId: 'v-alt', revision: 1, brief: { ...brief('A sharper hook'), hook: 'First edit' },
    });
    const stale = await call('edit_experiment_variant', {
      experimentId: 'e1', variantId: 'v-alt', revision: 1, brief: { ...brief('A sharper hook'), hook: 'Second edit' },
    });
    expect(stale.isError).toBe(true);
    expect(stale.json).toMatchObject({ error: 'revision_conflict', statusCode: 409 });
    const stored = await load(WS, 'e1');
    expect(stored.variants.find(v => v.id === 'v-alt')!.brief.hook).toBe('First edit');
    // A revision that never existed is refused the same way.
    expect((await call('edit_experiment_variant', {
      experimentId: 'e1', variantId: 'v-alt', revision: 99, brief: brief('x'),
    })).json).toMatchObject({ error: 'revision_conflict', statusCode: 409 });
  });
});

describe('generate_experiment', () => {
  test('quotes the generate estimate, then renders at the given revisions', async () => {
    await seedReview();
    const res = await call('generate_experiment', {
      experimentId: 'e1', variants: [{ id: 'v-alt', revision: 1 }],
    });
    expect(res.isError).toBeUndefined();
    expect(res.json.estimate.generate).toMatchObject({ generationCredits: 90, totalCredits: 90 });
    expect(res.json.cost).toMatchObject({ credits: 0, quoted: true });
    expect(res.json.experiment.status).toBe('generating');
    const rendered = res.json.experiment.variants.find((v: any) => v.id === 'v-alt');
    expect(rendered.status).toBe('generating');
    expect(rendered.slides).toHaveLength(3);
    expect(res.json.experiment.jobs.filter((j: any) => j.kind === 'slide')).toHaveLength(3);
  });

  test('a stale variant revision is refused instead of rendering the wrong brief', async () => {
    await seedReview();
    const res = await call('generate_experiment', { experimentId: 'e1', variants: [{ id: 'v-alt', revision: 7 }] });
    expect(res.isError).toBe(true);
    expect(res.json).toMatchObject({ error: 'revision_conflict', statusCode: 409 });
    expect((await load(WS, 'e1')).status).toBe('review');
  });

  test('an experiment that is not in review cannot be generated', async () => {
    await seedReview(reviewExperiment({ id: 'e1', status: 'cancelled' }));
    expect((await call('generate_experiment', { experimentId: 'e1', variants: [{ id: 'v-alt', revision: 1 }] })).json)
      .toMatchObject({ error: 'not_reviewable', statusCode: 409 });
  });
});

describe('retry_experiment and cancel_experiment', () => {
  test('retry re-queues failed jobs, quotes their cost, and is flagged as spending', async () => {
    const rendered = variant('v-alt', 'A sharper hook', [{ name: 'hook', value: 'A sharper hook' }]);
    rendered.status = 'failed';
    // A generating variant always owns a slide per storyboard slide — retry
    // writes back through that array by index.
    rendered.slides = [0, 1, 2].map(index => ({ index, status: 'pending', url: null, path: null, error: null, overlayText: '' }));
    await seedReview(reviewExperiment({
      id: 'e1', status: 'paused', creditsCharged: 6,
      tasks: [
        { id: 't-slide', kind: 'slide', target: 'v-alt', index: 0, status: 'failed', attempts: 1, charged: 10, error: 'x' },
        { id: 't-done', kind: 'slide', target: 'v-alt', index: 1, status: 'done', attempts: 1, charged: 10 },
      ],
      variants: [variant('v-base', 'Original hook', []), rendered],
    }));
    const res = await call('retry_experiment', { experimentId: 'e1', taskIds: ['t-slide'] });
    expect(res.isError).toBeUndefined();
    // Per-job price: one slide x 10 credits x fanout 3.
    expect(res.json.estimate.retry).toMatchObject({ generationCredits: 30, totalCredits: 30 });
    expect(res.json.cost).toMatchObject({ credits: 0, quoted: true });
    expect(res.json.experiment.status).toBe('generating');
    expect(res.json.experiment.jobs.find((j: any) => j.id === 't-slide').status).toBe('pending');
    expect(res.json.nextSteps.map((s: any) => s.tool)).toEqual(['get_experiment']);
  });

  test('retry refuses what cannot be retried', async () => {
    await seedReview(reviewExperiment({ id: 'e1', status: 'review' }));
    expect((await call('retry_experiment', { experimentId: 'e1' })).json)
      .toMatchObject({ error: 'not_retryable', statusCode: 409 });
  });

  test('cancel is free, idempotent and stops the variants', async () => {
    await seedReview(reviewExperiment({
      id: 'e1', status: 'generating',
      variants: [variant('v-base', 'Original hook', []), { ...variant('v-alt', 'A sharper hook', [{ name: 'hook', value: 'A sharper hook' }]), status: 'generating' }],
    }));
    const res = await call('cancel_experiment', { experimentId: 'e1', idempotencyKey: 'cancel-0001' });
    expect(res.isError).toBeUndefined();
    expect(res.json.experiment.status).toBe('cancelled');
    expect(res.json.experiment.variants.find((v: any) => v.id === 'v-alt').status).toBe('cancelled');
    expect(res.json.cost).toMatchObject({ credits: 0 });
    const replay = await call('cancel_experiment', { experimentId: 'e1', idempotencyKey: 'cancel-0001' });
    expect(replay.isError).toBeUndefined();
    expect(replay.json.experiment.version).toBe(res.json.experiment.version);
  });
});

describe('delete_experiment', () => {
  test('removes the row and its retained images', async () => {
    await seedReview(reviewExperiment({
      id: 'e1', status: 'completed',
      tasks: [{ id: 't1', kind: 'slide', target: 'v-alt', index: 0, status: 'done', attempts: 1, charged: 10, path: 'w/e1/0.jpg' }],
      variants: [
        variant('v-base', 'Original hook', []),
        { ...variant('v-alt', 'A sharper hook', [{ name: 'hook', value: 'A sharper hook' }]), slides: [{ index: 0, status: 'done', url: null, path: 'w/e1/1.jpg', error: null, overlayText: '' }] },
      ],
    }));
    const res = await call('delete_experiment', { experimentId: 'e1' });
    expect(res.isError).toBeUndefined();
    expect(res.json).toMatchObject({ experimentId: 'e1', deleted: true, imagesRemoved: 2 });
    expect(deletedPaths.sort()).toEqual(['w/e1/0.jpg', 'w/e1/1.jpg']);
    await expect(load(WS, 'e1')).rejects.toThrow('experiment_not_found');
  });

  test('a running experiment must be cancelled first', async () => {
    await seedReview(reviewExperiment({ id: 'e1', status: 'generating' }));
    expect((await call('delete_experiment', { experimentId: 'e1' })).json)
      .toMatchObject({ error: 'active_experiment', statusCode: 409 });
    expect((await load(WS, 'e1')).status).toBe('generating');
  });
});