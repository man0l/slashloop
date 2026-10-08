import { expect, test } from 'bun:test';
import { registerSettingsTools } from './settings.js';

test('get_apify_spend_status stays registered next to get_scraper_spend_status, with the same handler', () => {
  const tools = new Map<string, { description: string; handler: unknown }>();
  const server = {
    tool: (name: string, description: string, _schema: unknown, handler: unknown) => {
      tools.set(name, { description, handler });
    },
  };
  registerSettingsTools(server as any);

  const neutral = tools.get('get_scraper_spend_status');
  const legacy = tools.get('get_apify_spend_status');
  expect(neutral).toBeDefined();
  expect(legacy).toBeDefined();
  expect(legacy!.handler).toBe(neutral!.handler);
  expect(legacy!.description).toContain('legacy name');
});
