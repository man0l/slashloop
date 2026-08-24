// GET /api/cron/digest — weekly outlier digest, per workspace.
//
// For every workspace that is digest-enabled, has an owner with a resolvable
// email, and is due (never digested or ≥7 days since the last one):
//   1. buildDigest() computes the payload (watermark = lastDigestAt).
//   2. The payload persists on the workspace BEFORE sending — get_digest can
//      serve it even if the email send fails.
//   3. sendEmail() delivers via Resend; failures are recorded, never thrown —
//      one bad workspace must not skip the rest of the sweep.
//
// Guarded by CRON_SECRET. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
// automatically when that env var is set on the project.

import { db } from '../../src/db.js';
import { buildDigest, digestSubject, renderDigestText, renderDigestHtml, ownerEmail } from '../../src/lib/digest.js';
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
    select: { id: true, ownerId: true, createdAt: true, lastDigestAt: true, planCredits: true, packCredits: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_WORKSPACES_PER_RUN,
  });

  const results: Array<{ workspaceId: string; emailed: boolean; detail?: string }> = [];
  // One log line per workspace so runs are debuggable from `vercel logs`
  // alone — the HTTP response only reaches whoever fired the request.
  const record = (r: { workspaceId: string; emailed: boolean; detail?: string }) => {
    console.log(`[digest] ${JSON.stringify(r)}`);
    results.push(r);
  };

  for (const ws of due) {
    try {
      const creditsRemaining = ws.planCredits + ws.packCredits;
      const payload = await buildDigest(ws, creditsRemaining);

      // Persist before sending so get_digest always has the latest payload
      // even when delivery fails.
      await db.workspace.update({
        where: { id: ws.id },
        data: { lastDigestAt: new Date(payload.generatedAt), digestJson: JSON.stringify(payload) },
      });

      if (payload.newOutliersCount === 0 && payload.ideas.overdue === 0) {
        record({ workspaceId: ws.id, emailed: false, detail: 'nothing to report — payload stored' });
        continue;
      }

      const email = await ownerEmail(ws.ownerId!);
      if (!email) {
        record({ workspaceId: ws.id, emailed: false, detail: 'no owner email resolved — payload stored' });
        continue;
      }

      const sent = await sendEmail({
        to: email,
        subject: digestSubject(payload),
        html: renderDigestHtml(payload),
        text: renderDigestText(payload),
      });
      record({ workspaceId: ws.id, emailed: sent.sent, ...(sent.sent ? { emailId: sent.id } : { detail: sent.reason }) });
    } catch (err) {
      record({ workspaceId: ws.id, emailed: false, detail: (err as Error).message.slice(0, 200) });
    }
  }

  console.log(`[digest] run: ${JSON.stringify({
    due: due.length,
    processed: results.length,
    emailed: results.filter(r => r.emailed).length,
  })}`);

  return json(200, {
    dueWorkspaces: due.length,
    processed: results.length,
    emailed: results.filter(r => r.emailed).length,
    results,
  });
}
