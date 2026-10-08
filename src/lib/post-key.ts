/** Identity of a post across tracked sources: the same post is stored once per source. */
export const postKey = (v: { platform: string; externalId: string }): string => `${v.platform}|${v.externalId}`;

/** First row per post, keeping the input order (so a score-sorted list keeps its best row). */
export function firstPerPost<T>(rows: T[], video: (row: T) => { platform: string; externalId: string }): T[] {
  const seen = new Set<string>();
  return rows.filter(r => {
    const k = postKey(video(r));
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
