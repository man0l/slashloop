import { afterEach, describe, expect, test } from 'bun:test';
import { trafficCapBytes, workspaceCapBytes, workspaceDailyCapBytes } from './bandwidth.js';

const KEYS = ['TOOLS_WORKSPACE_ID', 'TOOLS_PROXY_CAP_GB', 'TOOLS_PROXY_DAILY_CAP_MB'] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('tools workspace proxy caps', () => {
  test('defaults: 10 GB/month and 400 MB/day for the tools workspace only', () => {
    process.env.TOOLS_WORKSPACE_ID = 'ws-tools';
    delete process.env.TOOLS_PROXY_CAP_GB;
    delete process.env.TOOLS_PROXY_DAILY_CAP_MB;
    expect(workspaceCapBytes('ws-tools')).toBe(10 * 1024 ** 3);
    expect(workspaceDailyCapBytes('ws-tools')).toBe(400 * 1024 * 1024);
    expect(workspaceCapBytes('other')).toBe(trafficCapBytes());
    expect(workspaceDailyCapBytes('other')).toBeNull();
  });

  test('env overrides, and no tools workspace configured means no override', () => {
    process.env.TOOLS_WORKSPACE_ID = 'ws-tools';
    process.env.TOOLS_PROXY_CAP_GB = '2';
    process.env.TOOLS_PROXY_DAILY_CAP_MB = '50';
    expect(workspaceCapBytes('ws-tools')).toBe(2 * 1024 ** 3);
    expect(workspaceDailyCapBytes('ws-tools')).toBe(50 * 1024 * 1024);
    delete process.env.TOOLS_WORKSPACE_ID;
    expect(workspaceCapBytes('ws-tools')).toBe(trafficCapBytes());
    expect(workspaceDailyCapBytes('ws-tools')).toBeNull();
  });
});
