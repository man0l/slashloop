// ---------------------------------------------------------------------------
// Transactional email — Resend over plain fetch.
//
// The weekly digest is the only sender today. Kept dependency-free on
// purpose: one POST, no SDK, no queue — if RESEND_API_KEY is unset the
// caller gets { sent: false } and the digest still persists (get_digest
// serves it); email is a delivery upgrade, never a hard path.
// ---------------------------------------------------------------------------

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendEmailResult {
  sent: boolean;
  id?: string;
  /** Set when sent=false — 'not_configured' or the provider's error. */
  reason?: string;
}

/** Sender identity. DIGEST_FROM_EMAIL must be a verified Resend domain. */
function fromAddress(): string {
  return process.env.DIGEST_FROM_EMAIL ?? 'Slashloop <digest@slashloop.dev>';
}

export function emailConfigured(): boolean {
  return !!process.env.RESEND_API_KEY;
}

/**
 * Send via Resend's REST API. Never throws — a mail outage must not fail the
 * cron run for other workspaces, so callers get a result object instead.
 */
export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { sent: false, reason: 'not_configured' };

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: fromAddress(),
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return { sent: false, reason: `resend_${res.status}: ${body.slice(0, 200)}` };
    }

    const data = (await res.json()) as { id?: string };
    return { sent: true, id: data.id };
  } catch (err) {
    return { sent: false, reason: (err as Error).message.slice(0, 200) };
  }
}
