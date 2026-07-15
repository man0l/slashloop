// Smoke test 2: spend-cap + discovery sources
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'bun',
  args: ['src/index.ts'],
  env: {
    ...process.env,
    DATABASE_URL: 'file:' + process.cwd() + '/prisma/slashloop.db',
    APIFY_API_KEY: process.env.APIFY_API_KEY || 'test-key',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'test-key',
    APIFY_SPEND_CAP_CENTS: '500',
  },
});

const client = new Client({ name: 'smoke2', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);

console.log('--- list tools ---');
const tools = await client.listTools();
console.log('tool count:', tools.tools.length);
console.log('has get_apify_spend_status:', tools.tools.some(t => t.name === 'get_apify_spend_status'));

console.log('\n--- get_apify_spend_status ---');
const status = await client.callTool({ name: 'get_apify_spend_status', arguments: {} });
const statusText = (status.content as any)[0].text;
const statusJson = JSON.parse(statusText);
console.log('cap:', statusJson.status.capDisplay);
console.log('currentSpend:', statusJson.status.currentSpendDisplay);
console.log('remaining:', statusJson.status.remainingDisplay);
console.log('breached:', statusJson.status.breached);
console.log('message:', statusJson.message);

if (statusJson.status.capCents !== 500) {
  console.error('FAIL: expected cap of 500 cents ($5)');
  process.exit(1);
}

console.log('\n--- list_sources filtered by nicheTag=looksmaxxing ---');
const sources = await client.callTool({
  name: 'list_sources',
  arguments: { nicheTag: 'looksmaxxing' },
});
const sourcesText = (sources.content as any)[0].text;
const sourcesJson = JSON.parse(sourcesText);
console.log('looksmaxxing source count:', sourcesJson.length);
console.log('first 3:');
for (const s of sourcesJson.slice(0, 3)) {
  console.log(`  ${s.platform}/${s.sourceType} "${s.query}" (id: ${s.id.slice(0, 8)}...)`);
}

if (sourcesJson.length !== 14) {
  console.error(`FAIL: expected 14 seeded sources, got ${sourcesJson.length}`);
  process.exit(1);
}

console.log('\nALL SMOKE TESTS PASSED');
await client.close();
process.exit(0);
