// SSE event payloads — must match backend app/routers/query.py exactly.

export type RelationshipType =
  | "competitor"
  | "partner"
  | "investor"
  | "downstream"
  | "talent"
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
};
