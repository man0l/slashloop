// Tests for the experiment MCP tools (src/tools/experiments.ts). The tools are
// thin wrappers, so these drive them through a real MCP client/server pair
// with injected fakes (ExperimentToolDeps) and assert the wrapper contract:
// workspace scoping, one experiment per source, stable idempotency keys, the
// approvedCredits gate, error shaping, and the read-side progress summary.
import { beforeEach, describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Command, Create, EditBrief, Generate, Plan, Retry, ExperimentError, Key, type Experiment } from '../experiments/schema.js';
import {
  registerExperimentTools, defaultExperimentCap, derivedKey, editSlideDirection, editInstructions,
  EDIT_COPY_MAX, EDIT_GOAL, EDIT_MAX_CREDITS, EDIT_VARIANT_COUNT, type ExperimentToolDeps,
} from './experiments.js';

const TOOLS = [
  'list_experiments', 'get_experiment', 'create_experiment', 'estimate_experiment', 'plan_experiment',
  'update_experiment_variant', 'generate_experiment', 'retry_experiment', 'cancel_experiment', 'delete_experiment',
];

function exp(id: string, over: Partial<Experiment> = {}): Experiment {
  return {
    id, workspaceId: 'w1', status: 'draft', createdAt: '2026-09-30T00:00:00Z', updatedAt: '2026-09-30T00:00:00Z',
    instructions: { goal: 'Find a hook', brand: '', audience: '', language: 'English', direction: '', lockedConstraints: [], variables: ['hook'], mode: 'controlled' },
    variantCount: 3, slideCount: 3, maxCredits: 920, creditsCharged: 0, report: null,
    inputs: [{ videoId: 'vid1', status: 'pending', analysisId: null, jobId: null, error: null, coverage: null, evidence: [] }],
    variants: [], error: null, generationBasis: 'source-referenced', assetPolicy: 'retained', version: 0,
    tasks: [], commands: {}, allowPartial: false, createFingerprint: 'fp',
    ...over,
  };
}

type Call = { fn: string; args: unknown[] };
let calls: Call[];
let store: Map<string, Experiment>;
let estimateTotal: number;
let createFailures: Record<string, ExperimentError>;
let mutateError: ExperimentError | null;

function fakes(): ExperimentToolDeps {
  const record = (fn: string, args: unknown[]) => calls.push({ fn, args });
  return {
    resolveWorkspace: async ({ workspaceId }) => {
      if (workspaceId && workspaceId !== 'w1') throw new Error('Workspace not found.');
      return { id: 'w1' };
    },
    createExperiment: (async (raw: any) => {
      record('createExperiment', [raw]);
      const failure = createFailures[raw.videoIds[0]];
      if (failure) throw failure;
      const id = `e-${raw.idempotencyKey.replace(/[^a-zA-Z0-9]/g, '').slice(-10)}`;
      const e = store.get(id) ?? exp(id, { maxCredits: raw.maxCredits, inputs: [{ ...exp(id).inputs[0]!, videoId: raw.videoIds[0] }] });
      store.set(id, e);
      return e;
    }) as ExperimentToolDeps['createExperiment'],
    estimate: (async (e: Experiment, stage: string, variantIds?: string[], taskIds?: string[]) => {
      record('estimate', [e.id, stage, variantIds, taskIds]);
      return { analysisCredits: 0, planningCredits: 0, generationCredits: 0, totalCredits: estimateTotal, remainingCredits: e.maxCredits, workspaceCredits: 1000, maxCredits: e.maxCredits, generationBasis: e.generationBasis, exactProviderUsdCap: false, maxProviderRequests: 1, pricing: { analysis: 5, planningCall: 2, slide: 10 } };
    }) as unknown as ExperimentToolDeps['estimate'],
    mutate: (async (ws: string, id: string, action: string, body: unknown, variantId?: string) => {
      record('mutate', [ws, id, action, body, variantId]);
      if (mutateError) throw mutateError;
      const e = store.get(id);
      if (!e) throw new ExperimentError(404, 'experiment_not_found');
      return e;
    }) as ExperimentToolDeps['mutate'],
    load: async (ws: string, id: string) => {
      record('load', [ws, id]);
      const e = store.get(id);
      if (!e || e.workspaceId !== ws) throw new ExperimentError(404, 'experiment_not_found');
      return e;
    },
    list: async (ws: string, limit = 50, offset = 0) => {
      record('list', [ws, limit, offset]);
      return [...store.values()].slice(offset, offset + limit);
    },
    // The real projection lives in store.ts; a marker proves the tool routes through deps.serialize.
    serialize: ((e: Experiment) => ({ ...e, projected: true })) as unknown as ExperimentToolDeps['serialize'],
    deleteExperiment: async (ws: string, id: string) => { record('deleteExperiment', [ws, id]); return { deleted: true as const }; },
    deleteExperiments: async (ws: string, ids: string[]) => { record('deleteExperiments', [ws, ids]); return { deleted: ids.length, failed: [] }; },
  };
}

async function connect() {
  const server = new McpServer({ name: 'test', version: '0.0.0' });
  registerExperimentTools(server, fakes());
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}
async function call(name: string, args: Record<string, unknown>) {
  const client = await connect();
  const res = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: Boolean(res.isError), body: JSON.parse(res.content[0]!.text) };
}
const callsOf = (fn: string) => calls.filter(c => c.fn === fn).map(c => c.args);
const instructions = { goal: 'Find a hook that earns the first swipe', variables: ['hook'] };

beforeEach(() => {
  calls = []; store = new Map(); estimateTotal = 9; createFailures = {}; mutateError = null;
});

describe('tool surface', () => {
  test('all experiment tools list with JSON schemas and an optional workspaceId', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const byName = new Map(tools.map(t => [t.name, t]));
    for (const name of TOOLS) {
      const tool = byName.get(name);
      expect(tool).toBeDefined();
      expect((tool!.inputSchema.properties as Record<string, unknown>).workspaceId).toBeDefined();
      expect(tool!.inputSchema.required ?? []).not.toContain('workspaceId');
    }
    expect(byName.get('list_experiments')!.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('delete_experiment')!.annotations?.destructiveHint).toBe(true);
  });

  test('registered by registerAllTools', async () => {
    const { registerAllTools } = await import('../register-tools.js');
    const server = new McpServer({ name: 'test', version: '0.0.0' });
    registerAllTools(server);
    const names = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    for (const name of TOOLS) expect(names).toContain(name);
  });
});

describe('create_experiment', () => {
  test('one isolated experiment per source video, scoped to the resolved workspace', async () => {
    const { isError, body } = await call('create_experiment', { videoIds: ['vid1', 'vid2'], instructions });
    expect(isError).toBe(false);
    const creates = callsOf('createExperiment').map(a => a[0] as any);
    expect(creates.map(c => c.videoIds)).toEqual([['vid1'], ['vid2']]);
    for (const c of creates) {
      expect(c.workspaceId).toBe('w1');
      expect(c.maxCredits).toBe(defaultExperimentCap(3, 5));
      expect(c.instructions).toMatchObject({ language: 'English', mode: 'controlled', lockedConstraints: [], brand: '' });
      expect(Key.safeParse(c.idempotencyKey).success).toBe(true);
      // What reaches the service must satisfy its canonical (strict) schema.
      expect(Create.safeParse(c).success).toBe(true);
    }
    expect(creates[0].idempotencyKey).not.toBe(creates[1].idempotencyKey);
    expect(body.experiments).toHaveLength(2);
    expect(body.experiments[0].planEstimate.totalCredits).toBe(9);
    expect(body.nextSteps[0]).toMatchObject({ tool: 'plan_experiment', spendsMoney: true, args: { approvedCredits: 9 } });
  });

  test('an identical retry derives the same keys (no duplicate drafts)', async () => {
    await call('create_experiment', { videoIds: ['vid1', 'vid2'], instructions });
    await call('create_experiment', { videoIds: ['vid1', 'vid2'], instructions });
    const keys = callsOf('createExperiment').map(a => (a[0] as any).idempotencyKey);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).toBe(keys[3]);
    expect(store.size).toBe(2);
  });

  test('a client key is used as-is for one source and suffixed per source for several', async () => {
    await call('create_experiment', { videoIds: ['vid1'], instructions, idempotencyKey: 'client-key-1' });
    await call('create_experiment', { videoIds: ['vid1', 'vid2'], instructions, idempotencyKey: 'client-key-2' });
    expect(callsOf('createExperiment').map(a => (a[0] as any).idempotencyKey)).toEqual(['client-key-1', 'client-key-2:1', 'client-key-2:2']);
  });

  test('per-source failures are reported without aborting the rest', async () => {
    createFailures.vid2 = new ExperimentError(400, 'video_not_slideshow', 'Only slideshows can be selected for experiments.');
    const { isError, body } = await call('create_experiment', { videoIds: ['vid1', 'vid2'], instructions });
    expect(isError).toBe(false);
    expect(body.experiments).toHaveLength(1);
    expect(body.failed[0]).toMatchObject({ videoId: 'vid2', error: 'video_not_slideshow', status: 400 });
    expect(body.failed[0].hint).toBeString();
  });

  test('duplicate videoIds are refused before anything is created', async () => {
    const { isError, body } = await call('create_experiment', { videoIds: ['vid1', 'vid1'], instructions });
    expect(isError).toBe(true);
    expect(body.error).toBe('invalid_request');
    expect(callsOf('createExperiment')).toHaveLength(0);
  });

  test('create mode without instructions says what is missing', async () => {
    const { isError, body } = await call('create_experiment', { videoIds: ['vid1'] });
    expect(isError).toBe(true);
    expect(body.message).toMatch(/instructions/);
    expect(callsOf('createExperiment')).toHaveLength(0);
  });

  // ---- edit mode (the site's "Edit slideshow" wizard path) ----

  test('edit mode sends the site\'s payload: one deck, hook variable, 2 variants, 100 credits', async () => {
    const { isError, body } = await call('create_experiment', {
      mode: 'edit', videoIds: ['vid1'], hook: 'Stop doing this', overlayTexts: ['Three things I wish I knew', ''],
    });
    expect(isError).toBe(false);
    expect(callsOf('createExperiment')).toHaveLength(1);
    const body0 = callsOf('createExperiment')[0]![0] as any;
    expect(body0.videoIds).toEqual(['vid1']);
    expect(body0.instructions).toEqual({
      goal: EDIT_GOAL,
      brand: '',
      audience: '',
      language: 'English',
      direction: 'Render the exact overlay texts. Slide 1 (hook): "Stop doing this" (empty clears it too) '
        + 'Slide 2: "Three things I wish I knew" Slide 3: "" (strip — no text)',
      lockedConstraints: [],
      variables: ['hook'],
      mode: 'controlled',
      // SLA-431: the same exact copy as structured values, blank included.
      copyOverrides: { '0': 'Stop doing this', '1': 'Three things I wish I knew', '2': '' },
    });
    expect(body0.variantCount).toBe(EDIT_VARIANT_COUNT);
    expect(body0.maxCredits).toBe(EDIT_MAX_CREDITS);
    // The strict backend schema must accept it — and reject the wizard-only
    // surveyMode marker, which never leaves the browser.
    expect(Create.safeParse(body0).success).toBe(true);
    expect(Create.safeParse({ ...body0, surveyMode: 'edit' }).success).toBe(false);
    // Free: the draft response carries the plan estimate and a spending edge.
    expect(body.experiments[0].planEstimate.totalCredits).toBe(9);
    expect(body.nextSteps[0]).toMatchObject({ tool: 'plan_experiment', spendsMoney: true });
  });

  test('edit mode quotes copy in the site\'s wording and order, trimming each entry', async () => {
    expect(editSlideDirection(' A hook ', [' second ', '', 'fourth']))
      .toBe('Render the exact overlay texts. Slide 1 (hook): "A hook" (empty clears it too) '
        + 'Slide 2: "second" Slide 3: "" (strip — no text) Slide 4: "fourth"');
    expect(editSlideDirection('Only a hook', [])).toBe('Render the exact overlay texts. Slide 1 (hook): "Only a hook" (empty clears it too)');
  });

  test('edit mode carries the requested copy as structured values, not prose alone', () => {
    // The exact user values, trimmed the same way the quoted prose is. Slide 1 is
    // the hook and slides 2..N are the requested supporting copy.
    expect(editInstructions(' New hook ', [' New support ', ''], 'English').copyOverrides)
      .toEqual({ '0': 'New hook', '1': 'New support', '2': '' });
    // An explicit "" stays present: it is a blank that must reach the renderer.
    const blank = editInstructions('H', ['  '], 'English').copyOverrides!;
    expect(Object.keys(blank)).toEqual(['0', '1']);
    expect(blank['1']).toBe('');
    // An omitted hook is NOT a blank. It means "keep the resolved source copy",
    // so there must be no slide-1 key at all.
    const omitted = editInstructions(undefined, ['New support'], 'English').copyOverrides!;
    expect(Object.keys(omitted)).toEqual(['1']);
    expect(omitted).not.toHaveProperty('0');
    // Prose is still emitted for the model's benefit; the structured values are
    // what the effective brief and render request are built from.
    const both = editInstructions('H', ['S'], 'Danish');
    expect(both.direction).toContain('Slide 2: "S"');
    expect(both.variables).toEqual(['hook']);
    expect(both.varySupportingOverlays).toBeUndefined();
  });

  test('an omitted hook reads as unchanged in prose too, not as a cleared slide', () => {
    // M2: `editSlideDirection(hook ?? '', ...)` collapsed undefined -> '' before
    // the omitted-hook branch could be tested, so the two carriers disagreed —
    // the structured one said "unchanged" while the prose said "empty clears it".
    // direction reaches the briefs prompt and every render request, so on a paid
    // render that contradiction blanks slide 1.
    const omitted = editInstructions(undefined, ['Better support'], 'English');
    expect(omitted.copyOverrides).not.toHaveProperty('0');
    expect(omitted.direction).toContain('Slide 1 (hook): unchanged');
    expect(omitted.direction).not.toContain('(empty clears it too)');
    // An EXPLICIT empty hook is still a blank, and says so.
    const explicit = editInstructions('', ['Better support'], 'English');
    expect(explicit.copyOverrides!['0']).toBe('');
    expect(explicit.direction).toContain('Slide 1 (hook): "" (empty clears it too)');
    // The prose helper is also reachable directly.
    expect(editSlideDirection(undefined, [])).toBe('Render the exact overlay texts. Slide 1 (hook): unchanged — no new hook was requested');
    expect(editSlideDirection(' A hook ', [])).toBe('Render the exact overlay texts. Slide 1 (hook): "A hook" (empty clears it too)');
  });

  test('the edit request keeps an omitted hook omitted instead of blanking slide 1', async () => {
    await call('create_experiment', { mode: 'edit', videoIds: ['vid1'], overlayTexts: ['New support', ''] });
    const body = callsOf('createExperiment')[0]![0] as any;
    expect(body.instructions.copyOverrides).toEqual({ '1': 'New support', '2': '' });
    expect(body.instructions.copyOverrides).not.toHaveProperty('0');
    expect(Create.safeParse(body).success).toBe(true);
    // An explicit blank hook is a real request and is carried as one.
    await call('create_experiment', { mode: 'edit', videoIds: ['vid1'], hook: '', overlayTexts: ['New support'] });
    const blank = callsOf('createExperiment')[1]![0] as any;
    expect(blank.instructions.copyOverrides).toEqual({ '0': '', '1': 'New support' });
  });

  test('edit mode refuses several decks and empty copy before creating anything', async () => {
    const many = await call('create_experiment', { mode: 'edit', videoIds: ['vid1', 'vid2'], hook: 'H' });
    expect(many.isError).toBe(true);
    expect(many.body.message).toMatch(/exactly one slideshow/);
    const nothing = await call('create_experiment', { mode: 'edit', videoIds: ['vid1'], hook: '', overlayTexts: ['', '  '] });
    expect(nothing.isError).toBe(true);
    expect(nothing.body.message).toMatch(/new copy/);
    expect(callsOf('createExperiment')).toHaveLength(0);
  });

  test('edit mode passes the caller\'s language through and ignores create-only fields', async () => {
    await call('create_experiment', {
      mode: 'edit', videoIds: ['vid1'], hook: 'H', overlayTexts: ['B'], language: 'Danish',
      variantCount: 9, maxCredits: 5000,
    });
    const body0 = callsOf('createExperiment')[0]![0] as any;
    expect(body0.instructions.language).toBe('Danish');
    // Edit mode is pinned to the site's shape; the caller cannot talk it out of it.
    expect(body0.variantCount).toBe(EDIT_VARIANT_COUNT);
    expect(body0.maxCredits).toBe(EDIT_MAX_CREDITS);
    expect(Create.safeParse(body0).success).toBe(true);
  });

  test('the tool refuses copy that would overflow the direction it has to quote', async () => {
    // The wizard and this tool are the two producers of the same quoted prose.
    // The wizard bounds each box at 200; the tool used to accept 2000, so an edit
    // of 4 x 600-char slides produced a 16k direction and was refused at create.
    // A schema rejection comes back as a non-JSON MCP error body, so assert on
    // the refusal and on the service never being reached.
    const refused = async (args: Record<string, unknown>) => {
      const client = await connect();
      const res = await client.callTool({ name: 'create_experiment', arguments: args }) as { isError?: boolean };
      expect(Boolean(res.isError)).toBe(true);
      expect(callsOf('createExperiment')).toHaveLength(0);
    };
    await refused({ mode: 'edit', videoIds: ['vid1'], hook: 'C'.repeat(600), overlayTexts: ['D'.repeat(600)] });
    await refused({ mode: 'edit', videoIds: ['vid1'], hook: 'C'.repeat(200), overlayTexts: ['D'.repeat(201)] });
    // The maximum the tool now accepts still fits the 2000-char direction field,
    // so an accepted edit can never be refused by the schema that stores it.
    const worst = editInstructions('C'.repeat(EDIT_COPY_MAX), Array(7).fill('D'.repeat(EDIT_COPY_MAX)), 'English');
    expect(worst.direction.length).toBeLessThanOrEqual(2000);
    expect(Create.safeParse({
      workspaceId: 'w1', idempotencyKey: 'gallery:abc123', videoIds: ['vid1'], instructions: worst,
      variantCount: EDIT_VARIANT_COUNT, slideCount: 8, maxCredits: EDIT_MAX_CREDITS,
    }).success).toBe(true);
    // 200 chars per value is the site's own input maxlength — one bound, two paths.
    expect(EDIT_COPY_MAX).toBe(200);
  });

  test('the gallery wizard payload and the host edit payload reach the same exact copy', async () => {
    // SLA-431 F1: the site wizard POSTed a prose-only instructions object, so the
    // reported defect was live on the product's own path, and the host/chat copy
    // of that payload lost `mode` entirely and fell through to create mode.
    // The wizard's inline script runs in its own iframe and cannot call a module
    // helper, so this pins the CONTRACT both paths must satisfy rather than the
    // UI line itself; a browser check is tracked separately.
    const hook = 'Stop doing this';
    const overlays = ['Three things I wish I knew', ''];
    // 1. What the browser POSTs: instructions now carry copyOverrides.
    const gallerySurvey = {
      videoIds: ['vid1'], surveyMode: 'edit',
      instructions: {
        goal: EDIT_GOAL, brand: '', audience: '', language: 'English',
        direction: 'Render the exact overlay texts.',
        lockedConstraints: [], variables: ['hook'], mode: 'controlled',
        copyOverrides: editInstructions(hook, overlays, 'English').copyOverrides,
      },
      variantCount: EDIT_VARIANT_COUNT, slideCount: 3, maxCredits: EDIT_MAX_CREDITS,
    };
    // api/gallery.ts strips only surveyMode and forwards the rest verbatim.
    const { surveyMode: _mode, ...fields } = gallerySurvey;
    expect(Create.safeParse({ workspaceId: 'w1', idempotencyKey: 'gallery:abc123', ...fields }).success).toBe(true);
    expect((fields.instructions as any).copyOverrides).toEqual({ '0': hook, '1': overlays[0], '2': '' });
    // 2. What the host is told to paste: mode edit + hook/overlayTexts.
    await call('create_experiment', { mode: 'edit', videoIds: ['vid1'], hook, overlayTexts: overlays });
    const viaTool = (callsOf('createExperiment')[0]![0] as any).instructions.copyOverrides;
    // Both paths must agree exactly, blanks included, or the defect survives on one.
    expect(viaTool).toEqual((fields.instructions as any).copyOverrides);
  });

  test('a long deck never emits more per-slide overrides than the experiment can hold', () => {
    // The wizard shows an overlay box for every SOURCE slide (TikTok decks reach
    // 35 photos) while the payload's slideCount is clamped to 3..8. Emitting a key
    // per box would exceed the per-slide cap and be refused at create time, so a
    // 9+ slide deck could not be edited through the product's own wizard at all.
    // The emission bound itself is pinned by a source guard in gallery.test.ts.
    // Deck length only matters BELOW the clamp, where Math.max(3, …) engages;
    // at 9+ every deck collapses to the same 8-slide payload, so those rows were
    // the same input three times. Rows 3/5/7 exercise the lower clamp, 8 the
    // upper, and the last two vary copy length at the top of the range.
    for (const [sourceSlides, perBox] of [[3, 200], [5, 200], [7, 200], [8, 200], [9, 200], [35, 52], [35, 20]] as const) {
      const slideCount = Math.min(8, Math.max(3, sourceSlides));
      // 200 chars per box is the input's own maxlength, not a stress value.
      const box = 'C'.repeat(perBox);
      const overlays = Array.from({ length: sourceSlides - 1 }, () => box);
      // Reconstruct buildPayload faithfully: slice once, then build BOTH
      // carriers from the slice. The previous version of this test built only the
      // keys and used a one-word direction, so it passed while the real payload
      // was refused on the 2000-char prose field — the exact defect it claimed
      // to cover.
      const kept = overlays.slice(0, Math.min(overlays.length, Math.max(0, slideCount - 1)));
      const hook = 'New hook';
      const emitted = Object.fromEntries([['0', hook], ...kept.map((t, k) => [String(k + 1), t])]);
      const lines = [`Slide 1 (hook): "${hook}" (empty clears it too)`];
      kept.forEach((t, k) => { lines.push(`Slide ${k + 2}: "${t}"${t ? '' : ' (strip — no text)'}`); });
      const direction = 'Render the exact overlay texts. ' + lines.join(' ');
      expect(Object.keys(emitted).length).toBe(slideCount);
      // Both carriers describe the same slides, so the request is internally consistent.
      expect(lines.length).toBe(slideCount);
      expect(direction.length).toBeLessThanOrEqual(2000);
      const body = {
        workspaceId: 'w1', idempotencyKey: 'gallery:abc123', videoIds: ['vid1'],
        instructions: {
          goal: EDIT_GOAL, brand: '', audience: '', language: 'English', direction,
          lockedConstraints: [], variables: ['hook'], mode: 'controlled', copyOverrides: emitted,
        },
        variantCount: EDIT_VARIANT_COUNT, slideCount, maxCredits: EDIT_MAX_CREDITS,
      };
      const parsed = Create.safeParse(body);
      expect(parsed.success ? '' : parsed.error.issues[0]!.message).toBe('');
    }
  });

  test('an identical edit retry derives the same key (no duplicate drafts)', async () => {
    const args = { mode: 'edit', videoIds: ['vid1'], hook: 'H', overlayTexts: ['B'] };
    await call('create_experiment', args);
    await call('create_experiment', args);
    const keys = callsOf('createExperiment').map(a => (a[0] as any).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(Key.safeParse(keys[0]!).success).toBe(true);
  });
});

describe('spending actions', () => {
  test('plan_experiment refuses when the fresh estimate exceeds the approval', async () => {
    store.set('e1', exp('e1'));
    estimateTotal = 12;
    const { isError, body } = await call('plan_experiment', { experimentId: 'e1', approvedCredits: 9 });
    expect(isError).toBe(true);
    expect(body.error).toBe('estimate_exceeds_approval');
    expect(body.estimate.totalCredits).toBe(12);
    expect(callsOf('mutate')).toHaveLength(0);
  });

  test('plan_experiment calls service.mutate with a stable derived key', async () => {
    store.set('e1', exp('e1'));
    const first = await call('plan_experiment', { experimentId: 'e1', approvedCredits: 9 });
    await call('plan_experiment', { experimentId: 'e1', approvedCredits: 9 });
    expect(first.isError).toBe(false);
    const [a, b] = callsOf('mutate');
    expect(a!.slice(0, 3)).toEqual(['w1', 'e1', 'plan']);
    expect((a![3] as any).workspaceId).toBe('w1');
    expect((a![3] as any).idempotencyKey).toBe((b![3] as any).idempotencyKey);
    expect(Plan.safeParse(a![3]).success).toBe(true);
    expect(first.body.progress.status).toBe('draft');
  });

  test('plan_experiment returns the estimate it was gated on, not just the refusal case', async () => {
    store.set('e1', exp('e1'));
    estimateTotal = 9;
    const { isError, body } = await call('plan_experiment', { experimentId: 'e1', approvedCredits: 9 });
    expect(isError).toBe(false);
    // The post-transition state reads as "nothing left to plan", so the price
    // of the work just started has to come back from the gate that priced it.
    expect(body.estimate.totalCredits).toBe(9);
    expect(body.estimateNote).toMatch(/before this call/);
    expect(callsOf('estimate')).toHaveLength(1);
  });

  test('generate_experiment and retry_experiment return their estimate too', async () => {
    store.set('e1', exp('e1', { status: 'review' }));
    estimateTotal = 40;
    const generated = await call('generate_experiment', { experimentId: 'e1', variants: [{ id: 'v1', revision: 1 }], approvedCredits: 40 });
    expect(generated.isError).toBe(false);
    expect(generated.body.estimate.totalCredits).toBe(40);

    store.set('e2', exp('e2', { status: 'failed', tasks: [{ id: 't1', kind: 'slide', target: 'v1', index: 0, status: 'failed', attempts: 1, charged: 10 }] }));
    estimateTotal = 30;
    const retried = await call('retry_experiment', { experimentId: 'e2', taskIds: ['t1'], approvedCredits: 30 });
    expect(retried.isError).toBe(false);
    expect(retried.body.estimate.totalCredits).toBe(30);
  });

  test('generate_experiment prices and sends exactly the chosen variants and revisions', async () => {
    store.set('e1', exp('e1', { status: 'review' }));
    const variants = [{ id: 'v1', revision: 2 }];
    await call('generate_experiment', { experimentId: 'e1', variants, approvedCredits: 9 });
    expect(callsOf('estimate')[0]).toEqual(['e1', 'generate', ['v1'], undefined]);
    const m = callsOf('mutate')[0]!;
    expect(m[2]).toBe('generate');
    expect((m[3] as any).variants).toEqual(variants);
    expect(Generate.safeParse(m[3]).success).toBe(true);
  });

  test('retry_experiment prices named jobs and re-keys once a job has run again', async () => {
    store.set('e1', exp('e1', { status: 'failed', tasks: [{ id: 't1', kind: 'slide', target: 'v1', index: 0, status: 'failed', attempts: 4, charged: 30 }] }));
    await call('retry_experiment', { experimentId: 'e1', taskIds: ['t1'], approvedCredits: 30 });
    await call('retry_experiment', { experimentId: 'e1', taskIds: ['t1'], approvedCredits: 30 });
    store.get('e1')!.tasks[0]!.attempts = 5;
    await call('retry_experiment', { experimentId: 'e1', taskIds: ['t1'], approvedCredits: 30 });
    expect(callsOf('estimate')[0]).toEqual(['e1', 'generate', undefined, ['t1']]);
    const keys = callsOf('mutate').map(m => (m[3] as any).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[2]).not.toBe(keys[0]);
    expect((callsOf('mutate')[0]![3] as any).taskIds).toEqual(['t1']);
    expect(Retry.safeParse(callsOf('mutate')[0]![3]).success).toBe(true);
  });
});

describe('edits, cancel and delete', () => {
  const brief = {
    concept: 'c', hook: 'h', character: '', visualStyle: 'photo', caption: '', cta: '', lockedConstraints: [],
    slides: [1, 2, 3].map(n => ({ role: `r${n}`, scene: `s${n}`, overlayText: '' })),
  };

  test('update_experiment_variant forwards revision + brief to the edit action', async () => {
    store.set('e1', exp('e1', { status: 'review' }));
    await call('update_experiment_variant', { experimentId: 'e1', variantId: 'v1', revision: 1, brief });
    const m = callsOf('mutate')[0]!;
    expect(m.slice(0, 3)).toEqual(['w1', 'e1', 'edit']);
    expect(m[3]).toEqual({ workspaceId: 'w1', revision: 1, brief });
    expect(EditBrief.safeParse(m[3]).success).toBe(true);
    expect(m[4]).toBe('v1');
  });

  test('update_experiment_variant keeps the pinned copy overrides on the brief', async () => {
    // M3: briefInput used to be a plain z.object, so it silently STRIPPED
    // copyOverrides. An explicitly blank slide 1 has exactly two carriers
    // (copyOverrides['0'] and slides[0].overlayText) and Brief.hook cannot be
    // blank, so the strip resurrected the generated board hook on the very
    // review step that exists to show the user what will render.
    const blank = { ...brief, hook: 'Generated board hook', copyOverrides: { '0': '', '1': 'New support' } };
    store.set('e1', exp('e1', { status: 'review' }));
    const res = await call('update_experiment_variant', { experimentId: 'e1', variantId: 'v1', revision: 1, brief: blank });
    expect(res.isError).toBe(false);
    const forwarded = callsOf('mutate')[0]![3] as any;
    expect(forwarded.brief.copyOverrides).toEqual({ '0': '', '1': 'New support' });
    expect(EditBrief.safeParse(forwarded).success).toBe(true);
    // A brief without overrides is still accepted and stays without them.
    store.set('e1', exp('e1', { status: 'review' }));
    await call('update_experiment_variant', { experimentId: 'e1', variantId: 'v1', revision: 1, brief });
    expect((callsOf('mutate')[1]![3] as any).brief).not.toHaveProperty('copyOverrides');
  });

  test('service refusals come back as isError with the code and a hint', async () => {
    store.set('e1', exp('e1', { status: 'review' }));
    mutateError = new ExperimentError(409, 'revision_conflict');
    const { isError, body } = await call('update_experiment_variant', { experimentId: 'e1', variantId: 'v1', revision: 1, brief });
    expect(isError).toBe(true);
    expect(body).toMatchObject({ error: 'revision_conflict', status: 409 });
    expect(body.hint).toContain('latest revision');
  });

  test('cancel_experiment uses the cancel action', async () => {
    store.set('e1', exp('e1', { status: 'planning' }));
    await call('cancel_experiment', { experimentId: 'e1' });
    expect(callsOf('mutate')[0]!.slice(0, 3)).toEqual(['w1', 'e1', 'cancel']);
    expect(Command.safeParse(callsOf('mutate')[0]![3]).success).toBe(true);
  });

  test('delete_experiment routes single vs bulk and needs exactly one', async () => {
    expect((await call('delete_experiment', {})).isError).toBe(true);
    expect((await call('delete_experiment', { experimentId: 'e1', experimentIds: ['e2'] })).isError).toBe(true);
    await call('delete_experiment', { experimentId: 'e1' });
    await call('delete_experiment', { experimentIds: ['e2', 'e3'] });
    expect(callsOf('deleteExperiment')).toEqual([['w1', 'e1']]);
    expect(callsOf('deleteExperiments')).toEqual([['w1', ['e2', 'e3']]]);
  });
});

describe('reads', () => {
  test('list_experiments pages with one look-ahead row', async () => {
    for (const id of ['a', 'b', 'c']) store.set(id, exp(id));
    const { body } = await call('list_experiments', { limit: 2 });
    expect(callsOf('list')[0]).toEqual(['w1', 3, 0]);
    expect(body.experiments.map((e: any) => e.id)).toEqual(['a', 'b']);
    expect(body.nextOffset).toBe(2);
  });

  test('get_experiment adds a progress summary with images and retryable jobs', async () => {
    const variant = {
      id: 'v1', title: 'Baseline', hypothesis: 'h', changedVariables: [], brief: {} as any, revision: 1, status: 'done',
      baselineId: null, generationBasis: 'source-referenced' as const, history: [], frozenBrief: null, error: null,
      slides: [
        { index: 0, status: 'done', url: 'https://cdn/a.jpg', path: 'p/a', error: null, overlayText: '' },
        { index: 1, status: 'failed', url: null, path: null, error: 'x', overlayText: '' },
      ],
    };
    store.set('e1', exp('e1', {
      status: 'failed', variants: [variant],
      tasks: [
        { id: 't1', kind: 'slide', target: 'v1', index: 1, status: 'failed', attempts: 4, charged: 30 },
        { id: 't2', kind: 'slide', target: 'v1', index: 0, status: 'done', attempts: 1, charged: 30 },
      ],
    }));
    const { body } = await call('get_experiment', { experimentId: 'e1' });
    expect(body.experiment.id).toBe('e1');
    expect(body.experiment.projected).toBe(true);
    expect(body.progress.variants[0]).toMatchObject({ baseline: true, slidesDone: 1, slidesTotal: 2, imageUrls: ['https://cdn/a.jpg'] });
    expect(body.progress.retryableJobs.map((j: any) => j.id)).toEqual(['t1']);
    expect(body.progress.jobs.slide).toEqual({ failed: 1, done: 1 });
    expect(body.nextSteps[0]).toMatchObject({ tool: 'estimate_experiment', args: { taskIds: ['t1'] } });
  });

  test('an unowned workspace is refused', async () => {
    const { isError, body } = await call('get_experiment', { workspaceId: 'someone-else', experimentId: 'e1' });
    expect(isError).toBe(true);
    expect(body.error).toBe('workspace_not_found');
  });
});

describe('helpers', () => {
  test('default cap matches the site auto-cap (2x estimate, rounded up to 10, min 30)', () => {
    // site: estimateExperimentCredits(1, 3, 5).total = 9 + 450 = 459 → 920
    expect(defaultExperimentCap(3, 5)).toBe(920);
    expect(defaultExperimentCap(1, 3)).toBe(200);
  });
  test('derived keys are deterministic and valid Keys', () => {
    const k = derivedKey('plan', { experimentId: 'e1' });
    expect(k).toBe(derivedKey('plan', { experimentId: 'e1' }));
    expect(Key.safeParse(k).success).toBe(true);
  });
});
