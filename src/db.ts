// Re-export of the shard-aware data layer (src/store.ts).
//
// This file used to construct the Postgres PrismaClient directly. It now only
// preserves the historical contract: importing src/db.js gives you a working
// client on Node/Bun runtimes (DATABASE_URL), while Workers register the D1
// client before the first request and never touch the code below.
export { db, dbDialect, effectiveDatabaseUrl, initStorePostgres, initStoreD1Http } from './store.js';

import { dbDialect, initStorePostgres, initStoreD1Http } from './store.js';

// Runtime bootstrap, by dialect:
//   • postgres — the historical behavior: importing src/db.js yields a working
//     Postgres client (DATABASE_URL). Pre-cutover Node/Bun runtimes only.
//   • sqlite — Node/Bun talks to D1 over the HTTP API when D1_* credentials
//     are set (post-cutover VPS worker). On Workers this whole file's guard
//     is false: src/cf/worker.ts registers the binding-backed client itself.
if (dbDialect() === 'sqlite') {
  if (process.env.D1_ACCOUNT_ID && process.env.D1_DATABASE_ID && process.env.D1_API_TOKEN) {
    initStoreD1Http({
      accountId: process.env.D1_ACCOUNT_ID,
      databaseId: process.env.D1_DATABASE_ID,
      token: process.env.D1_API_TOKEN,
    });
  }
} else if (process.env.DATABASE_URL) {
  initStorePostgres();
}
