/** Public ownership-verification token served at /.well-known/mcpi-verify. */
export const MCPI_VERIFY_VALUE = 'mcpi-verify=b82b69a578966ed338de8c48288fbd51';

export function mcpiVerifyResponse(): Response {
  return new Response(MCPI_VERIFY_VALUE, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
