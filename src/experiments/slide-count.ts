const CTA_TEXT = /\b(follow\s*(for|me|now)?|like\s*(and|&)\s*follow|subscribe|comment\s*(below|your|if)|share\s*this|save\s*this|swipe\s*up|link\s*in\s*(my\s+)?bio|tap\s*(the|here|now)|shop\s*now|click\s*(the|here|link)|dm\s*me|follow\s*for\s*more|turn\s*on\s*(the\s+)?noti)/i;

export function overlayLooksLikeCta(text: string | null | undefined): boolean {
  return CTA_TEXT.test((text ?? '').trim());
}

type LooseAnalysis = {
  shots?: Array<{ timestampSec?: number; description?: string; onScreenText?: string | null }>;
  onScreenText?: Array<{ timestampSec?: number; text?: string }>;
  storytellingBeats?: Array<{ type?: string; timestampSec?: number }>;
  keyMoments?: Array<{ role?: string; timestampSec?: number }>;
};

/** True when the last original slide is a call-to-action, not story. */
export function analysisHasCtaSlide(raw: unknown, originalCount: number): boolean {
  if (originalCount < 2) return false;
  const lastIdx = originalCount - 1;
  const d = (raw && typeof raw === 'object' ? raw : {}) as LooseAnalysis;
  const lastShot = (d.shots ?? []).find(s => s.timestampSec === lastIdx) ?? d.shots?.[lastIdx];
  if (overlayLooksLikeCta(lastShot?.onScreenText) || overlayLooksLikeCta(lastShot?.description)) return true;
  const lastOverlay = (d.onScreenText ?? []).find(s => s.timestampSec === lastIdx);
  if (overlayLooksLikeCta(lastOverlay?.text)) return true;
  if ((d.storytellingBeats ?? []).some(b => b.type === 'cta' && Math.round(b.timestampSec ?? -1) === lastIdx)) return true;
  if ((d.keyMoments ?? []).some(m => m.role === 'cta' && Math.round(m.timestampSec ?? -1) === lastIdx)) return true;
  const beats = d.storytellingBeats ?? [];
  if (beats.length && beats[beats.length - 1]!.type === 'cta') return true;
  const moments = d.keyMoments ?? [];
  if (moments.length && moments[moments.length - 1]!.role === 'cta') return true;
  return false;
}

export function storySlideCount(originalCount: number, hasCta: boolean): number {
  const n = hasCta ? originalCount - 1 : originalCount;
  return Math.min(8, Math.max(3, n));
}

export function deriveStorySlideCount(sources: Array<{ originalCount: number | null; analysis?: unknown }>): number | null {
  const stories = sources.map(s => {
    if (s.originalCount == null || s.originalCount < 1) return null;
    return storySlideCount(s.originalCount, analysisHasCtaSlide(s.analysis, s.originalCount));
  }).filter((n): n is number => n != null);
  if (!stories.length) return null;
  return Math.min(...stories);
}
