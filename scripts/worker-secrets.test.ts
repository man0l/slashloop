import { describe, expect, test } from 'bun:test';
import { buildPayload } from './sync-worker-secrets.mjs';
import { pruneTargets } from './prune-worker-secrets.mjs';
import {
  FREE_VAR_CAP,
  MANIFEST,
  WORKER_EXCLUDED,
  countedVarNames,
  isPlaceholder,
  projectCountedVarNames,
  pushedWorkerNames,
  readWorkerSettings,
  wranglerVarNames,
} from './worker-secrets.mjs';

/**
 * Names bound to the `slashloop` Worker on 2026-10-01, read from the Cloudflare
 * API. Names and binding types only — never values. Kept as a fixture so the
 * ceiling arithmetic is pinned by a test instead of by a deploy failing: this
 * list is exactly FREE_VAR_CAP long, which is why PR #96's D1_DAILY_READ_LIMIT
 * could not ship (Cloudflare code 10055).
 */
const LIVE_WORKER_VARS_2026_10_01 = [
  'ALERT_EMAIL', 'APIFY_API_KEY', 'APIFY_SPEND_CAP_CENTS', 'CLOUDFLARE_ACCOUNT_ID',
  'CLOUDFLARE_API_TOKEN', 'CRON_SECRET', 'DB_DIALECT', 'GALLERY_LINK_SECRET', 'GEMINI_API_KEY',
  'LLM_PROVIDER', 'MEDIA_SIGNED_URL_TTL_SECONDS', 'OPENROUTER_API_KEY',
  'OPENROUTER_VIDEO_MAX_DURATION_SEC', 'OPENROUTER_VIDEO_MAX_TOKENS', 'OPENROUTER_VIDEO_MODE',
  'OPENROUTER_VIDEO_MODEL', 'OPENROUTER_VIDEO_TIMEOUT_MS', 'PROXY_TRAFFIC_CAP_GB', 'PUBLIC_URL',
  'QUEUE_API_KEY_ID', 'QUEUE_API_KEY_SECRET', 'R2_ACCESS_KEY_ID', 'R2_ACCOUNT_ID', 'R2_ENDPOINT',
  'R2_MEDIA_BUCKET', 'R2_SECRET_ACCESS_KEY', 'R2_THUMB_BUCKET', 'R2_THUMB_PUBLIC_BASE',
  'RESEND_API_KEY', 'RETENTION_DAYS_MAX', 'SCRAPER_PROXY_URL', 'SITE_URL', 'SOCIAL_GOOGLE_CLIENT_ID',
  'SOCIAL_GOOGLE_CLIENT_SECRET', 'SOCIAL_META_CLIENT_ID', 'SOCIAL_META_CLIENT_SECRET',
  'SOCIAL_OAUTH_SECRET', 'SOCIAL_SITE_URL', 'SOCIAL_THREADS_CLIENT_ID', 'SOCIAL_THREADS_CLIENT_SECRET',
  'SOCIAL_TIKTOK_CLIENT_ID', 'SOCIAL_TIKTOK_CLIENT_SECRET', 'STORAGE_MEDIA_BUCKET',
  'STORAGE_THUMB_BUCKET', 'STRIPE_MODE', 'STRIPE_PRICE_CREATOR_MONTH', 'STRIPE_PRICE_CREATOR_YEAR',
  'STRIPE_PRICE_PACK', 'STRIPE_PRICE_PRO_MONTH', 'STRIPE_PRICE_PRO_YEAR', 'STRIPE_SECRET_KEY',
  'STRIPE_TEST_PRICE_CREATOR_MONTH', 'STRIPE_TEST_PRICE_CREATOR_YEAR', 'STRIPE_TEST_PRICE_PACK',
  'STRIPE_TEST_PRICE_PRO_MONTH', 'STRIPE_TEST_PRICE_PRO_YEAR', 'STRIPE_TEST_SECRET_KEY',
  'STRIPE_TEST_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET', 'SUPABASE_ANON_KEY', 'SUPABASE_SECRET_KEY',
  'SUPABASE_URL', 'UPGRADE_URL', 'WORKER_URL',
];

/** What the budget guard adds on top of the live set: wrangler vars + manifest. */
const addedNames = () => [...pushedWorkerNames(), ...wranglerVarNames()];

describe('the Free-plan var ceiling', () => {
  test('the recorded Worker inventory is exactly at the cap', () => {
    expect(LIVE_WORKER_VARS_2026_10_01).toHaveLength(FREE_VAR_CAP);
  });

  test('pruning the excluded names makes room for the var PR #96 could not ship', () => {
    const pruned = LIVE_WORKER_VARS_2026_10_01.filter((name) => !WORKER_EXCLUDED.has(name));
    // The guard would fail today if the prune step did not run: the manifest
    // and wrangler.jsonc both add names that are not bound yet.
    expect(projectCountedVarNames({
      liveNames: LIVE_WORKER_VARS_2026_10_01,
      addedNames: addedNames(),
    }).length).toBeGreaterThan(FREE_VAR_CAP);
    // After the prune, the same projection fits.
    expect(projectCountedVarNames({ liveNames: pruned, addedNames: addedNames() }).length)
      .toBeLessThanOrEqual(FREE_VAR_CAP);
  });

  test('pruning all six leaves more headroom than a plan upgrade would buy for free', () => {
    expect(WORKER_EXCLUDED.size).toBe(6);
    const pruned = LIVE_WORKER_VARS_2026_10_01.filter((name) => !WORKER_EXCLUDED.has(name));
    expect(pruned).toHaveLength(58);
    // 58 live + D1_DAILY_READ_LIMIT (wrangler) + CLOUDFLARE_STREAM_TOKEN (in the
    // manifest, not bound yet). The guard projects the manifest as if every
    // value is set in GitHub, which is the safe direction.
    const projected = projectCountedVarNames({ liveNames: pruned, addedNames: addedNames() });
    expect(projected).toHaveLength(60);
    expect(FREE_VAR_CAP - projected.length).toBeGreaterThanOrEqual(4);
  });
});

describe('MANIFEST / WORKER_EXCLUDED', () => {
  test('an excluded name is never also in the push manifest', () => {
    // The two lists describe opposite intent; overlap would mean the sync step
    // pushes a var the same change claims is unreachable.
    const workerNames = new Set(Object.values(MANIFEST));
    for (const name of WORKER_EXCLUDED) expect(workerNames.has(name)).toBe(false);
  });

  test('every pushed Worker name is unique', () => {
    const names = pushedWorkerNames();
    expect(new Set(names).size).toBe(names.length);
  });

  test('wrangler.jsonc vars parse out of jsonc and include the read-budget knob', () => {
    expect(wranglerVarNames().sort()).toEqual([
      'CLOUDFLARE_ACCOUNT_ID',
      'D1_DAILY_READ_LIMIT',
      'DB_DIALECT',
    ]);
  });
});

describe('buildPayload', () => {
  const everyManifestVarSet = () => Object.fromEntries(Object.keys(MANIFEST).map((name) => [name, 'v']));

  test('drops the excluded names even when GitHub has a value for each', () => {
    const { payload } = buildPayload(everyManifestVarSet());
    for (const name of WORKER_EXCLUDED) {
      expect(payload).not.toHaveProperty(name);
    }
    expect(Object.keys(payload).sort()).toEqual(pushedWorkerNames().sort());
  });

  test('maps the GitHub name to the Worker name and keeps set values', () => {
    const { payload, skipped } = buildPayload({ STRIPE_SECRET_API_KEY: 'sk_live_x', CRON_SECRET: '' });
    expect(payload).toEqual({ STRIPE_SECRET_KEY: 'sk_live_x' });
    expect(skipped).toContain('CRON_SECRET');
    // Everything the env does not set is skipped, not pushed with an empty value.
    expect(skipped).toHaveLength(Object.keys(MANIFEST).length - 1);
  });

  test('skips unset, blank and placeholder values', () => {
    const { payload, skipped } = buildPayload({
      GEMINI_API_KEY: '   ',
      OPENROUTER_API_KEY: '[REDACTED]',
      APIFY_API_KEY: 'changeme',
      SCRAPER_PROXY_URL: 'https://proxy.example.com',
      SUPABASE_URL: 'https://real.supabase.co',
    });
    expect(payload).toEqual({ SUPABASE_URL: 'https://real.supabase.co' });
    expect(skipped).toEqual(
      expect.arrayContaining(['GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'APIFY_API_KEY', 'SCRAPER_PROXY_URL']),
    );
    expect(isPlaceholder('real-value')).toBe(false);
  });
});

describe('pruneTargets', () => {
  test('deletes only the excluded names that are still bound', () => {
    expect(pruneTargets(LIVE_WORKER_VARS_2026_10_01)).toEqual([
      'R2_ACCESS_KEY_ID',
      'R2_ACCOUNT_ID',
      'R2_ENDPOINT',
      'R2_SECRET_ACCESS_KEY',
      'STRIPE_PRICE_PACK',
      'STRIPE_TEST_PRICE_PACK',
    ]);
  });

  test('is a no-op once the Worker no longer carries them', () => {
    const pruned = LIVE_WORKER_VARS_2026_10_01.filter((name) => !WORKER_EXCLUDED.has(name));
    expect(pruneTargets(pruned)).toEqual([]);
  });

  test('never touches a name that is not on the excluded list', () => {
    expect(pruneTargets(['SUPABASE_URL', 'WORKER_URL'])).toEqual([]);
  });
});

describe('countedVarNames', () => {
  test('counts secret_text + plain_text only, and drops the non-env bindings', () => {
    const settings = {
      bindings: [
        { name: 'DB_SHARD0', type: 'd1' },
        { name: 'SHARD_DIRECTORY', type: 'kv_namespace' },
        { name: 'OAUTH_KV', type: 'kv_namespace' },
        { name: 'R2_THUMBS', type: 'r2_bucket' },
        { name: 'R2_MEDIA', type: 'r2_bucket' },
        { name: 'DB_DIALECT', type: 'plain_text' },
        { name: 'CRON_SECRET', type: 'secret_text' },
      ],
    };
    expect(countedVarNames(settings)).toEqual(['DB_DIALECT', 'CRON_SECRET']);
  });

  test('tolerates a settings doc without bindings', () => {
    expect(countedVarNames({})).toEqual([]);
    expect(countedVarNames(undefined)).toEqual([]);
  });
});

describe('projectCountedVarNames', () => {
  test('adds only names that are not already bound', () => {
    expect(projectCountedVarNames({
      liveNames: ['A', 'B'],
      addedNames: ['B', 'C'],
    })).toEqual(['A', 'B', 'C']);
  });

  test('over-counts rather than assuming a prune happened', () => {
    // A missed prune must fail the guard, not pass it: nothing is subtracted.
    const projected = projectCountedVarNames({
      liveNames: LIVE_WORKER_VARS_2026_10_01,
      addedNames: ['NEW_ONE'],
    });
    expect(projected).toContain('R2_ACCOUNT_ID');
    expect(projected.length).toBe(FREE_VAR_CAP + 1);
  });
});

describe('readWorkerSettings', () => {
  test('refuses to guess when the token or account is missing', async () => {
    await expect(readWorkerSettings({ accountId: '', token: 't' })).rejects.toThrow(/CLOUDFLARE_ACCOUNT_ID/);
    await expect(readWorkerSettings({ accountId: 'a', token: '' })).rejects.toThrow(/CLOUDFLARE_API_TOKEN/);
  });

  test('reads settings with a bearer token and returns the result', async () => {
    const calls: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      calls.push([url, init]);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, result: { bindings: [{ name: 'A', type: 'secret_text' }] } }),
      };
    };
    const settings = await readWorkerSettings({ accountId: 'acct', token: 'tok', fetchImpl: fetchImpl as never });
    expect(countedVarNames(settings)).toEqual(['A']);
    expect(calls[0][0]).toContain('/accounts/acct/workers/scripts/slashloop/settings');
    expect((calls[0][1]?.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  test('surfaces an API error instead of pretending the Worker has no vars', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, statusText: 'Forbidden', json: async () => ({}) });
    await expect(readWorkerSettings({ accountId: 'acct', token: 'tok', fetchImpl: fetchImpl as never }))
      .rejects.toThrow(/403/);
  });
});