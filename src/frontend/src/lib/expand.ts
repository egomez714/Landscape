import { API_BASE } from "./graph";
import type { ExpandCandidate } from "./types";

export type ExistingNodeRef = { name: string; domain: string };

export async function fetchExpansionCandidates(
  sourceDomain: string,
  sourceIndexId: string,
  existingNodes: ExistingNodeRef[],
  signal?: AbortSignal,
): Promise<ExpandCandidate[]> {
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
  return json.candidates;
}
