// Social lanes + weekly rotation planner (SLA-1177). Pure and DB-free: callers
// pass in the connected accounts and the rotation config, get back dated rows
// that each map 1:1 onto create_social_post({ integrationIds: [row.integrationId],
// publishAt: row.publishAt }). Nothing here creates posts or reads the clock.
//
// Vocabulary on an account's tags: `lane:<name>` (at most one) and `primary`
// (at most one per lane). A lane is the set of accounts sharing a lane tag;
// every member posts the same video at the same minute, the primary listed first.

export const PRIMARY_TAG = 'primary';
export const LANE_PREFIX = 'lane:';
const LANE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SLOT_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY_MS = 86_400_000;

export const MAX_PLAN_DAYS = 62;
export const MAX_SLOTS = 12;

// ── tags ────────────────────────────────────────────────────────────────────

export type TagError = { error: 'invalid_tag' | 'primary_needs_lane'; message: string };
export type ParsedTags = { ok: true; tags: string[]; lane: string | null; primary: boolean } | ({ ok: false } & TagError);

/** Lane names are matched case-insensitively and stored lowercase. */
export function normalizeLaneName(name: string): string | null {
  const n = name.trim().toLowerCase();
  return LANE_NAME_RE.test(n) ? n : null;
}

export function validateTags(input: string[]): ParsedTags {
  const tags: string[] = [];
  let lane: string | null = null;
  let primary = false;
  for (const raw of input) {
    const tag = raw.trim().toLowerCase();
    if (tag === PRIMARY_TAG) {
      primary = true;
    } else if (tag.startsWith(LANE_PREFIX)) {
      const name = normalizeLaneName(tag.slice(LANE_PREFIX.length));
      if (!name) {
        return { ok: false, error: 'invalid_tag', message: `"${raw}" is not a valid lane tag: use lane:<name> with lowercase letters, digits, "-" or "_" (max 40 chars).` };
      }
      if (lane !== null && lane !== name) {
        return { ok: false, error: 'invalid_tag', message: `An account belongs to at most one lane; got lane:${lane} and lane:${name}.` };
      }
      lane = name;
    } else {
      return { ok: false, error: 'invalid_tag', message: `"${raw}" is not an allowed tag. Allowed: lane:<name> (one per account) and primary.` };
    }
  }
  if (primary && lane === null) {
    return { ok: false, error: 'primary_needs_lane', message: '"primary" marks the lead account of a lane — add a lane:<name> tag too.' };
  }
  if (lane !== null) tags.push(`${LANE_PREFIX}${lane}`);
  if (primary) tags.push(PRIMARY_TAG);
  return { ok: true, tags, lane, primary };
}

/** Read the stored JSON column; anything unreadable counts as no tags. */
export function parseStoredTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : [];
  } catch {
    return [];
  }
}

export function laneAndPrimary(tags: string[]): { lane: string | null; primary: boolean } {
  const lane = tags.find((t) => t.startsWith(LANE_PREFIX));
  return { lane: lane ? lane.slice(LANE_PREFIX.length) : null, primary: tags.includes(PRIMARY_TAG) };
}

// ── calendar math (all in the rotation timezone) ────────────────────────────

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 'YYYY-MM-DD' → epoch ms at UTC midnight of that calendar date, or null. */
function dateToUtcMs(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(ms).toISOString().slice(0, 10) === date ? ms : null;
}

const utcMsToDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

export function isValidDate(date: string): boolean {
  return dateToUtcMs(date) !== null;
}

/** Calendar weekday (0 = Sunday). A date's weekday does not depend on the zone. */
export function weekdayOf(date: string): number {
  const ms = dateToUtcMs(date);
  if (ms === null) throw new Error(`invalid date ${date}`);
  return new Date(ms).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const ms = dateToUtcMs(date);
  if (ms === null) throw new Error(`invalid date ${date}`);
  return utcMsToDate(ms + days * DAY_MS);
}

export function mondayOf(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** Zero-based rotation week: floor((mondayOf(date) - anchorMonday) / periodDays). */
export function rotationWeek(date: string, anchorMonday: string, periodDays: number): number {
  const a = dateToUtcMs(anchorMonday);
  const m = dateToUtcMs(mondayOf(date));
  if (a === null || m === null) throw new Error('invalid date');
  return Math.floor((m - a) / DAY_MS / periodDays);
}

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** Index into `lanes` for 1-based video `v` in `week`: every week is a permutation. */
export function laneIndex(video: number, week: number, laneCount: number): number {
  return mod(video - 1 - week, laneCount);
}

function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second')) - Math.floor(utcMs / 1000) * 1000;
}

/** Wall-clock `date` + 'HH:MM' in `tz` → UTC ISO instant. A time skipped by a
 *  spring-forward gap resolves to the instant just after the gap. */
export function localToUtcIso(date: string, hhmm: string, tz: string): string {
  const day = dateToUtcMs(date);
  const slot = SLOT_RE.exec(hhmm);
  if (day === null || !slot) throw new Error(`invalid local time ${date} ${hhmm}`);
  const wall = day + (Number(slot[1]) * 60 + Number(slot[2])) * 60_000;
  let utc = wall - offsetMs(wall, tz);
  utc = wall - offsetMs(utc, tz);
  return new Date(utc).toISOString();
}

export const isValidSlot = (s: string): boolean => SLOT_RE.test(s);

// ── planner ─────────────────────────────────────────────────────────────────

export interface RotationConfig {
  name: string;
  lanes: string[];
  anchorMonday: string;
  periodDays: number;
  timezone: string;
}

export interface RotationAccount {
  integrationId: string;
  provider: string;
  /** The platform's account id: the same one connected under two owners is one account. */
  internalId: string;
  handle: string;
  tags: string[];
  refreshNeeded: boolean;
  disabled: boolean;
}

export interface PlanRow {
  date: string;
  week: number;
  video: number;
  lane: string;
  integrationId: string;
  provider: string;
  handle: string;
  role: 'primary' | 'repost';
  publishAt: string;
  /** Present only when the planned lane's primary was unhealthy and the video moved on. */
  movedFrom?: string;
}

export interface RotationPlan {
  rows: PlanRow[];
  problems: string[];
  rotation: RotationConfig;
}

const healthIssue = (a: RotationAccount): string | null => (a.disabled ? 'disabled' : a.refreshNeeded ? 'reconnect needed' : null);

interface Lane {
  name: string;
  primary: RotationAccount | null;
  /** Healthy members, primary first. */
  members: RotationAccount[];
}

export function planRotation(
  rotation: RotationConfig,
  accounts: RotationAccount[],
  input: { from: string; days: number; slots: string[] },
): RotationPlan {
  const problems: string[] = [];
  const laneNames = rotation.lanes;

  // Dedupe the same platform account connected under several owners (first seen wins).
  const seen = new Map<string, RotationAccount>();
  const unique: RotationAccount[] = [];
  for (const a of accounts) {
    if (!laneAndPrimary(a.tags).lane) continue;
    const key = `${a.provider}:${a.internalId}`;
    const first = seen.get(key);
    if (first) {
      problems.push(`${a.handle}: ${a.provider} account also connected as ${a.integrationId}; using ${first.integrationId} only`);
      continue;
    }
    seen.set(key, a);
    unique.push(a);
  }

  const lanes = new Map<string, Lane>();
  for (const name of laneNames) lanes.set(name, { name, primary: null, members: [] });
  for (const a of unique) {
    const { lane: laneName, primary } = laneAndPrimary(a.tags);
    const lane = laneName ? lanes.get(laneName) : undefined;
    if (!lane) continue;
    const issue = healthIssue(a);
    if (issue) {
      problems.push(`${a.handle}: ${issue}`);
      continue;
    }
    if (primary) {
      if (lane.primary) {
        problems.push(`lane ${lane.name}: more than one healthy primary; using ${lane.primary.handle}, ${a.handle} posts as a repost`);
        lane.members.push(a);
      } else {
        lane.primary = a;
        lane.members.unshift(a);
      }
    } else {
      lane.members.push(a);
    }
  }
  // An unhealthy primary is excluded from `members`; it still counts as "has a primary" for the message.
  const primaryTagged = new Set(unique.filter((a) => laneAndPrimary(a.tags).primary).map((a) => laneAndPrimary(a.tags).lane));

  const rows: PlanRow[] = [];
  const L = laneNames.length;
  for (let d = 0; d < input.days; d++) {
    const date = addDays(input.from, d);
    const week = rotationWeek(date, rotation.anchorMonday, rotation.periodDays);
    input.slots.forEach((slot, i) => {
      const video = i + 1;
      const planned = laneIndex(video, week, L);
      let chosen: Lane | null = null;
      let step = 0;
      for (; step < L; step++) {
        const candidate = lanes.get(laneNames[(planned + step) % L]!)!;
        if (candidate.primary) { chosen = candidate; break; }
      }
      const plannedName = laneNames[planned]!;
      if (!chosen) {
        problems.push(`${date} video ${video}: no lane has a healthy primary, video dropped`);
        return;
      }
      if (step > 0) {
        const why = primaryTagged.has(plannedName) ? 'primary unhealthy' : 'no primary';
        problems.push(`lane ${plannedName}: ${why} on ${date}, video ${video} moved to ${chosen.name}`);
      }
      const publishAt = localToUtcIso(date, slot, rotation.timezone);
      for (const m of chosen.members) {
        rows.push({
          date,
          week,
          video,
          lane: chosen.name,
          integrationId: m.integrationId,
          provider: m.provider,
          handle: m.handle,
          role: m === chosen.primary ? 'primary' : 'repost',
          publishAt,
          ...(step > 0 ? { movedFrom: plannedName } : {}),
        });
      }
    });
  }
  return { rows, problems, rotation };
}
