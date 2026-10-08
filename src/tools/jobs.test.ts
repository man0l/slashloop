// await_job / get_job_status only cover MediaJobs (refresh/analyze). An
// experiment task id used to get a bare "Job not found", which read as a broken
// queue. These tests pin the redirect (and the precise not-found) through a real
// MCP client/server pair with injected lookups.
import { describe, expect, test } from 'bun:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Task } from '../experiments/schema.js';
import { registerJobTools, type JobToolDeps } from './jobs.js';

const NEXT = Date.parse('2026-10-07T12:30:00Z');
const task: Task = {
  id: 'task-1', kind: 'analysis', status: 'pending', attempts: 2, charged: 5,
  error: 'provider_outcome_unknown', nextAttemptAt: NEXT,
};

function deps(over: Partial<JobToolDeps> = {}): JobToolDeps {
  return {
    resolveWorkspace: async () => ({ id: 'w1' }),
    findMediaJob: async () => null,
    findExperimentTask: async (workspaceId, jobId) => (workspaceId === 'w1' && jobId === task.id ? { experimentId: 'exp-9', task } : null),
    ...over,
  };
}

async function call(d: JobToolDeps, name: string, args: Record<string, unknown>) {
  const server = new McpServer({ name: 't', version: '0' });
  registerJobTools(server, d);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const res = await client.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  return { isError: res.isError ?? false, body: JSON.parse(res.content[0]!.text) };
}

describe.each(['get_job_status', 'await_job'])('%s with an experiment task id', tool => {
  test('returns the task status and a get_experiment redirect, not "Job not found"', async () => {
    const { isError, body } = await call(deps(), tool, { jobId: 'task-1' });
    expect(isError).toBe(false);
    expect(body).toMatchObject({
      jobId: 'task-1', jobType: 'experiment', experimentId: 'exp-9', kind: 'analysis', status: 'pending', attempts: 2,
      error: 'provider_outcome_unknown', nextAttemptAt: '2026-10-07T12:30:00.000Z', shouldKeepPolling: false,
    });
    expect(body.message).toContain('get_experiment(experimentId="exp-9")');
    expect(body.nextSteps[0]).toMatchObject({ tool: 'get_experiment', args: { experimentId: 'exp-9' } });
    expect(JSON.stringify(body)).not.toContain('Job not found');
  });

  test('an id that matches nothing says what these tools cover and where experiments are tracked', async () => {
    const { isError, body } = await call(deps(), tool, { jobId: 'nope' });
    expect(isError).toBe(true);
    expect(body.shouldKeepPolling).toBe(false);
    expect(body.error).toContain('refresh and analyze jobs');
    expect(body.error).toContain('get_experiment');
  });

  test('an experiment task in another workspace is not revealed', async () => {
    const { isError, body } = await call(deps({ resolveWorkspace: async () => ({ id: 'w2' }) }), tool, { jobId: 'task-1' });
    expect(isError).toBe(true);
    expect(body.experimentId).toBeUndefined();
  });
});

test('a real MediaJob still resolves through get_job_status', async () => {
  const now = new Date();
  const job = {
    id: 'mj1', status: 'done', kind: 'refresh', attempts: 1, lastError: null, deadlineAt: null,
    createdAt: now, startedAt: now, finishedAt: now, sourceId: 's1', videoId: null,
  } as unknown as Awaited<ReturnType<JobToolDeps['findMediaJob']>>;
  const { isError, body } = await call(deps({ findMediaJob: async () => job }), 'get_job_status', { jobId: 'mj1' });
  expect(isError).toBe(false);
  expect(body).toMatchObject({ jobId: 'mj1', status: 'done', kind: 'refresh', sourceId: 's1' });
});

test('the jobId descriptions say experiment job ids are not accepted', async () => {
  const server = new McpServer({ name: 't', version: '0' });
  registerJobTools(server, deps());
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '0' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  for (const name of ['await_job', 'get_job_status']) {
    const t = tools.find(x => x.name === name)!;
    expect(JSON.stringify(t.inputSchema.properties)).toContain('NOT an experiment job id');
  }
});
