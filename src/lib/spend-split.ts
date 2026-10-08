// Cost splitting for scrapes shared across workspaces. Provider-neutral: used by
// both the Apify and the proxy adapter.

/**
 * Split one run's cost across the workspaces that share it.
 *
 * Integer cents, remainder to the first sharer, and a workspace appearing
 * twice (two of its sources tracking the same canonical query) pays twice —
 * it consumed two of the N shares. Never rounds a share to 0 when there is
 * cost to attribute: a cap that can be evaded by joining a big enough batch
 * is not a cap.
 */
export function splitSpend(
  workspaceIds: string[],
  totalCents: number,
): Array<{ workspaceId: string; cents: number }> {
  const ids = workspaceIds.length > 0 ? workspaceIds : [];
  if (ids.length === 0) return [];
  if (ids.length === 1) return [{ workspaceId: ids[0]!, cents: totalCents }];

  const per = Math.floor(totalCents / ids.length);
  const remainder = totalCents - per * ids.length;
  const byWorkspace = new Map<string, number>();
  ids.forEach((id, idx) => {
    const share = per + (idx === 0 ? remainder : 0);
    byWorkspace.set(id, (byWorkspace.get(id) ?? 0) + share);
  });
  return [...byWorkspace].map(([workspaceId, cents]) => ({ workspaceId, cents }));
}
