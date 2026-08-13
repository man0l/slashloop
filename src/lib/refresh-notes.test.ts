import { describe, expect, test } from 'bun:test';
import { INFO_PREFIX, infoNote, isInfoNote, failureLines, infoLines, stripInfoPrefix } from './refresh-notes.js';

describe('refresh log classification', () => {
  test('bookkeeping written by this build is never a failure', () => {
    const line = infoNote('Refresh policy: mode=incremental limit=5');
    expect(line.startsWith(INFO_PREFIX)).toBe(true);
    expect(isInfoNote(line)).toBe(true);
    expect(failureLines([line])).toEqual([]);
  });

  test('tagging is idempotent — a note never gets a double marker', () => {
    expect(infoNote(infoNote('x'))).toBe(INFO_PREFIX + 'x');
  });

  test('untagged rows already in the database stop raising false alarms', () => {
    // Written before the marker existed; still bookkeeping, not a failure.
    const legacy = [
      'Refresh policy: mode=incremental limit=5',
      'Already known: 1/3 results were existing videos (stats updated; not new outliers)',
      'Recency filter: 2 of 5 scraped videos were older than 3 months and were not saved (cosmetic only)',
      "Per-source watermark: 3 items older than this source's postedAfter were ignored after a widened batch scrape",
      'Multi-tenant batch: 2 sources shared one Apify scrape',
      'Resumed dataset abc123 from a previous attempt — no new Apify run, 0c',
      'Thumbnail ingest: 4 beyond the per-run cap of 15 queued as thumb jobs (4 enqueued)',
    ];
    expect(failureLines(legacy)).toEqual([]);
  });

  test('real failures still survive the filter', () => {
    const lines = [
      infoNote('Refresh policy: mode=incremental limit=5'),
      'Scoring failed: connection reset',
      'Thumbnail ingest: 2/5 failed',
      'Apify: run failed [actor-timeout]',
      'could not queue rescore: db down',
    ];
    expect(failureLines(lines)).toEqual([
      'Scoring failed: connection reset',
      'Thumbnail ingest: 2/5 failed',
      'Apify: run failed [actor-timeout]',
      'could not queue rescore: db down',
    ]);
  });

  test('the notes are still readable back — the log is kept, only hidden', () => {
    const lines = [infoNote('Refresh policy: mode=incremental limit=5'), 'Scoring failed: boom'];
    expect(infoLines(lines)).toEqual(['Refresh policy: mode=incremental limit=5']);
    expect(stripInfoPrefix('plain')).toBe('plain');
  });
});
