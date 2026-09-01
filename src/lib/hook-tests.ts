// ---------------------------------------------------------------------------
// Hook tests — object lifecycle (feature #7 v1).
//
// A test pins ONE proven video to one editable insight and generates four
// openings that inherit everything else about it; picking + re-rolling move
// the versions through their statuses. Metering happens in
// src/tools/hook-tests.ts; ownership checks live here so every caller gets
// them for free.
//
// V1 is text-only: nothing here renders or posts. 'rendered'/'posted'/
// 'scored' version statuses and 'won'/'posted' test statuses exist in the
// schema for Phase 3 but are never written by this module.
// ---------------------------------------------------------------------------

import { db } from '../db.js';
import { chunked, isUniqueViolation } from '../store.js';
import { resolveThumbUrl } from './media.js';
import { generateHookTestDraft, type HookTestDraft, type HookTestLock } from '../analysis/hook-tests.js';

export const HOOK_VERSION_LABELS = ['A', 'B', 'C', 'D'] as const;

/** Test statuses an open test can be mutated from. */
export const OPEN_TEST_STATUSES = ['setup', 'picking', 'posted'];

export class HookTestError extends Error {
  constructor(message: string, readonly httpStatus: number = 400) {
    super(message);
  }
}

export interface SerializedHookVersion {
  id: string;
  label: string;
  round: number;
  hookText: string;
  firstFrame: string | null;
  hookType: string;
  mechanism: string | null;
  status: string;
  assetUrl: string | null;
  createdAt: string;
}

export interface SerializedHookTest {
  id: string;
  videoId: string;
  lever: string;
  insight: string;
  sameIn: string[];
  beats: string[];
  stopRule: string | null;
  status: string;
  /** Set when status is 'won': the label of the opening that beat the original. */
  winnerLabel: string | null;
  createdAt: string;
  versions: SerializedHookVersion[];
}

type TestRow = {
  id: string; videoId: string; lever: string; insight: string;
  sameInJson: string; beatsJson: string; stopRule: string | null;
  status: string; winnerLabel: string | null; createdAt: Date;
};

/** JSON columns → plain arrays; dates → ISO strings. The shape every tool returns. */
export function serializeTest(test: TestRow, versions: Array<{
  id: string; label: string; round: number; hookText: string; firstFrame: string | null;
  hookType: string; mechanism: string | null; status: string; assetUrl: string | null; createdAt: Date;
}>): SerializedHookTest {
  return {
    id: test.id,
    videoId: test.videoId,
    lever: test.lever,
    insight: test.insight,
    sameIn: safeArray(test.sameInJson),
    beats: safeArray(test.beatsJson),
    stopRule: test.stopRule,
    status: test.status,
    winnerLabel: test.winnerLabel,
    createdAt: test.createdAt.toISOString(),
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  };
}

function safeArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** Advisory stop rule derived from the proven video's own numbers. */
export function buildStopRule(originalViews: number): string {
  if (originalViews > 0) {
    return `Post each picked opening, then judge: kill any version that can't reach ${Math.round(originalViews / 2).toLocaleString('en-US')} views in its first two days — half what the original did.`;
  }
  return 'Post each picked opening, then judge against your own median — kill what underperforms after two days.';
}

async function requireVideo(workspaceId: string, videoId: string) {
  const video = await db.video.findFirst({
    where: { id: videoId, source: { workspaceId } },
    select: { id: true, views: true },
  });
  if (!video) throw new HookTestError(`Video not found in this workspace: ${videoId}`, 404);
  return video;
}

/** Load a test the workspace owns, or throw 404. Ownership flows video→source→workspace. */
export async function requireHookTest(testId: string, workspaceId: string) {
  const test = await db.hookTest.findFirst({
    where: { id: testId, workspaceId },
  });
  if (!test) throw new HookTestError(`Hook test not found: ${testId}`, 404);
  return test;
}

async function loadVersions(testId: string) {
  return db.hookVersion.findMany({ where: { testId }, orderBy: [{ round: 'desc' }, { label: 'asc' }] });
}

/** The open (not won/closed) test for a video, if any. One per video by service rule. */
export async function findOpenTest(workspaceId: string, videoId: string) {
  return db.hookTest.findFirst({
    where: { workspaceId, videoId, status: { in: OPEN_TEST_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getHookTest(testId: string, workspaceId: string): Promise<SerializedHookTest> {
  const test = await requireHookTest(testId, workspaceId);
  const versions = await loadVersions(test.id);
  return serializeTest(test, versions);
}

/** Open test for a video, serialized — null when none (the caller offers start_hook_test). */
export async function getOpenTestForVideo(workspaceId: string, videoId: string): Promise<SerializedHookTest | null> {
  await requireVideo(workspaceId, videoId);
  const test = await findOpenTest(workspaceId, videoId);
  if (!test) return null;
  const versions = await loadVersions(test.id);
  return serializeTest(test, versions);
}

/**
 * The test a video's badge should open: the open one, else the most recent of
 * any status — a won/closed test stays viewable read-only ("C won"). Mutations
 * keep resolving through getOpenTestForVideo, so this never makes an archived
 * test mutable.
 */
export async function getLatestTestForVideo(workspaceId: string, videoId: string): Promise<SerializedHookTest | null> {
  await requireVideo(workspaceId, videoId);
  const open = await findOpenTest(workspaceId, videoId);
  const test = open ?? await db.hookTest.findFirst({
    where: { workspaceId, videoId },
    orderBy: { createdAt: 'desc' },
  });
  if (!test) return null;
  const versions = await loadVersions(test.id);
  return serializeTest(test, versions);
}

function labelRound(versions: HookTestDraft['versions'], round: number, labels: readonly string[] = HOOK_VERSION_LABELS) {
  return versions.map((v, i) => ({
    label: labels[i] ?? `V${i + 1}`,
    round,
    hookText: v.hookText,
    firstFrame: v.firstFrame || null,
    hookType: v.type,
    mechanism: v.mechanism || null,
  }));
}

/**
 * Generate the draft and open the test. Assumes metering already happened —
 * throws before any generation when the video doesn't belong to the
 * workspace or already has an open test.
 */
export async function startHookTest(
  workspaceId: string,
  videoId: string,
  opts: { brandContext?: string; insight?: string } = {},
): Promise<SerializedHookTest> {
  const video = await requireVideo(workspaceId, videoId);
  const existing = await findOpenTest(workspaceId, videoId);
  if (existing) {
    throw new HookTestError(
      `This video already has an open hook test (${existing.id}) — pick or re-roll it, or close it to start over.`,
      409,
    );
  }

  const draft = await generateHookTestDraft(videoId, {
    brandContext: opts.brandContext,
    // An explicit insight is a lock from the very first generation.
    ...(opts.insight?.trim() ? { lock: { insight: opts.insight.trim() } as HookTestLock } : {}),
  });

  const created = await db.hookTest.create({
    data: {
      workspaceId,
      videoId,
      // An explicit insight wins — that's why the field is editable.
      insight: opts.insight?.trim() || draft.insight,
      sameInJson: JSON.stringify(draft.sameIn),
      beatsJson: JSON.stringify(draft.beats),
      stopRule: buildStopRule(video.views),
      // Born with proposals on the table, so setup is skipped.
      status: 'picking',
    },
    // The partial unique index (supabase/migrations …hook_test_one_open_per_video)
    // is the real guard — the findOpenTest pre-check above only catches the calm
    // case. Two racing starts (double-click, two tabs, agent + human): one wins
    // the insert, the loser refunds upstream.
  }).catch((err: unknown) => {
    // isUniqueViolation, not instanceof PrismaClientKnownRequestError: the
    // Postgres and SQLite generated clients ship two distinct error classes,
    // so a hardcoded instanceof misses on whichever client it wasn't built
    // against (see src/store.ts).
    if (isUniqueViolation(err)) {
      throw new HookTestError('Another request just opened a test for this video.', 409);
    }
    throw err;
  });
  await db.hookVersion.createMany({
    data: labelRound(draft.versions, 1).map((v) => ({ ...v, testId: created.id })),
  });

  return getHookTest(created.id, workspaceId);
}

/**
 * Discard every live proposal (picked ones too — re-roll means fresh slate)
 * and generate a new round of four. The stored insight/same-in/beats are the
 * lock: deliberately NOT regenerated, so re-rolls stay on-strategy even when
 * the user edited them.
 */
export async function rerollHooks(testId: string, workspaceId: string): Promise<SerializedHookTest> {
  const test = await requireHookTest(testId, workspaceId);
  if (!OPEN_TEST_STATUSES.includes(test.status)) {
    throw new HookTestError(`This test is ${test.status} — closed tests can't be re-rolled.`, 409);
  }

  const previous = await loadVersions(test.id);
  const nextRound = previous.reduce((max, v) => Math.max(max, v.round), 0) + 1;

  await db.hookVersion.updateMany({
    where: { testId: test.id, status: { in: ['proposed', 'picked'] } },
    data: { status: 'discarded' },
  });

  const draft = await generateHookTestDraft(test.videoId, {
    // The stored insight/chips/beats ARE the strategy: they go into the prompt
    // as hard constraints, not just survive the write. Without this the lock
    // was preserved on the row while every fresh generation drifted off it.
    lock: { insight: test.insight, sameIn: safeArray(test.sameInJson), beats: safeArray(test.beatsJson) },
  });

  await db.hookVersion.createMany({
    data: labelRound(draft.versions, nextRound).map((v) => ({ ...v, testId: test.id })),
  });
  if (test.status === 'setup') {
    await db.hookTest.update({ where: { id: test.id }, data: { status: 'picking' } });
  }

  return getHookTest(test.id, workspaceId);
}

/**
 * Mark chosen proposals as picked and move the test to 'picking'. Passed-over
 * proposals stay proposed — picking narrows intent, it doesn't destroy options.
 */
export async function pickHookVersions(
  testId: string,
  workspaceId: string,
  versionIds: string[],
): Promise<SerializedHookTest> {
  const test = await requireHookTest(testId, workspaceId);
  if (!OPEN_TEST_STATUSES.includes(test.status)) {
    throw new HookTestError(`This test is ${test.status} — nothing left to pick.`, 409);
  }
  if (versionIds.length === 0) {
    throw new HookTestError('Pick at least one version.');
  }

  const owned = await db.hookVersion.count({ where: { id: { in: versionIds }, testId: test.id } });
  if (owned !== new Set(versionIds).size) {
    throw new HookTestError('Some version IDs do not belong to this test.', 400);
  }

  await db.hookVersion.updateMany({
    where: { id: { in: versionIds }, testId: test.id, status: 'proposed' },
    data: { status: 'picked' },
  });
  await db.hookTest.update({ where: { id: test.id }, data: { status: 'picking' } });

  return getHookTest(test.id, workspaceId);
}

/**
 * End the lifecycle. 'won' records that an opening beat the original; anything
 * else closes it. A winner label is stored on the win so every surface can say
 * "C won" — validated against the test's own versions, but not required to be
 * picked: the manual verdict may crown a proposal the user never formally
 * picked, and Phase 4 auto-scoring replaces this path anyway.
 */
export async function closeHookTest(
  testId: string,
  workspaceId: string,
  outcome?: 'won' | 'closed',
  winner?: string,
): Promise<SerializedHookTest> {
  const test = await requireHookTest(testId, workspaceId);

  let winnerLabel: string | null = null;
  if (outcome === 'won' && winner) {
    const label = winner.trim().toUpperCase();
    const owned = await db.hookVersion.findFirst({
      where: { testId: test.id, label },
      select: { id: true },
    });
    if (!owned) {
      throw new HookTestError(`No version "${label}" in this test — name one of its openings as the winner.`, 400);
    }
    winnerLabel = label;
  }

  await db.hookTest.update({
    where: { id: test.id },
    data: { status: outcome ?? 'closed', ...(outcome === 'won' ? { winnerLabel } : {}) },
  });
  return getHookTest(test.id, workspaceId);
}

/**
 * Edit the lock on an open test. This is the point of the whole design: the
 * user sharpens the one-sentence insight (or the constants) and every future
 * re-roll obeys the edit. Closed tests are frozen — their history is read-only.
 */
export async function updateHookTestMeta(
  testId: string,
  workspaceId: string,
  patch: { insight?: string; sameIn?: string[] },
): Promise<SerializedHookTest> {
  const test = await requireHookTest(testId, workspaceId);
  if (!OPEN_TEST_STATUSES.includes(test.status)) {
    throw new HookTestError(`This test is ${test.status} — its frame is locked now.`, 409);
  }

  const data: { insight?: string; sameInJson?: string } = {};
  if (patch.insight !== undefined) {
    const trimmed = patch.insight.trim();
    if (!trimmed) throw new HookTestError('The insight can\'t be empty — it is what keeps re-rolls on-strategy.');
    data.insight = trimmed;
  }
  if (patch.sameIn !== undefined) {
    const chips = [...new Set(patch.sameIn.map((c) => c.trim()).filter(Boolean))];
    data.sameInJson = JSON.stringify(chips.slice(0, 8));
  }

  if (Object.keys(data).length > 0) {
    await db.hookTest.update({ where: { id: test.id }, data });
  }
  return getHookTest(test.id, workspaceId);
}

export interface HookTestListRow {
  id: string;
  videoId: string;
  status: string;
  insight: string;
  /** Set when status is 'won': the label of the winning opening. */
  winnerLabel: string | null;
  creatorHandle: string;
  caption: string;
  videoUrl: string;
  thumbUrl: string | null;
  pickedCount: number;
  proposalCount: number;
  createdAt: string;
}

/**
 * Workspace-wide test list — the site's /tests index. Open tests first
 * (newest first), then the graveyard when includeClosed is set.
 */
export async function listHookTests(
  workspaceId: string,
  opts: { includeClosed?: boolean } = {},
): Promise<HookTestListRow[]> {
  const tests = await db.hookTest.findMany({
    where: {
      workspaceId,
      ...(opts.includeClosed ? {} : { status: { in: OPEN_TEST_STATUSES } }),
    },
    orderBy: { createdAt: 'desc' },
    take: 100,
  });

  const videosById = new Map<string, {
    id: string; creatorHandle: string; caption: string; url: string;
    thumbKey: string | null; thumbStatus: string; thumbnailUrl: string;
  }>();
  const versionsByTest = new Map<string, Array<{ status: string }>>();
  await chunked(tests.map((t) => t.videoId), async (ids) => {
    const videos = await db.video.findMany({
      where: { id: { in: ids } },
      select: { id: true, creatorHandle: true, caption: true, url: true, thumbKey: true, thumbStatus: true, thumbnailUrl: true },
    });
    for (const v of videos) videosById.set(v.id, v);
  });
  await chunked(tests.map((t) => t.id), async (ids) => {
    const versions = await db.hookVersion.findMany({
      where: { testId: { in: ids } },
      select: { testId: true, status: true },
    });
    for (const ver of versions) {
      const list = versionsByTest.get(ver.testId) ?? [];
      list.push({ status: ver.status });
      versionsByTest.set(ver.testId, list);
    }
  });

  const rank = (status: string) => (OPEN_TEST_STATUSES.includes(status) ? 0 : 1);
  return tests
    .sort((a, b) => rank(a.status) - rank(b.status))
    .map((t) => {
      const video = videosById.get(t.videoId);
      const versions = versionsByTest.get(t.id) ?? [];
      return {
        id: t.id,
        videoId: t.videoId,
        status: t.status,
        insight: t.insight,
        winnerLabel: t.winnerLabel,
        creatorHandle: video?.creatorHandle ?? '',
        caption: video?.caption ?? '',
        videoUrl: video?.url ?? '',
        thumbUrl: video ? resolveThumbUrl(video) : null,
        pickedCount: versions.filter((v) => v.status === 'picked').length,
        proposalCount: versions.filter((v) => v.status === 'proposed').length,
        createdAt: t.createdAt.toISOString(),
      };
    });
}

/**
 * Markdown shot list. Picked versions only when any exist, else all live
 * proposals — exporting before picking shouldn't dead-end.
 */
export function buildShotlistMarkdown(
  test: SerializedHookTest,
  ctx: { creatorHandle: string; caption: string; url: string },
): string {
  const picked = test.versions.filter((v) => v.status === 'picked');
  const latestRound = test.versions.reduce((m, v) => Math.max(m, v.round), 0);
  const live = picked.length > 0
    ? picked
    : test.versions.filter((v) => v.status === 'proposed' && v.round === latestRound);

  const lines: string[] = [];
  lines.push(`# Shot list — hook test`);
  lines.push('');
  lines.push(`Source: [@${ctx.creatorHandle}](${ctx.url}) — "${ctx.caption}"`);
  lines.push('');
  lines.push(`**Insight:** ${test.insight}`);
  if (test.sameIn.length > 0) lines.push(`**Same in every version:** ${test.sameIn.join('; ')}`);
  if (test.beats.length > 0) lines.push(`**Story shape:** ${test.beats.join(' → ')}`);
  if (test.stopRule) lines.push(`**Stop rule:** ${test.stopRule}`);
  if (picked.length === 0 && live.length > 0) {
    lines.push('');
    lines.push(`_(nothing picked yet — listing all round-${latestRound} proposals)_`);
  }
  for (const v of live) {
    lines.push('');
    lines.push(`## Version ${v.label} — ${v.hookType.replace('_', ' ')}${v.round > 1 ? ` (round ${v.round})` : ''}`);
    lines.push('');
    lines.push(`**Opening line:** "${v.hookText}"`);
    if (v.firstFrame) lines.push(`**First frame:** ${v.firstFrame}`);
    if (v.mechanism) lines.push(`**Why it works:** ${v.mechanism}`);
    if (test.beats.length > 0) {
      lines.push('');
      lines.push('**Beats:**');
      for (const beat of test.beats) lines.push(`- ${beat}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

export async function exportShotlist(testId: string, workspaceId: string) {
  const test = await getHookTest(testId, workspaceId);
  const video = await db.video.findUnique({
    where: { id: test.videoId },
    select: { creatorHandle: true, caption: true, url: true },
  });
  if (!video) throw new HookTestError(`Source video no longer exists: ${test.videoId}`, 404);
  return buildShotlistMarkdown(test, video);
}
