// Native Google identity → User/Workspace linking (Phase 4 auth cutover).
//
// The tokens agent calls ensureNativeUser() once per Google login and uses
// the returned `sub` as the request identity (runWithUser → requireWorkspace,
// which auto-creates the workspace on first use). Three cases:
//
//   1. Already linked (User.googleSub set by an earlier login) or natively
//      created (User.id is the native sub): return it, touch nothing.
//   2. Migrated Supabase row (same verified email, no googleSub yet): attach
//      googleSub and move that user's Workspace.ownerId values from the
//      Supabase sub to the native sub in ONE atomic step (rawBatch on
//      sqlite/D1 — the adapter has no interactive transactions; $transaction
//      on postgres), then return the new sub. Zero workspace loss, and no
//      workspace is ever created here (requireWorkspace owns that).
//   3. Nobody with this email: create the User row with the native sub and
//      return it. The workspace is auto-created later by requireWorkspace.
//
// Never touches Supabase. Email match is exact (no normalization); mixing
// two Google identities onto one email row throws instead of merging.

import { db, dbDialect, isUniqueViolation, rawBatch, type RawStatement } from '../store.js';

/** Same shape as the google agent's GoogleIdentity (src/cf/google.ts owns
 *  the canonical definition; duplicated here so this module has no
 *  cross-agent import). */
export interface GoogleIdentity {
  sub: string;
  email: string;
  emailVerified: boolean;
  name?: string;
}

/** Canonical app-level subject for a Google user. Used as Workspace.ownerId
 *  and as User.id for natively created rows. */
export function nativeSubFor(googleSub: string): string {
  return `google:${googleSub}`;
}

/** The two writes case 2 needs, as one atomic batch for the sqlite/D1 path.
 *  Exported for tests; the postgres path uses $transaction instead. */
export function buildLinkStatements(supabaseSub: string, nativeSub: string, now: Date): RawStatement[] {
  return [
    {
      sql: 'UPDATE "User" SET "googleSub" = ?, "updatedAt" = ? WHERE "id" = ?',
      params: [nativeSub, now, supabaseSub],
    },
    {
      sql: 'UPDATE "Workspace" SET "ownerId" = ?, "updatedAt" = ? WHERE "ownerId" = ?',
      params: [nativeSub, now, supabaseSub],
    },
  ];
}

export async function ensureNativeUser(google: GoogleIdentity): Promise<{ sub: string }> {
  if (!google.emailVerified) {
    throw new Error('account-link: refusing to link — Google email is not verified');
  }
  if (!google.email) {
    throw new Error('account-link: refusing to link — Google identity has no email');
  }
  const sub = nativeSubFor(google.sub);

  // Case 1: already linked or natively created.
  const byLink = await db.user.findUnique({ where: { googleSub: sub } });
  if (byLink) return { sub };
  const byId = await db.user.findUnique({ where: { id: sub } });
  if (byId) return { sub };

  // Case 2: migrated Supabase row with the same verified email.
  const byEmail = await db.user.findFirst({
    where: { email: google.email },
    orderBy: { createdAt: 'asc' },
  });
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== sub) {
      throw new Error('account-link: email is already linked to a different Google identity — refusing to merge');
    }
    if (byEmail.id !== sub) {
      const now = new Date();
      if (dbDialect() === 'sqlite') {
        await rawBatch(buildLinkStatements(byEmail.id, sub, now));
      } else {
        await db.$transaction(async (tx) => {
          await tx.user.update({ where: { id: byEmail.id }, data: { googleSub: sub } });
          await tx.workspace.updateMany({ where: { ownerId: byEmail.id }, data: { ownerId: sub } });
        });
      }
    }
    return { sub };
  }

  // Case 3: brand-new user. A concurrent first login may win the insert;
  // its unique violation means case 1 now hits — re-read and return.
  try {
    await db.user.create({ data: { id: sub, email: google.email, googleSub: sub } });
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const raced = (await db.user.findUnique({ where: { googleSub: sub } }))
      ?? (await db.user.findUnique({ where: { id: sub } }));
    if (!raced) throw err;
  }
  return { sub };
}
