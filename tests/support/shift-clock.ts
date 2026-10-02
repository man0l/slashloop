/**
 * Bun preload that moves the wall clock, so a test which mixes `new Date()`
 * with a hardcoded date anchor fails on the day it is written instead of the
 * day after the calendar moves.
 *
 * Why this exists — SLA-323. `src/cf/d1-read-budget.test.ts` recorded its
 * simulated KV-write failure with `new Date()` while the runaway replay read
 * from a hardcoded `AT = 2026-10-01`. `writeDegraded` is sticky per UTC day, so
 * once the wall clock rolled past 2026-10-01 the day rollover dropped the blip
 * and the assertion measured nothing. CI was green on the authoring day and red
 * on every day after, and because `deploy` is `needs: verify` every push to
 * master was blocked with it. **A suite that mixes the wall clock with a fixed
 * clock anchor is time-dependent by construction** — shifting the clock is how
 * you find out on the same day.
 *
 * `bun run test:clock-shift` runs the date-anchored suites under this preload.
 * It is deliberately NOT applied to the whole suite: the queue and timeout tests
 * measure real elapsed time and would only gain noise from a shifted clock.
 *
 * Extending the list. The suites below are the ones that mix a wall-clock read
 * with a fixed anchor, as of SLA-324. Re-derive when you add a clock-anchored
 * suite — a file qualifies when it contains BOTH a wall-clock read and a fixed
 * anchor:
 *
 *   for f in $(find src -name '*.test.ts' | sort); do
 *     grep -qE 'new Date\(\s*\)|Date\.now\(\)' "$f" &&
 *     grep -qE "new Date\('?[0-9]{4}-[0-9]{2}-[0-9]{2}" "$f" && echo "$f"
 *   done
 *
 * Checked and deliberately excluded: `src/cf/serialize-d1.test.ts` matches that
 * pattern but its `Date.now()` calls only measure elapsed durations around a
 * hardcoded ISO fixture; there is no day-anchored comparison to break, and both
 * endpoints of each delta shift together.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days to jump. Negative shifts backwards; `0` disables the shift. */
const SHIFT_DAYS = Number(process.env.CLOCK_SHIFT_DAYS ?? 400);
if (!Number.isFinite(SHIFT_DAYS)) {
  throw new Error(`shift-clock: CLOCK_SHIFT_DAYS must be a finite number, got ${process.env.CLOCK_SHIFT_DAYS}`);
}
const OFFSET_MS = Math.round(SHIFT_DAYS * DAY_MS);

const RealDate = Date;

class ShiftedDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) {
      // Zero-arg: the caller asked for "now", which is the thing being moved.
      super(RealDate.now() + OFFSET_MS);
    } else {
      // Argument-taking `new Date(...)` keeps the clock it was handed. A
      // hardcoded anchor has to stay exactly where the suite put it, or the
      // shift would move the anchor too and prove nothing.
      super(...(args as [number]));
    }
  }

  static now(): number {
    return RealDate.now() + OFFSET_MS;
  }
}

globalThis.Date = ShiftedDate as unknown as DateConstructor;

/**
 * Prove the shift took, before any assertion is trusted.
 *
 * A preload that silently failed to install would report green while measuring
 * nothing — the exact failure this guardrail exists to catch, one level up. So
 * the invariants are asserted here, at load time, where the message names the
 * cause instead of surfacing as a mystery test failure later.
 */
function verifyShift(): void {
  const problems: string[] = [];

  // The shifted and real readings are two separate wall-clock reads, so they can
  // disagree by the few ms that elapsed between them. Anything outside that
  // window means the offset itself is wrong, not the clock's granularity.
  const READ_DRIFT_TOLERANCE_MS = 1_000;
  const checkShift = (label: string, shifted: number, real: number): void => {
    const delta = shifted - real;
    if (delta < OFFSET_MS || delta > OFFSET_MS + READ_DRIFT_TOLERANCE_MS) {
      problems.push(`${label} is off by ${delta}ms, expected ~${OFFSET_MS}ms`);
    }
  };

  checkShift('Date.now()', Date.now(), RealDate.now());
  checkShift('new Date()', new Date().getTime(), new RealDate().getTime());
  if (new Date(0).getTime() !== 0) problems.push('new Date(0) was shifted');
  if (new Date('2026-10-01T09:00:00Z').getTime() !== Date.parse('2026-10-01T09:00:00Z')) {
    problems.push('new Date(<ISO string>) was shifted');
  }
  if (Date.UTC(2026, 9, 1) !== RealDate.UTC(2026, 9, 1)) problems.push('Date.UTC was shifted');
  if (Date.parse('2026-10-01T09:00:00Z') !== RealDate.parse('2026-10-01T09:00:00Z')) {
    problems.push('Date.parse was shifted');
  }
  if (!(new Date() instanceof RealDate)) problems.push('shifted dates are not real Date instances');

  if (problems.length > 0) {
    throw new Error(`shift-clock: the clock did not shift correctly, so this run proves nothing.\n  - ${problems.join('\n  - ')}`);
  }
}

verifyShift();

if (OFFSET_MS !== 0) {
  const direction = SHIFT_DAYS < 0 ? 'backward' : 'forward';
  console.log(
    `[shift-clock] wall clock moved ${Math.abs(SHIFT_DAYS)}d ${direction}: ` +
      `${new RealDate().toISOString()} -> ${new Date().toISOString()}`,
  );
} else {
  console.log('[shift-clock] CLOCK_SHIFT_DAYS=0 — clock left alone (guardrail disabled on purpose)');
}