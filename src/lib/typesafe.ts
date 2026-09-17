// TypeSafe System One client — Jev, a typed judgment/classifier model.
// Docs: https://docs.typesafe.ai/api.md — one endpoint, typed questions over state.
// Credentials stay server-side; TYPESAFE_API_KEY is read from the environment.

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface JevAnswer { value: string; confidence?: number; probabilities?: Record<string, number>; }

/**
 * Ask Jev a single Choice question over the given state and return the winning
 * option key with its probability distribution. Throws on any failure — callers
 * decide the fallback (judgment failures must never lose paid work).
 */
export async function jevPick(state: unknown, instructions: string, criteria: Record<string, string>): Promise<JevAnswer> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY not set');
  const res = await fetch(TYPESAFE_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ state, model: 'jev-latest', questions: { winner: { type: 'choice', instructions, criteria } } }),
  });
  if (!res.ok) throw new Error(`typesafe_${res.status}`);
  const data = await res.json() as { answers?: Record<string, { value?: string; confidence?: number; probabilities?: Record<string, number> }> };
  const answer = data.answers?.winner;
  if (!answer?.value) throw new Error('typesafe_empty_answer');
  return { value: answer.value, confidence: answer.confidence, probabilities: answer.probabilities };
}
