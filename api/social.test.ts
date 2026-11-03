import { describe, expect, test } from 'bun:test';
import { canDisconnect } from './social.js';

// SLA-1256: the workspace owner sees teammates' accounts, so a stale
// duplicate a teammate left behind must be disconnectable from there.
describe('social DELETE canDisconnect', () => {
  const managed = async (userId: string) => (userId === 'owner' ? ['teammate'] : []);

  test('the connector can disconnect their own account', async () => {
    expect(await canDisconnect('me', 'me', managed)).toBe(true);
  });

  test("the workspace owner can disconnect a teammate's account", async () => {
    expect(await canDisconnect('teammate', 'owner', managed)).toBe(true);
  });

  test("a member cannot disconnect the owner's or a stranger's account", async () => {
    expect(await canDisconnect('owner', 'teammate', managed)).toBe(false);
    expect(await canDisconnect('stranger', 'owner', managed)).toBe(false);
  });
});
