// Guardrail for the local mirror of the deployed queue compose config
// (SLA-330). The prod copy lives in man0l/salonease
// (docker-compose.prod.yml) and nothing automated compares the two, so the
// properties prod actually depends on were asserted nowhere — the
// watchtower label was dropped from the mirror AND from prod in the same
// shape, and a merged src/queue/** fix sat un-deployed for 4 days while
// the box looked freshly deployed (the workers did update).
//
// Text-scoped on purpose: a YAML parser would be a phantom dependency
// (neither `yaml` nor `js-yaml` is in package.json), and the assertions are
// about lines an editor adds, removes, or flips, not about resolved YAML.
import { describe, expect, test } from 'bun:test';

const FRAGMENT = new URL('./queue-compose.fragment.yml', import.meta.url).pathname;

function serviceBlock(source: string, service: string): string {
  const start = source.search(new RegExp(`^  ${service}:$`, 'm'));
  if (start < 0) throw new Error(`service ${service} not found in the fragment`);
  // A compose service block runs until the next line at 2-space indent that
  // starts a new key (`  other:`) or the end of the services map.
  const rest = source.slice(start);
  const end = rest.slice(1).search(/\n {2}\S/);
  return end < 0 ? rest : rest.slice(0, end + 1);
}

const fragment = await Bun.file(FRAGMENT).text();

describe('queue-api is watchtower-managed (SLA-330)', () => {
  test('carries the enable label watchtower actually reads', () => {
    expect(serviceBlock(fragment, 'queue-api')).toContain(
      'com.centurylinklabs.watchtower.enable=true',
    );
  });

  test('is not excluded by a stray disable label', () => {
    expect(fragment).not.toContain('com.centurylinklabs.watchtower.enable=false');
  });
});

describe('queue service edges stay internal-only', () => {
  // Postgres must never be published, and queue-api answers only via Traefik.
  for (const service of ['queue-db', 'queue-api'] as const) {
    test(`${service} publishes no host ports`, () => {
      expect(serviceBlock(fragment, service)).not.toMatch(/^\s{4}ports:/m);
    });
  }

  test('queue-api still waits for a healthy queue-db', () => {
    expect(serviceBlock(fragment, 'queue-api')).toMatch(
      /depends_on:\s*\n\s+queue-db:\s*\n\s+condition: service_healthy/,
    );
  });

  test('the router rule still allowlists only queue.slashloop.dev', () => {
    expect(serviceBlock(fragment, 'queue-api')).toContain(
      'traefik.http.routers.queue-api.rule=Host(`queue.slashloop.dev`) && (Path(`/healthz`) || PathPrefix(`/v1/jobs`))',
    );
  });

  test('queue-api keeps secrets in the environment, never in the image', () => {
    const api = serviceBlock(fragment, 'queue-api');
    expect(api).toContain('QUEUE_API_KEY_ACTIVE_SECRET:');
    expect(api).toContain('QUEUE_DATABASE_URL:');
  });
});
