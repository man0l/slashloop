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
  registerExperimentTools, defaultExperimentCap, derivedKey, type ExperimentToolDeps,
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
