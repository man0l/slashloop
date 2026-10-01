import { describe, expect, test } from 'bun:test';
import {
  ancestorCompare,
  selectBlockingJob,
  selectFailedAncestors,
  selectUnshippedFailures,
} from './deploy-lineage.mjs';

const runs = [
  { id: 183, run_number: 183, head_sha: 'descendant', conclusion: 'success', created_at: '2026-09-30T12:16:00Z' },
  { id: 182, run_number: 182, head_sha: 'failed-fix', conclusion: 'failure', created_at: '2026-09-30T12:09:00Z' },
  { id: 181, run_number: 181, head_sha: 'previous', conclusion: 'success', created_at: '2026-09-30T11:53:00Z' },
  { id: 174, run_number: 174, head_sha: 'old-failure', conclusion: 'failure', created_at: '2026-09-28T03:50:00Z' },
];

describe('selectFailedAncestors', () => {
  test('marks only failures newer than the previous successful publish', () => {
    const { prevSuccess, failed } = selectFailedAncestors(runs, { headSha: 'descendant', runId: 183 });
    expect(prevSuccess?.head_sha).toBe('previous');
    expect(failed.map((run) => run.head_sha)).toEqual(['failed-fix']);
  });

  test('a later success does not re-mark a hole the previous publish already closed', () => {
    const later = [
      { id: 185, run_number: 185, head_sha: 'head', conclusion: 'success', created_at: '2026-09-30T12:40:00Z' },
      ...runs,
    ];
    const { prevSuccess, failed } = selectFailedAncestors(later, { headSha: 'head', runId: 185 });
    expect(prevSuccess?.head_sha).toBe('descendant');
    expect(failed).toEqual([]);
  });

  test('skips a sha that also has a successful run', () => {
    const rerun = [
      { id: 190, run_number: 190, head_sha: 'head', conclusion: 'success', created_at: '2026-09-30T13:00:00Z' },
      { id: 189, run_number: 189, head_sha: 'same', conclusion: 'success', created_at: '2026-09-30T12:50:00Z' },
      { id: 188, run_number: 188, head_sha: 'same', conclusion: 'failure', created_at: '2026-09-30T12:40:00Z' },
      { id: 181, run_number: 181, head_sha: 'previous', conclusion: 'success', created_at: '2026-09-30T11:53:00Z' },
    ];
    const { failed } = selectFailedAncestors(rerun, { headSha: 'head', runId: 190 });
    expect(failed).toEqual([]);
  });
});

describe('selectUnshippedFailures', () => {
  test('keeps a failed sha that a later descendant publish already covered', () => {
    const later = [
      { id: 185, run_number: 185, head_sha: 'head', conclusion: 'success', created_at: '2026-09-30T12:40:00Z' },
      ...runs,
    ];
    const failed = selectUnshippedFailures(later, { headSha: 'head', runId: 185 });
    expect(failed.map((run) => run.head_sha)).toEqual(['failed-fix', 'old-failure']);
  });
});

describe('ancestorCompare', () => {
  test('treats ahead and identical as contained', () => {
    expect(ancestorCompare('ahead')).toBe(true);
    expect(ancestorCompare('identical')).toBe(true);
    expect(ancestorCompare('behind')).toBe(false);
    expect(ancestorCompare('diverged')).toBe(false);
  });
});

// Run 188's shape: verify failed, so deploy never ran. The status on that SHA
// said only "not published" — indistinguishable from a D1 quota refusal or a
// failed smoke check.
describe('selectBlockingJob', () => {
  test('names verify when a red gate skipped deploy', () => {
    expect(selectBlockingJob({ verify: 'failure', deploy: 'skipped' })).toBe('verify');
  });

  test('names deploy when the gate passed and the publish itself failed', () => {
    expect(selectBlockingJob({ verify: 'success', deploy: 'failure' })).toBe('deploy');
  });

  test('names nothing when the run published', () => {
    expect(selectBlockingJob({ verify: 'success', deploy: 'success' })).toBeNull();
  });

  // A cancelled or manually re-run workflow skips deploy with no failing
  // predecessor. Guessing a job here would be worse than silence.
  test('names nothing when deploy was skipped without a failure', () => {
    expect(selectBlockingJob({ verify: 'success', deploy: 'skipped' })).toBeNull();
    expect(selectBlockingJob({ verify: 'cancelled', deploy: 'skipped' })).toBeNull();
    expect(selectBlockingJob({ verify: 'cancelled', deploy: 'cancelled' })).toBeNull();
  });

  // verify failed AND deploy failed cannot happen through needs, but if the
  // gate is ever loosened the upstream job is still the honest answer.
  test('verify wins when both report failure', () => {
    expect(selectBlockingJob({ verify: 'failure', deploy: 'failure' })).toBe('verify');
  });

  test('missing or malformed results name nothing instead of throwing', () => {
    expect(selectBlockingJob(undefined)).toBeNull();
    expect(selectBlockingJob({})).toBeNull();
    expect(selectBlockingJob('failure')).toBeNull();
  });
});
