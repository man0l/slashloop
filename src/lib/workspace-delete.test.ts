// DB-backed coverage for workspace deletion (SLA-1223).
//
// deleteWorkspaceForUser removes ~20 tables child-first, and D1 enforces the
// RESTRICT foreign keys, so the delete order is only proven against a real
// SQLite file: seed two workspaces with the full object graph, delete one,
// assert it is gone row-for-row and the neighbour is untouched. Same fixture
// rule as src/analysis/failure-bookkeeping.test.ts: pushed from
// prisma/schema.sqlite.prisma through the committed generated client, the
// client passed in explicitly (never the process-wide `db` proxy, which other
// suites mock.module), and skipped loudly when the prisma CLI cannot push.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { deleteWorkspaceForUser, DeleteWorkspaceError } from './workspaces.js';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const OWNER = 'owner-sla-1223';

let scratchDir = '';
let scratchFile = '';
let pushError: string | null = null;

try {
  scratchDir = mkdtempSync(join(tmpdir(), 'slashloop-ws-delete-'));
  scratchFile = join(scratchDir, 'scratch.sqlite');
  const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
  const pushed = Bun.spawnSync([process.execPath, prismaCli, 'db', 'push', '--skip-generate', '--schema', 'prisma/schema.sqlite.prisma'], {
    cwd: REPO_ROOT,
    env: { ...process.env, SQLITE_DB_URL: `file:${scratchFile}` },
  });
  if (pushed.exitCode !== 0) pushError = pushed.stderr.toString().slice(0, 400);
} catch (err) {
  pushError = (err as Error).message;
}
if (pushError) console.warn(`[workspace-delete.test] skipped: prisma db push failed — ${pushError}`);

const repoRequire = createRequire(join(REPO_ROOT, 'noop.js'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let client: any;

/** One workspace with every workspace-keyed table populated. */
async function seedWorkspace(id: string, createdAt: Date): Promise<void> {
  await client.workspace.create({ data: { id, ownerId: OWNER, name: id, createdAt } });
  const source = await client.source.create({ data: { workspaceId: id, platform: 'tiktok', sourceType: 'creator', query: `@${id}` } });
  const video = await client.video.create({
    data: { sourceId: source.id, platform: 'tiktok', externalId: `v-${id}`, url: 'https://x.test', creatorHandle: id, postedAt: new Date() },
  });
  await client.score.create({ data: { videoId: video.id, outlierScore: 3, explanation: 'x' } });
  const analysis = await client.analysis.create({ data: { videoId: video.id, analysisJson: '{}', analysisBasis: 'video' } });
  await client.hook.create({ data: { videoId: video.id, analysisId: analysis.id, text: 'h', hookType: 'POV', placement: 'spoken' } });
  const idea = await client.idea.create({ data: { videoId: video.id, analysisId: analysis.id, transferablePattern: 'p', whyItWorked: 'w', adaptation: 'a' } });
  await client.script.create({ data: { analysisId: analysis.id, format: 'listicle', scriptJson: '{}' } });
  await client.brief.create({ data: { analysisId: analysis.id, ideaId: idea.id, briefJson: '{}' } });
  const board = await client.board.create({ data: { workspaceId: id, name: 'b' } });
  await client.swipeEntry.create({ data: { boardId: board.id, videoId: video.id } });
  await client.refreshRun.create({ data: { sourceId: source.id } });
  await client.mediaJob.create({ data: { workspaceId: id, videoId: video.id } });
  await client.usageLog.create({ data: { workspaceId: id, kind: 'scrape', provider: 'apify' } });
  await client.creditLedger.create({ data: { workspaceId: id, delta: -1, bucket: 'plan', reason: 'tool_call', balanceAfter: 299, refId: `r-${id}` } });
  await client.autoAnalyzeRun.create({ data: { workspaceId: id } });
  await client.suggestionDismissal.create({ data: { workspaceId: id, sourceType: 'hashtag', query: 'q' } });
  await client.workspaceMember.create({ data: { workspaceId: id, email: `m@${id}.co`, invitedBy: OWNER } });
  await client.experiment.create({ data: { id: `e-${id}`, workspaceId: id, status: 'completed', dataJson: '{}', createKey: `k-${id}` } });
}

/** Rows reachable from a workspace, per table. */
async function census(id: string): Promise<Record<string, number>> {
  const ofVideo = { video: { source: { workspaceId: id } } };
  return {
    workspace: await client.workspace.count({ where: { id } }),
    source: await client.source.count({ where: { workspaceId: id } }),
    video: await client.video.count({ where: { source: { workspaceId: id } } }),
    score: await client.score.count({ where: ofVideo }),
    analysis: await client.analysis.count({ where: ofVideo }),
    hook: await client.hook.count({ where: ofVideo }),
    idea: await client.idea.count({ where: ofVideo }),
    script: await client.script.count({ where: { analysis: ofVideo } }),
    brief: await client.brief.count({ where: { analysis: ofVideo } }),
    board: await client.board.count({ where: { workspaceId: id } }),
    swipeEntry: await client.swipeEntry.count({ where: { board: { workspaceId: id } } }),
    refreshRun: await client.refreshRun.count({ where: { source: { workspaceId: id } } }),
    mediaJob: await client.mediaJob.count({ where: { workspaceId: id } }),
    usageLog: await client.usageLog.count({ where: { workspaceId: id } }),
    creditLedger: await client.creditLedger.count({ where: { workspaceId: id } }),
    autoAnalyzeRun: await client.autoAnalyzeRun.count({ where: { workspaceId: id } }),
    suggestionDismissal: await client.suggestionDismissal.count({ where: { workspaceId: id } }),
    workspaceMember: await client.workspaceMember.count({ where: { workspaceId: id } }),
    experiment: await client.experiment.count({ where: { workspaceId: id } }),
  };
}

const describeDb = pushError ? describe.skip : describe;

describeDb('deleteWorkspaceForUser against real SQLite foreign keys', () => {
  beforeAll(async () => {
    const { PrismaClient } = repoRequire('./src/generated/sqlite/index.js') as typeof import('../generated/sqlite/index.js');
    client = new PrismaClient({ datasources: { db: { url: `file:${scratchFile}` } } });
    await seedWorkspace('ws-primary', new Date('2026-01-01'));
    await seedWorkspace('ws-client', new Date('2026-05-01'));
  });

  afterAll(async () => {
    await client?.$disconnect();
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true });
  });

  test('refuses the primary workspace and leaves it intact', async () => {
    await expect(deleteWorkspaceForUser(OWNER, 'ws-primary', client)).rejects.toBeInstanceOf(DeleteWorkspaceError);
    expect(Object.values(await census('ws-primary')).every((n) => n === 1)).toBe(true);
  });

  test('refuses while an experiment is generating', async () => {
    await client.experiment.update({ where: { id: 'e-ws-client' }, data: { status: 'generating' } });
    await expect(deleteWorkspaceForUser(OWNER, 'ws-client', client)).rejects.toMatchObject({ code: 'active_experiments' });
    await client.experiment.update({ where: { id: 'e-ws-client' }, data: { status: 'completed' } });
  });

  test("refuses another owner's workspace", async () => {
    await expect(deleteWorkspaceForUser('someone-else', 'ws-client', client)).rejects.toMatchObject({ code: 'workspace_not_found' });
  });

  test('deletes every row of the workspace and none of its neighbour', async () => {
    const before = await census('ws-client');
    expect(Object.values(before).every((n) => n === 1)).toBe(true);

    const result = await deleteWorkspaceForUser(OWNER, 'ws-client', client);
    expect(result).toMatchObject({ id: 'ws-client', sources: 1, videos: 1, experiments: 1, usageLogs: 1 });

    const after = await census('ws-client');
    expect(Object.entries(after).filter(([, n]) => n !== 0)).toEqual([]);
    expect(Object.values(await census('ws-primary')).every((n) => n === 1)).toBe(true);
  });
});
