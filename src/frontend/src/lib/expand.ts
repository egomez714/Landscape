import { API_BASE } from "./graph";
import type { ExpandCandidate } from "./types";

export type ExistingNodeRef = { name: string; domain: string };

// Session-lifetime cache keyed on (domain, indexId, existingNodesSignature).
// Reopening the expand modal on the same node without adding anything hits
// the cache and skips the ~3-5s HD+Gemini round-trip. Signature includes the
// existing-nodes set so that if the graph grows (user added a different node
// somewhere else), the cache invalidates and we re-scan — otherwise the modal
// would show stale collides_with flags and still-relevant candidates.
const _cache = new Map<string, ExpandCandidate[]>();

function cacheKey(
  sourceDomain: string,
  sourceIndexId: string,
  existingNodes: ExistingNodeRef[],
): string {
  const sig = existingNodes
    .map((n) => n.domain)
    .sort()
    .join("|");
  return `${sourceDomain}::${sourceIndexId}::${sig}`;
}

export async function fetchExpansionCandidates(
  sourceDomain: string,
  sourceIndexId: string,
  existingNodes: ExistingNodeRef[],
  signal?: AbortSignal,
): Promise<ExpandCandidate[]> {
  const key = cacheKey(sourceDomain, sourceIndexId, existingNodes);
  const cached = _cache.get(key);
  if (cached) return cached;

  const res = await fetch(`${API_BASE}/v1/expand_from_node`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source_domain: sourceDomain,
      source_index_id: sourceIndexId,
      existing_nodes: existingNodes,
    }),
    signal,
  });
  if (!res.ok) {
    throw new Error(
      `expand_from_node failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const json = (await res.json()) as { candidates: ExpandCandidate[] };
  _cache.set(key, json.candidates);
  return json.candidates;
}

/** Drop any cached expansion result for a given source node — call after a
 * successful expansion so the next modal open re-scans against the newly-added
 * nodes instead of showing the pre-expansion snapshot. */
export function invalidateExpansionCache(sourceDomain: string): void {
  for (const k of Array.from(_cache.keys())) {
    if (k.startsWith(`${sourceDomain}::`)) _cache.delete(k);
  }
}
