// Derives prisma/schema.sqlite.prisma from prisma/schema.prisma.
//
// prisma/schema.prisma stays the single source of truth for the models. The
// D1/Worker runtime needs the same models with provider "sqlite" (Prisma bakes
// the provider into the generated client, so the Postgres and SQLite clients
// must be generated separately and coexist). Run this whenever the canonical
// schema changes, then regenerate both clients:
//
//   bun src/scripts/sync-sqlite-schema.ts
//   bun run db:generate
//
// Everything below the datasource/generator blocks is copied verbatim — the
// models are already SQLite-compatible (no Prisma enums, no Json fields, no
// scalar lists; UUIDs are client-generated; see prisma/schema.prisma).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', '..');
const src = readFileSync(join(root, 'prisma', 'schema.prisma'), 'utf8');

const generatorAndDatasource = /generator client \{[\s\S]*?\n\}\n\ndatasource db \{[\s\S]*?\n\}\n/;

const replacement = `// GENERATED from prisma/schema.prisma by src/scripts/sync-sqlite-schema.ts — do not edit.
// Edit the canonical schema, then re-run the script (see header there).
generator client {
  provider = "prisma-client-js"
  output   = "../src/generated/sqlite"
}

datasource db {
  provider = "sqlite"
  url      = env("SQLITE_DB_URL")
}
`;

if (!generatorAndDatasource.test(src)) {
  throw new Error('generator/datasource blocks not found in prisma/schema.prisma — adjust the regex');
}

const out = src.replace(generatorAndDatasource, replacement);
writeFileSync(join(root, 'prisma', 'schema.sqlite.prisma'), out);
console.log('wrote prisma/schema.sqlite.prisma');
