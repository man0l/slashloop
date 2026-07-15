#!/usr/bin/env bun
// ---------------------------------------------------------------------------
// Seed discovery sources for the looksmaxxing / glow-up niche.
//
// Keywords/hashtags provided by the user for discovery testing:
//   looksmax, mewing, mog, skincare, jawline, glow up, canthal tilt
//
// Creates TikTok keyword + hashtag sources tagged nicheTag='looksmaxxing'
// so the user can immediately call refresh_source on any of them to test
// the live Apify scraper against the $5 cap.
//
// Idempotent: re-running will skip sources that already exist with the same
// platform + sourceType + query.
//
// Usage:
//   DATABASE_URL="file:$PWD/prisma/slashloop.db" bun src/scripts/seed_discovery.ts
// ---------------------------------------------------------------------------

import { db } from '../db.js';

const NICHE_TAG = 'looksmaxxing';

// User-supplied discovery keywords/hashtags
const DISCOVERY_TERMS = [
  'looksmax',
  'mewing',
  'mog',
  'skincare',
  'jawline',
  'glow up',
  'canthal tilt',
];

async function main() {
  console.log('[seed-discovery] starting');

  // Ensure a workspace exists
  let workspace = await db.workspace.findFirst();
  if (!workspace) {
    workspace = await db.workspace.create({ data: { name: 'Default' } });
    console.log(`[seed-discovery] created workspace ${workspace.id}`);
  }

  let created = 0;
  let skipped = 0;

  for (const term of DISCOVERY_TERMS) {
    // Create both a keyword source and a hashtag source on TikTok
    for (const sourceType of ['keyword', 'hashtag'] as const) {
      const query = sourceType === 'hashtag' ? `#${term.replace(/\s+/g, '')}` : term;

      const existing = await db.source.findFirst({
        where: { platform: 'tiktok', sourceType, query },
      });
      if (existing) {
        skipped++;
        continue;
      }

      const source = await db.source.create({
        data: {
          workspaceId: workspace.id,
          platform: 'tiktok',
          sourceType,
          query,
          language: 'en',
          videoLimit: 30,
          refreshSchedule: 'manual',
          isActive: true,
          nicheTag: NICHE_TAG,
        },
      });
      created++;
      console.log(`[seed-discovery] created ${sourceType} "${query}" -> ${source.id}`);
    }
  }

  // Summary
  const sources = await db.source.findMany({
    where: { nicheTag: NICHE_TAG },
    select: { id: true, platform: true, sourceType: true, query: true, videoLimit: true },
  });

  console.log('');
  console.log(`[seed-discovery] done. created=${created} skipped=${skipped}`);
  console.log(`[seed-discovery] ${sources.length} active sources in "${NICHE_TAG}" niche:`);
  for (const s of sources) {
    console.log(`  ${s.id}  tiktok/${s.sourceType.padEnd(8)}  ${s.query}`);
  }
  console.log('');
  console.log('Next step: call refresh_source on any of the above IDs to test the live Apify scraper.');
  console.log('Use get_apify_spend_status before/after to monitor the $5 testing cap.');

  await db.$disconnect();
}

main().catch((err) => {
  console.error('[seed-discovery] fatal:', err);
  process.exit(1);
});
