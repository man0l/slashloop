import { homedir } from 'node:os';
import { join } from 'node:path';

// Default to a per-user SQLite location so the server works out of the box
// when DATABASE_URL isn't provided (e.g. `npx slashloop-mcp` / plugin installs).
// MUST be imported before db.ts, which instantiates PrismaClient at module load.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = `file:${join(homedir(), '.slashloop', 'slashloop.db')}`;
}
