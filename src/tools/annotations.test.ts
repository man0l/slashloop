import { describe, expect, test } from 'bun:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { buildRemoteMcp } from '../../remote/mcp-server.js';
import { TOOL_ANNOTATION_ROWS } from './annotations.js';

async function listedTools() {
  const server = buildRemoteMcp({ sub: 'annotations-test' });
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return (await client.listTools()).tools;
}

describe('MCP tool annotations', () => {
  test('every listed tool declares title, readOnlyHint and destructiveHint (plus idempotent/openWorld)', async () => {
    const tools = await listedTools();
    expect(tools.length).toBeGreaterThan(0);
    const problems: string[] = [];
    for (const t of tools) {
      const a = t.annotations;
      if (!a?.title?.trim()) problems.push(`${t.name}: missing title`);
      if (typeof a?.readOnlyHint !== 'boolean') problems.push(`${t.name}: missing readOnlyHint`);
      if (typeof a?.destructiveHint !== 'boolean') problems.push(`${t.name}: missing destructiveHint`);
      if (typeof a?.idempotentHint !== 'boolean') problems.push(`${t.name}: missing idempotentHint`);
      if (typeof a?.openWorldHint !== 'boolean') problems.push(`${t.name}: missing openWorldHint`);
      if (a?.readOnlyHint === true && a?.destructiveHint === true) problems.push(`${t.name}: read-only tool marked destructive`);
    }
    expect(problems).toEqual([]);
  });

  test('titles are unique', async () => {
    const titles = (await listedTools()).map(t => t.annotations?.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  test('the table has no rows for tools that are not registered', async () => {
    const names = new Set((await listedTools()).map(t => t.name));
    expect(Object.keys(TOOL_ANNOTATION_ROWS).filter(n => !names.has(n))).toEqual([]);
  });

  test('deleting tools are destructive, listing tools are read-only', async () => {
    const byName = new Map((await listedTools()).map(t => [t.name, t.annotations]));
    for (const n of ['delete_source', 'delete_experiment', 'delete_social_post', 'cancel_experiment']) {
      expect(byName.get(n)?.destructiveHint).toBe(true);
    }
    for (const n of byName.keys()) {
      if (n.startsWith('list_')) expect(byName.get(n)?.readOnlyHint).toBe(true);
    }
  });
});
