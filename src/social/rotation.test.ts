import { describe, expect, test } from 'bun:test';
import {
  localToUtcIso,
  mondayOf,
  planRotation,
  rotationWeek,
  validateTags,
  type RotationAccount,
  type RotationConfig,
} from './rotation.js';

const SLOTS = ['09:00', '13:00', '19:00'];
const cfg = (lanes: string[], over: Partial<RotationConfig> = {}): RotationConfig => ({
  name: 'maxxing', lanes, anchorMonday: '2026-11-02', periodDays: 7, timezone: 'America/New_York', ...over,
});

let n = 0;
function acct(lane: string, handle: string, over: Partial<RotationAccount> & { primary?: boolean } = {}): RotationAccount {
  const { primary, ...rest } = over;
  n += 1;
  return {
    integrationId: `id-${handle}-${n}`, provider: 'instagram', internalId: `int-${handle}`, handle,
    tags: primary ? [`lane:${lane}`, 'primary'] : [`lane:${lane}`], refreshNeeded: false, disabled: false, ...rest,
  };
}

/** jenny/alice/spoon: an Instagram primary and a YouTube repost each. */
function roster(): RotationAccount[] {
  return ['jenny', 'alice', 'spoon'].flatMap((l) => [
    acct(l, `${l}-ig`, { primary: true }),
    acct(l, `${l}-yt`, { provider: 'youtube' }),
  ]);
}

const plan = (accounts: RotationAccount[], over: Partial<RotationConfig> = {}, from = '2026-11-02', days = 1) =>
  planRotation(cfg(['jenny', 'alice', 'spoon'], over), accounts, { from, days, slots: SLOTS });

describe('calendar math', () => {
  test('mondayOf / rotationWeek, including before the anchor', () => {
    expect(mondayOf('2026-11-08')).toBe('2026-11-02');
    expect(mondayOf('2026-11-09')).toBe('2026-11-09');
    expect(rotationWeek('2026-11-02', '2026-11-02', 7)).toBe(0);
    expect(rotationWeek('2026-11-08', '2026-11-02', 7)).toBe(0);
    expect(rotationWeek('2026-11-09', '2026-11-02', 7)).toBe(1);
    expect(rotationWeek('2026-10-26', '2026-11-02', 7)).toBe(-1);
    expect(rotationWeek('2026-11-16', '2026-11-02', 14)).toBe(1);
  });

  test('DST: the 2026-11-01 fall-back Sunday leaves Monday 09:00 ET at 14:00Z', () => {
    expect(localToUtcIso('2026-10-30', '09:00', 'America/New_York')).toBe('2026-10-30T13:00:00.000Z');
    expect(localToUtcIso('2026-11-02', '09:00', 'America/New_York')).toBe('2026-11-02T14:00:00.000Z');
    expect(localToUtcIso('2027-03-14', '03:30', 'America/New_York')).toBe('2027-03-14T07:30:00.000Z');
  });
});

describe('validateTags', () => {
  test('accepts lane + primary, normalizes and dedupes', () => {
    expect(validateTags([' Lane:Jenny ', 'PRIMARY', 'lane:jenny'])).toMatchObject({ ok: true, tags: ['lane:jenny', 'primary'], lane: 'jenny', primary: true });
    expect(validateTags([])).toMatchObject({ ok: true, tags: [], lane: null, primary: false });
  });
  test('rejects anything else', () => {
    expect(validateTags(['funny'])).toMatchObject({ ok: false, error: 'invalid_tag' });
    expect(validateTags(['lane:'])).toMatchObject({ ok: false, error: 'invalid_tag' });
    expect(validateTags(['lane:a', 'lane:b'])).toMatchObject({ ok: false, error: 'invalid_tag' });
    expect(validateTags(['primary'])).toMatchObject({ ok: false, error: 'primary_needs_lane' });
  });
});

describe('planRotation', () => {
  test('every week is a permutation of the lanes for L = 1..4', () => {
    for (let L = 1; L <= 4; L++) {
      const lanes = Array.from({ length: L }, (_, i) => `l${i}`);
      const accounts = lanes.map((l) => acct(l, `${l}-ig`, { primary: true }));
      const { rows, problems } = planRotation(cfg(lanes), accounts, { from: '2026-11-02', days: 42, slots: lanes.map((_, i) => `${String(8 + i).padStart(2, '0')}:00`) });
      expect(problems).toEqual([]);
      for (let w = 0; w < 6; w++) {
        for (let d = 0; d < 7; d++) {
          const date = new Date(Date.UTC(2026, 10, 2 + w * 7 + d)).toISOString().slice(0, 10);
          const day = rows.filter((r) => r.date === date);
          expect(day.map((r) => r.lane).sort()).toEqual([...lanes].sort());
          expect(new Set(day.map((r) => r.video)).size).toBe(L);
        }
      }
    }
  });

  test('week 0 maps v1→lane0, v2→lane1; week 1 puts video 2 on lane 0', () => {
    const accounts = roster();
    const w0 = plan(accounts, {}, '2026-11-02').rows.filter((r) => r.role === 'primary');
    expect(w0.map((r) => [r.video, r.lane])).toEqual([[1, 'jenny'], [2, 'alice'], [3, 'spoon']]);
    const w1 = plan(accounts, {}, '2026-11-09').rows.filter((r) => r.role === 'primary');
    expect(w1.map((r) => [r.video, r.lane, r.week])).toEqual([[1, 'spoon', 1], [2, 'jenny', 1], [3, 'alice', 1]]);
  });

  test('first-day rows: primary first, repost after, local slots converted to UTC', () => {
    const { rows, problems } = plan(roster());
    expect(problems).toEqual([]);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 2).map((r) => [r.handle, r.role, r.publishAt])).toEqual([
      ['jenny-ig', 'primary', '2026-11-02T14:00:00.000Z'],
      ['jenny-yt', 'repost', '2026-11-02T14:00:00.000Z'],
    ]);
    expect(rows[2]!.publishAt).toBe('2026-11-02T18:00:00.000Z');
    expect(rows[4]!.publishAt).toBe('2026-11-03T00:00:00.000Z');
  });

  test('same-minute publishAt across a lane, even when the repost is listed first', () => {
    const [jig, jyt, ...rest] = roster();
    const { rows } = plan([jyt!, jig!, ...rest]);
    const jenny = rows.filter((r) => r.lane === 'jenny');
    expect(jenny.map((r) => r.role)).toEqual(['primary', 'repost']);
    expect(new Set(jenny.map((r) => r.publishAt)).size).toBe(1);
  });

  test('unhealthy primary: the video moves to the next lane, which ends the day with two', () => {
    const accounts = roster();
    accounts.find((a) => a.handle === 'alice-ig')!.refreshNeeded = true;
    const { rows, problems } = plan(accounts, {}, '2026-11-02');
    const byLane = (l: string) => rows.filter((r) => r.lane === l && r.role === 'primary').map((r) => r.video);
    expect(byLane('jenny')).toEqual([1]);
    expect(byLane('alice')).toEqual([]);
    expect(byLane('spoon')).toEqual([2, 3]);
    expect(rows.filter((r) => r.video === 2).every((r) => r.movedFrom === 'alice' && r.lane === 'spoon')).toBe(true);
    expect(problems).toContain('alice-ig: reconnect needed');
    expect(problems).toContain('lane alice: primary unhealthy on 2026-11-02, video 2 moved to spoon');
    expect(rows.some((r) => r.handle.startsWith('alice'))).toBe(false);
  });

  test('fall-through wraps past the end of the lane list', () => {
    const accounts = roster();
    accounts.find((a) => a.handle === 'spoon-ig')!.disabled = true;
    const { rows, problems } = plan(accounts, {}, '2026-11-02');
    expect(rows.filter((r) => r.video === 3 && r.role === 'primary')[0]!.lane).toBe('jenny');
    expect(problems).toContain('spoon-ig: disabled');
    expect(problems).toContain('lane spoon: primary unhealthy on 2026-11-02, video 3 moved to jenny');
  });

  test('a lane with no primary hands its video on', () => {
    const accounts = roster().filter((a) => a.handle !== 'alice-ig');
    const { rows, problems } = plan(accounts);
    expect(rows.filter((r) => r.video === 2).every((r) => r.lane === 'spoon')).toBe(true);
    expect(problems).toContain('lane alice: no primary on 2026-11-02, video 2 moved to spoon');
  });

  test('no healthy primary anywhere drops the row and reports it', () => {
    const accounts = roster().map((a) => ({ ...a, disabled: true }));
    const { rows, problems } = plan(accounts);
    expect(rows).toEqual([]);
    expect(problems).toContain('2026-11-02 video 1: no lane has a healthy primary, video dropped');
  });

  test('an unhealthy repost is skipped and reported but does not move the video', () => {
    const accounts = roster();
    accounts.find((a) => a.handle === 'jenny-yt')!.refreshNeeded = true;
    const { rows, problems } = plan(accounts);
    expect(rows.filter((r) => r.lane === 'jenny').map((r) => r.handle)).toEqual(['jenny-ig']);
    expect(problems).toEqual(['jenny-yt: reconnect needed']);
  });

  test('untagged accounts never appear', () => {
    const accounts = [...roster(), acct('x', 'personal', { tags: [] }), acct('y', 'stray', { tags: ['lane:ghost'] })];
    const { rows, problems } = plan(accounts);
    expect(rows.map((r) => r.handle)).not.toContain('personal');
    expect(rows.map((r) => r.handle)).not.toContain('stray');
    expect(problems).toEqual([]);
  });

  test('cross-owner duplicate posts once; first seen wins and the other is reported', () => {
    const accounts = roster();
    const dup = { ...accounts[0]!, integrationId: 'other-owner-copy' };
    const { rows, problems } = plan([...accounts, dup]);
    expect(rows.filter((r) => r.handle === 'jenny-ig')).toHaveLength(1);
    expect(rows.some((r) => r.integrationId === 'other-owner-copy')).toBe(false);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('other-owner-copy');
  });

  test('DST week: 2026-11-02 slots stay 09:00 ET (14:00Z) after the 2026-11-01 fall-back', () => {
    const { rows } = plan(roster(), {}, '2026-10-30', 5);
    const firstSlot = (date: string) => rows.find((r) => r.date === date && r.video === 1)!.publishAt;
    expect(firstSlot('2026-10-30')).toBe('2026-10-30T13:00:00.000Z');
    expect(firstSlot('2026-11-02')).toBe('2026-11-02T14:00:00.000Z');
  });
});
