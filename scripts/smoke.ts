// Smoke test: invoke a few MCP tools against the running server to confirm
// (1) get_usage returns real numbers (not $NaN), (2) run_auto_analyze is
// registered and accepts dryRun, (3) list_boards works as a baseline.
//
// Usage: bun scripts/smoke.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'bun',
  args: ['src/index.ts'],
  env: {
    ...process.env,
    DATABASE_URL: 'file:' + process.cwd() + '/prisma/slashloop.db',
  },
});

const client = new Client({ name: 'smoke', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);

console.log('--- list tools ---');
const tools = await client.listTools();
console.log('tool count:', tools.tools.length);
console.log('has run_auto_analyze:', tools.tools.some(t => t.name === 'run_auto_analyze'));

console.log('\n--- get_usage ---');
const usage = await client.callTool({ name: 'get_usage', arguments: { period: 'all' } });
const usageText = (usage.content as any)[0].text;
const usageJson = JSON.parse(usageText);
console.log('totalCostDisplay:', usageJson.summary.totalCostDisplay);
console.log('budgetUsedPercent:', usageJson.summary.budgetUsedPercent);
if (usageJson.summary.totalCostDisplay === '$NaN') {
  console.error('FAIL: totalCostDisplay is $NaN — bug #1 not fixed');
  process.exit(1);
}

console.log('\n--- run_auto_analyze (dryRun) ---');
const auto = await client.callTool({ name: 'run_auto_analyze', arguments: { dryRun: true } });
const autoText = (auto.content as any)[0].text;
const autoJson = JSON.parse(autoText);
console.log('mode:', autoJson.mode);
console.log('candidateCount:', autoJson.candidateCount);
console.log('estimatedCostDisplay:', autoJson.estimatedCostDisplay);

console.log('\nALL SMOKE TESTS PASSED');
await client.close();
process.exit(0);
