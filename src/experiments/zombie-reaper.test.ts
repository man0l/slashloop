// SLA-585: an experiment left `generating` with one terminally failed slide and
// no pending/running task (prod row 0fe99e52) made step() return false forever.
import { describe, expect, test } from 'bun:test';
import { reapNoActionable, step, type EngineDeps } from './engine.js';
import type { Experiment, Task } from './schema.js';

const task = (id: string, status: Task['status'], over: Partial<Task> = {}): Task =>
  ({ id, kind: 'slide', target: 'v1', index: 0, status, attempts: 1, charged: 0, ...over }) as Task;

function zombie(tasks: Task[], status: Experiment['status'] = 'generating'): Experiment {
  return {
    id: 'e', workspaceId: 'w', status, version: 1, tasks, inputs: [], error: null, allowPartial: false,
    variants: [{ id: 'v1', status: 'generating', error: null, slides: [] }],
  } as unknown as Experiment;
}

describe('reapNoActionable', () => {
  test('failed task + nothing runnable -> failed with the task error recorded', () => {
    const e = zombie([task('a', 'done'), task('b', 'failed', { error: 'provider_result_rejected:credits_exhausted_402' })]);
    expect(reapNoActionable(e)).toBe(true);
    expect(e.status).toBe('failed');
    expect(e.error).toBe('provider_result_rejected:credits_exhausted_402');
    expect(e.variants[0]!.status).toBe('failed');
  });
  test('unknown outcome pauses for review', () => {
    const e = zombie([task('a', 'failed', { error: 'x' }), task('b', 'unknown', { error: 'provider_outcome_unknown' })]);
    expect(reapNoActionable(e)).toBe(true);
    expect(e.status).toBe('paused');
  });
  test.each(['pending', 'running'] as const)('a %s task keeps the experiment alive', (s) => {
    const e = zombie([task('a', 'failed', { error: 'x' }), task('b', s)]);
    expect(reapNoActionable(e)).toBe(false);
    expect(e.status).toBe('generating');
  });
  test('no dead tasks, or already terminal, is untouched', () => {
    expect(reapNoActionable(zombie([task('a', 'done')]))).toBe(false);
    expect(reapNoActionable(zombie([task('a', 'failed')], 'failed'))).toBe(false);
    expect(reapNoActionable(zombie([]))).toBe(false);
  });
});

test('step() persists the terminal status once and never invokes prepare', async () => {
  let stored = zombie([task('a', 'done'), task('b', 'failed', { error: 'boom' })]);
  const saves: string[] = [];
  const deps = {
    load: async () => structuredClone(stored),
    save: async (e: Experiment) => { stored = e; saves.push(e.status); return true; },
    prepare: async () => { throw new Error('prepare must not run'); },
    now: () => 1_000,
  } as unknown as EngineDeps;
  expect(await step('w', 'e', deps)).toBe(false);
  expect(stored.status).toBe('failed');
  expect(await step('w', 'e', deps)).toBe(false);
  expect(saves).toEqual(['failed']);
});
