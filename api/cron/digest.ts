// GET /api/cron/digest — weekly outlier digest.
//
// For every workspace that is digest-enabled, has an owner with a resolvable
// email, and is due (never digested or ≥7 days since the last one):
//   1. buildDigest() computes the payload (watermark = lastDigestAt).
//   2. The payload persists on the workspace BEFORE sending — get_digest can
//      serve it even if the email fails.
//   3. Payloads are grouped by RECIPIENT (Workspace.digestEmail override,
//      else the owner's auth email): an owner with several workspaces gets
//      ONE combined email, not one per workspace.
//   4. sendEmail() delivers via Resend; failures are recorded, never thrown —
//      one bad recipient must not skip the rest of the sweep.
//
// Guarded by CRON_SECRET. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
// automatically when that env var is set on the project.

import { db } from '../../src/db.js';
import {
  buildDigest, digestSubject, renderDigestText, renderDigestHtml, ownerEmail,
  type DigestPayload, type DigestSection,
} from '../../src/lib/digest.js';
import { sendEmail } from '../../src/lib/email.js';

const DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
/** Cap per run — a large backlog drains over consecutive weekly runs. */
const MAX_WORKSPACES_PER_RUN = 200;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Named GET (not export default) — Vercel only hands Web-Request objects to
// method-named exports; a default export receives Node-style (req, res).
export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(500, { error: 'CRON_SECRET is not configured' });

  const auth = request.headers.get('authorization') ?? '';
  if (auth !== `Bearer ${secret}`) return json(401, { error: 'unauthorized' });

  const due = await db.workspace.findMany({
    where: {
      digestEnabled: true,
      ownerId: { not: null },
      OR: [
        { lastDigestAt: null },
        { lastDigestAt: { lte: new Date(Date.now() - DIGEST_INTERVAL_MS) } },
      ],
      // Never email an empty workspace — nothing to say yet.
      sources: { some: {} },
    },
    select: {
      id: true, ownerId: true, name: true, digestEmail: true,
      createdAt: true, lastDigestAt: true, planCredits: true, packCredits: true,
    },
    orderBy: { createdAt: 'asc' },
    take: MAX_WORKSPACES_PER_RUN,
  });

  const results: Array<{ email: string; emailed: boolean; workspaces: string[]; detail?: string }> = [];
  const record = (r: (typeof results)[number]) => {
    console.log(`[digest] ${JSON.stringify(r)}`);
    results.push(r);
  };

  // Build + persist every due workspace's payload first (get_digest serves
  // the stored copy even when delivery fails), then group by RECIPIENT — an
  // owner with several workspaces gets one combined email, not N.
  type Built = { name: string; payload: DigestPayload };
  const byRecipient = new Map<string, Built[]>();

  // Thumb captures are bounded per run (oEmbed fetch + image fetch + upload
  // per video) so a large first run can't crowd the 60s function budget.
  const backfillBudget = { remaining: 15 };

  for (const ws of due) {
    try {
      const payload = await buildDigest(ws, ws.planCredits + ws.packCredits, backfillBudget);
      await db.workspace.update({
        where: { id: ws.id },
        data: { lastDigestAt: new Date(payload.generatedAt), digestJson: JSON.stringify(payload) },
      });

      // Explicit per-workspace override wins; else the owner's auth email.
      const email = ws.digestEmail ?? await ownerEmail(ws.ownerId!);
      if (!email) {
        record({ email: '(unresolvable)', emailed: false, workspaces: [ws.name], detail: 'no owner email resolved — payload stored' });
        continue;
      }
      const bucket = byRecipient.get(email) ?? [];
      bucket.push({ name: ws.name, payload });
      byRecipient.set(email, bucket);
    } catch (err) {
      record({ email: '(error)', emailed: false, workspaces: [ws.name], detail: (err as Error).message.slice(0, 200) });
    }
  }

  for (const [email, built] of byRecipient) {
    try {
      // Quiet workspaces stay out of the email entirely — but their payload
      // was persisted above, so get_digest still serves them.
      const sections: DigestSection[] = built.filter(
        b => b.payload.newOutliersCount > 0 || b.payload.ideas.overdue > 0,
      );
      if (sections.length === 0) {
        record({ email, emailed: false, workspaces: built.map(b => b.name), detail: 'nothing to report — payloads stored' });
        continue;
      }

      const sent = await sendEmail({
        to: email,
        subject: digestSubject(sections),
        html: renderDigestHtml(sections),
        text: renderDigestText(sections),
      });
      record({
        email,
        emailed: sent.sent,
        workspaces: sections.map(s => s.name),
        ...(sent.sent ? { detail: `resend:${sent.id ?? 'ok'}` } : { detail: sent.reason }),
      });
    } catch (err) {
      record({ email, emailed: false, workspaces: built.map(b => b.name), detail: (err as Error).message.slice(0, 200) });
    }
  }

  console.log(`[digest] run: ${JSON.stringify({
    dueWorkspaces: due.length,
    recipients: byRecipient.size,
    emailed: results.filter(r => r.emailed).length,
  })}`);

  return json(200, {
    dueWorkspaces: due.length,
    recipients: byRecipient.size,
    emailed: results.filter(r => r.emailed).length,
    results,
  });
}
