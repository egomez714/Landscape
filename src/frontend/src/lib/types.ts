// SSE event payloads — must match backend app/routers/query.py exactly.

export type RelationshipType =
  | "competitor"
  | "partner"
  | "uses"
  | "customer"
  | "none";

export type Confidence = "high" | "medium" | "low";

export type CompanyRef = {
  name: string;
  url: string;
  domain: string;
};

export type IndexStatus = "pending" | "started" | "completed" | "failed";

export type CompanyNode = CompanyRef & {
  status: IndexStatus;
  pageCount?: number;
  failReason?: string;
  indexId?: string; // needed to fetch the company summary
};

export type EvidenceSnippet = {
  text: string;
  source_url: string;
};

export type GraphEdge = {
  source: string;
  target: string;
  type: RelationshipType;
  confidence: Confidence;
  evidence: EvidenceSnippet[];
};

// ---- Feature 2: expansion ----

export type ExpandCandidate = {
  name: string;
  evidence_quote: string;
  source_url: string;
  homepage_url: string | null;
  // Set when the candidate's homepage domain matches a node already in the
  // graph — the modal disables the checkbox and shows "already in graph as X".
  collides_with: string | null;
};

export type DiscoveredVia = {
  source_name: string;      // name of the node the user clicked "Find more like this" on
  source_domain: string;
  evidence_quote: string;   // the candidate's own evidence, not the source's
  source_url: string;       // the page URL that evidence came from
};

// ---- SSE event wire shapes ----

export type CompaniesParsedEvent = { companies: CompanyRef[] };
export type IndexStartedEvent = { name: string; domain: string; index_id: string };
export type IndexCompletedEvent = { name: string; domain: string; page_count: number };
export type IndexFailedEvent = { name: string; domain: string; reason: string };
export type EdgeFoundEvent = GraphEdge;
export type DoneEvent = { companies: number; edges: number };
export type ErrorEvent = { stage: string; message: string };

// ---- client-side reducer state ----

export type StreamPhase =
  | "idle"
  | "parsing"
  | "indexing"
  | "extracting"
  | "done"
  | "error";

export type GraphState = {
  phase: StreamPhase;
  query: string | null;
  companies: Record<string, CompanyNode>; // keyed by domain
  edges: GraphEdge[];
  selectedDomain: string | null;
  error: ErrorEvent | null;
  totals: { companies: number; edges: number } | null;
  discoveredVia: Record<string, DiscoveredVia>; // keyed by new-node's domain
};
