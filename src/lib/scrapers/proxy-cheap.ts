// ---------------------------------------------------------------------------
// Proxy-Cheap account traffic. Their docs have no /usage route — billed GB
// lives on GET /proxies and GET /proxies/:id as bandwidth.{total,used}.
// ---------------------------------------------------------------------------

const API_BASE = 'https://api.proxy-cheap.com';

export interface ProxyCheapBandwidth {
  proxyId: number;
  totalGb: number;
  usedGb: number | null;
  remainingGb: number | null;
  status: string;
  networkType: string;
}

function authHeaders(): { key: string; secret: string } | null {
  const key = process.env.PROXY_CHEAP_API_KEY?.trim();
  const secret = process.env.PROXY_CHEAP_API_SECRET?.trim();
  if (!key || !secret) return null;
  return { key, secret };
}

async function pcGet<T>(path: string): Promise<T> {
  const auth = authHeaders();
  if (!auth) throw new Error('PROXY_CHEAP_API_KEY / PROXY_CHEAP_API_SECRET are not set');
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      Accept: 'application/json',
      'X-Api-Key': auth.key,
      'X-Api-Secret': auth.secret,
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Proxy-Cheap ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export function bandwidthFromProxyRecord(p: any): ProxyCheapBandwidth {
  const total = Number(p?.bandwidth?.total);
  const usedRaw = p?.bandwidth?.used;
  const used = usedRaw == null || usedRaw === '' ? null : Number(usedRaw);
  return {
    proxyId: Number(p.id),
    totalGb: Number.isFinite(total) ? total : 0,
    usedGb: used != null && Number.isFinite(used) ? used : null,
    remainingGb: used != null && Number.isFinite(used) && Number.isFinite(total)
      ? Math.max(0, total - used)
      : null,
    status: String(p?.status ?? ''),
    networkType: String(p?.networkType ?? ''),
  };
}

/** Pull the active (or first) proxy out of a GET /proxies payload. */
export function parseProxiesResponse(body: unknown): ProxyCheapBandwidth | null {
  const list = Array.isArray(body)
    ? body
    : Array.isArray((body as { proxies?: unknown })?.proxies)
      ? (body as { proxies: unknown[] }).proxies
      : [];
  const active = list.find((p: any) => p?.status === 'ACTIVE') ?? list[0];
  return active ? bandwidthFromProxyRecord(active) : null;
}

/** Snapshot billed traffic. Returns null when the API is not configured. */
export async function proxyCheapBandwidth(): Promise<ProxyCheapBandwidth | null> {
  if (!authHeaders()) return null;
  const body = await pcGet<{ proxies?: any[] } | any[]>('/proxies');
  return parseProxiesResponse(body);
}

export function formatProxyCheap(b: ProxyCheapBandwidth | null): string {
  if (!b) return 'proxy-cheap: (not configured)';
  const used = b.usedGb == null ? 'unreported' : `${b.usedGb}GB`;
  const remain = b.remainingGb == null ? '?' : `${b.remainingGb}GB`;
  return `proxy-cheap #${b.proxyId}: ${used} / ${b.totalGb}GB used (${remain} left)`;
}
