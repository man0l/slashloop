/** Public ownership-verification token served at /.well-known/allagents-proof.txt. */
export const ALLAGENTS_PROOF_VALUE = 'allagents-proof=dee586ca2dd590db95d525bbea59ce7c';

export function allagentsProofResponse(): Response {
  return new Response(ALLAGENTS_PROOF_VALUE, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
