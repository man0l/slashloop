const HANDLE_RE = /^[a-z0-9._]{2,24}$/;

/** "@Name", "tiktok.com/@name", "https://www.tiktok.com/@name?lang=en" -> "name"; null when not a valid handle. */
export function normalizeHandle(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  let s = input.trim().toLowerCase();
  if (!s || s.length > 200) return null;
  const url = s.match(/^(?:https?:\/\/)?(?:www\.|m\.)?tiktok\.com\/@([^/?#\s]+)/);
  if (url) s = url[1];
  else if (s.includes('/') || s.includes('?') || s.includes('#')) return null;
  s = s.replace(/^@/, '');
  return HANDLE_RE.test(s) ? s : null;
}
