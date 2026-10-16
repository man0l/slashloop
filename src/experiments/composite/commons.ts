// SLA-868: Wikimedia Commons lookup for the face library. Only licences that let
// a derived social image carry the photo are accepted: CC0, public domain, and
// CC-BY (which obliges the on-slide credit line plan.ts draws). Share-alike,
// non-commercial and no-derivatives files are refused, as is anything unclear.
import { CompositeError } from './plan.js';

export type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface CommonsFile { title: string; imageUrl: string; pageUrl: string; licence: string; attribution: string }

const API = 'https://commons.wikimedia.org/w/api.php';
const TITLE = /^File:[^|<>#{}[\]]{1,240}$/;

/** "CC BY 4.0" -> "CC-BY-4.0"; null when the licence is not usable for a derived image. */
export function normaliseLicence(short: string | null | undefined): string | null {
  const s = (short ?? '').trim();
  if (!s) return null;
  if (/\b(sa|nc|nd)\b/i.test(s.replace(/^cc[ -]?by/i, ' ')) || /share ?alike|non ?commercial|no ?deriv|fair use|gfdl|copyrighted/i.test(s)) return null;
  if (/^cc0\b|cc[ -]?zero/i.test(s)) return 'CC0';
  if (/^(public domain|pd\b|pd-)/i.test(s)) return 'PD';
  const by = /^cc[ -]?by[ -]?(\d(?:\.\d)?)$/i.exec(s);
  return by ? `CC-BY-${by[1]}` : null;
}

const stripHtml = (v: unknown) => String(v ?? '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

export async function fetchCommonsFile(fetchFn: FetchLike, title: string, userAgent = 'slashloop-face-library/1.0'): Promise<CommonsFile> {
  const t = title.startsWith('File:') ? title : `File:${title}`;
  if (!TITLE.test(t)) throw new CompositeError('bad_commons_title', 'Not a Commons file title.');
  const url = `${API}?${new URLSearchParams({ action: 'query', titles: t, prop: 'imageinfo', iiprop: 'url|extmetadata|mime', iiurlwidth: '1200', format: 'json', formatversion: '2' })}`;
  const res = await fetchFn(url, { headers: { 'User-Agent': userAgent } });
  if (!res.ok) throw new CompositeError('commons_unavailable', `Commons answered ${res.status}.`);
  const page = ((await res.json()) as { query?: { pages?: Array<{ missing?: boolean; imageinfo?: Array<Record<string, any>> }> } }).query?.pages?.[0];
  const info = page?.imageinfo?.[0];
  if (!page || page.missing || !info) throw new CompositeError('commons_file_not_found', `${t} was not found on Commons.`);
  if (!/^image\/(jpeg|png|webp)$/.test(String(info.mime))) throw new CompositeError('commons_not_a_photo', `${t} is not a JPEG, PNG or WebP photo.`);
  const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown }>;
  const licence = normaliseLicence(stripHtml(meta.LicenseShortName?.value));
  if (!licence) throw new CompositeError('commons_licence_unusable', `${t} is not CC0, public domain or CC-BY.`);
  const imageUrl = String(info.thumburl ?? info.url ?? '');
  if (!imageUrl.startsWith('https://upload.wikimedia.org/')) throw new CompositeError('commons_bad_image_url', 'Unexpected image host.');
  return {
    title: t, imageUrl, pageUrl: String(info.descriptionurl ?? ''), licence,
    attribution: stripHtml(meta.Artist?.value).slice(0, 120) || t.replace(/^File:/, ''),
  };
}
