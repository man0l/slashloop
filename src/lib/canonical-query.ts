// ---------------------------------------------------------------------------
// Canonical query keys — de-dupe the same TikTok target across workspaces.
//
// Phase A batching (api/jobs/analyze.ts) groups refresh jobs by this key so
// ten tenants tracking @foo pay for one Apify run, not ten.
// Must match create_source / suggestion dismissal normalization so the same
// handle never appears as two keys.
// ---------------------------------------------------------------------------

export type SourceType = 'creator' | 'keyword' | 'hashtag';

/** Strip leading @/# and lower-case for stable equality. */
export function normalizeQuery(sourceType: string, query: string): string {
  const q = query.trim();
  if (sourceType === 'creator') return q.replace(/^@+/, '').toLowerCase();
  if (sourceType === 'hashtag') return q.replace(/^#+/, '').toLowerCase();
  return q.toLowerCase();
}

/** Stable id for (platform, type, query) used as a batch group key. */
export function canonicalKey(platform: string, sourceType: string, query: string): string {
  return `${platform.toLowerCase()}|${sourceType}|${normalizeQuery(sourceType, query)}`;
}
