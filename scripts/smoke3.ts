// Smoke test 3: verify gemini-text fallback is the default and works without GLM_API_KEY
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Intentionally do NOT set GLM_API_KEY — the default pipeline must work
// without it now that fallback is gemini-text.
const transport = new StdioClientTransport({
  command: 'bun',
  args: ['src/index.ts'],
  env: {
    ...process.env,
    DATABASE_URL: 'file:' + process.cwd() + '/prisma/slashloop.db',
    GEMINI_API_KEY: process.env.GEMINI_API_KEY || 'fake-key-for-smoke-test',
    APIFY_API_KEY: process.env.APIFY_API_KEY || 'fake-key',
    // GLM_API_KEY deliberately omitted
    APIFY_SPEND_CAP_CENTS: '500',
  },
});

const client = new Client({ name: 'smoke3', version: '0.0.0' }, { capabilities: {} });
await client.connect(transport);

console.log('--- get_settings (verify default fallback is gemini-text) ---');
const settings = await client.callTool({ name: 'get_settings', arguments: {} });
const settingsJson = JSON.parse((settings.content as any)[0].text);
console.log('analysisConfig:', settingsJson.analysisConfig);

if (settingsJson.analysisConfig.backend !== 'gemini-native') {
  console.error('FAIL: expected backend=gemini-native, got', settingsJson.analysisConfig.backend);
  process.exit(1);
}
if (settingsJson.analysisConfig.fallback !== 'gemini-text') {
  console.error('FAIL: expected fallback=gemini-text, got', settingsJson.analysisConfig.fallback);
  process.exit(1);
}

console.log('\n--- batch cost estimates (gemini-text should be present) ---');
console.log('gemini-text batch costs:', settingsJson.batchCostEstimates['gemini-text']);

if (!settingsJson.batchCostEstimates['gemini-text']) {
  console.error('FAIL: gemini-text missing from batchCostEstimates');
  process.exit(1);
}

console.log('\n--- analyze_video tool definition (forceBackend should accept gemini-text) ---');
const tools = await client.listTools();
const analyzeVideo = tools.tools.find(t => t.name === 'analyze_video');
const forceBackendSchema = analyzeVideo?.inputSchema?.properties?.forceBackend;
console.log('forceBackend enum:', forceBackendSchema?.enum);

if (!forceBackendSchema?.enum?.includes('gemini-text')) {
  console.error('FAIL: analyze_video.forceBackend does not accept gemini-text');
  process.exit(1);
}

console.log('\n--- update_settings tool definition (analysisBackend should accept gemini-text) ---');
const updateSettings = tools.tools.find(t => t.name === 'update_settings');
const analysisBackendSchema = updateSettings?.inputSchema?.properties?.analysisBackend;
console.log('analysisBackend enum:', analysisBackendSchema?.enum);

if (!analysisBackendSchema?.enum?.includes('gemini-text')) {
  console.error('FAIL: update_settings.analysisBackend does not accept gemini-text');
  process.exit(1);
}

console.log('\n--- server started WITHOUT GLM_API_KEY and all checks passed ---');
console.log('ALL SMOKE TESTS PASSED');
await client.close();
process.exit(0);
