// TypeSafe System One client — Jev, a typed judgment/classifier model.
// Docs: https://docs.typesafe.ai/api.md — one endpoint, typed questions over state.
// Credentials stay server-side; TYPESAFE_API_KEY is read from the environment.

const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';

export interface JevAnswer {
  type?: string;
  /** Choice answers carry the selected option key here. */
  choice?: string;
  /** Score answers carry the weighted 0..1 value here. */
  score?: number;
  noul?: number;
  value?: string;
  confidence?: number;
  probabilities?: Record<string, number>;
}
export type JevQuestion = { type: 'choice' | 'score' | 'noul'; instructions: string; criteria?: unknown };

/**
 * Ask Jev one or more typed questions over the given state in a single call
 * (the speculative fan-out pattern: many questions, code decides what matters).
 */
export async function jevAsk(state: unknown, questions: Record<string, JevQuestion>): Promise<Record<string, JevAnswer>> {
  const key = process.env.TYPESAFE_API_KEY;
  if (!key) throw new Error('TYPESAFE_API_KEY not set');
  const res = await fetch(TYPESAFE_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ state, model: 'jev-latest', questions }),
  });
  if (!res.ok) throw new Error(`typesafe_${res.status}`);
  const data = await res.json() as { answers?: Record<string, JevAnswer> };
  if (!data.answers) throw new Error('typesafe_empty_answer');
  return data.answers;
}

/** Single Choice question convenience wrapper (slide fan-out selection). */
export async function jevPick(state: unknown, instructions: string, criteria: Record<string, string>): Promise<JevAnswer> {
  const answers = await jevAsk(state, { winner: { type: 'choice', instructions, criteria } });
  const answer = answers.winner;
  if (!answer?.choice && !answer?.value) throw new Error('typesafe_empty_answer');
  return answer;
}
