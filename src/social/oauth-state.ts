// Stateless OAuth state parameter: HMAC-signed {sub, exp, nonce} so the
// callback needs no server-side session store (no Redis, no KV table). The
// signing key is injected by the api layer — the library never reads env.

const TIL_5_MINUTES = 10 * 60; // seconds the state stays valid

function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const encoder = new TextEncoder();

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export interface OAuthStatePayload {
  /** Supabase JWT `sub` of the user that started the connect. */
  sub: string;
  /** Epoch seconds after which the state is rejected. */
  exp: number;
  /** Random value so identical connects never share a state string. */
  nonce: string;
}

export async function signOAuthState(secret: string, sub: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<string> {
  const payload: OAuthStatePayload = { sub, exp: nowSeconds + TIL_5_MINUTES, nonce: crypto.randomUUID() };
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(body));
  return `${body}.${b64urlEncode(new Uint8Array(signature))}`;
}

export async function verifyOAuthState(secret: string, state: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<OAuthStatePayload | null> {
  const [body, signature] = state.split('.');
  if (!body || !signature) return null;

  const valid = await crypto.subtle
    .verify('HMAC', await hmacKey(secret), b64urlDecode(signature) as unknown as ArrayBuffer, encoder.encode(body))
    .catch(() => false);
  if (!valid) return null;

  try {
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as OAuthStatePayload;
    if (!payload?.sub || typeof payload.exp !== 'number') return null;
    if (payload.exp < nowSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}
