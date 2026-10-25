import { buildGeo } from "../calc/geo";

export function handleGeo(request: Request): Response {
  const geo = buildGeo(request.headers.get("cf-connecting-ip"), (request as { cf?: Record<string, unknown> }).cf);
  return new Response(JSON.stringify(geo), {
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
