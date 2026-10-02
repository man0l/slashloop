// Guards that deploy/queue-compose.fragment.yml stays a pointer, not a
// second copy of the queue compose config (SLA-330).
//
// The file used to be a full, never-deployed duplicate of
// salonease/docker-compose.prod.yml. Because both files pointed at each
// other as "source of truth", a watchtower label was added to the mirror
// and missed in the deployed file: a merged src/queue/** fix sat
// un-deployed for 4 days while the three workers did auto-update, so the
// box looked freshly deployed.
//
// This cannot assert the deployed file's contents — that lives in the
// salonease repo, and the gate for it is SLA-332. What it can do is make
// re-growing a service definition here fail loudly instead of quietly
// producing another file that agrees with nobody.
//
// Text-scoped on purpose: no YAML parser is in package.json, and the
// assertions are about keys an editor adds, not about resolved YAML.
import { describe, expect, test } from 'bun:test';

const STUB = new URL('./queue-compose.fragment.yml', import.meta.url).pathname;
const stub = await Bun.file(STUB).text();

// The stub quotes the interpolation it forbids, so structural assertions run
// against what compose would actually parse: uncommented lines only.
const parsed = stub
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n')
  .trim();

describe('the queue compose fragment stays a stub (SLA-330)', () => {
  test('parses to nothing at all', () => {
    expect(parsed).toBe('');
  });

  for (const key of ['services:', 'networks:', 'volumes:', 'secrets:'] as const) {
    test(`declares no top-level \`${key}\``, () => {
      expect(stub).not.toMatch(new RegExp(`^${key}`, 'm'));
    });
  }

  test('has no image, build, or environment keys at all', () => {
    expect(stub).not.toMatch(/^\s*(image|build|environment|labels):/m);
  });

  test('does not interpolate env vars (prod keeps secrets in its .env)', () => {
    expect(parsed).not.toMatch(/\$\{/);
  });

  test('names the deployed file it replaced', () => {
    expect(stub).toContain('salonease');
    expect(stub).toContain('docker-compose.prod.yml');
  });

  test('tells the reader not to edit it', () => {
    expect(stub).toMatch(/do not edit/i);
  });
});