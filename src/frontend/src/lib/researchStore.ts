// Cross-query persistence in IndexedDB. Every completed query pushes its
// companies and edges here, and the "All research" view mode renders the
// union across every query ever run in this browser profile.
//
// No user accounts, no cloud sync, no cross-device — just the browser's own
// IDB, as originally specified in the Feature 3 plan. A small native-IDB
// wrapper (no `idb` dep) keeps the bundle footprint flat.
//
// Schema (version 1, database "landscape-research"):
//   queries    keyPath id         (one record per query the user has run)
//   companies  keyPath domain     (one per company, merged across queries)
//   edges      keyPath key        (canonical pair+type key, merged)
//
// Everything is upsert-by-key so running the same query twice doesn't produce
// duplicates — instead it appends the new queryId to each record's queryIds
// list and bumps lastSeen.

import type {
  Confidence,
  CompanyNode,
  EvidenceSnippet,
  GraphEdge,
  RelationshipType,
} from "./types";

const DB_NAME = "landscape-research";
const DB_VERSION = 1;

const STORE_QUERIES = "queries";
const STORE_COMPANIES = "companies";
const STORE_EDGES = "edges";

export type StoredQuery = {
  id: string;
  queryText: string;
  timestamp: number;
  companyDomains: string[];
  edgeKeys: string[];
};

export type StoredCompany = {
  domain: string;
  name: string;
  url: string;
  indexId?: string;
  pageCount?: number;
  queryIds: string[];
  firstSeen: number;
  lastSeen: number;
};

export type StoredEdge = {
  key: string; // canonical: `${minDomain}__${maxDomain}__${type}`
  sourceName: string;
  targetName: string;
  sourceDomain: string;
  targetDomain: string;
  type: RelationshipType;
  confidence: Confidence;
  evidence: EvidenceSnippet[];
  queryIds: string[];
  firstSeen: number;
  lastSeen: number;
};

export type ResearchSnapshot = {
  queries: StoredQuery[];
  companies: Map<string, StoredCompany>;
  edges: Map<string, StoredEdge>;
};

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof indexedDB !== "undefined";
}

/** Open (or create/upgrade) the DB. Resolves to null in SSR / unsupported. */
function openDb(): Promise<IDBDatabase | null> {
  if (!isBrowser()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_QUERIES)) {
        db.createObjectStore(STORE_QUERIES, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_COMPANIES)) {
        db.createObjectStore(STORE_COMPANIES, { keyPath: "domain" });
      }
      if (!db.objectStoreNames.contains(STORE_EDGES)) {
        db.createObjectStore(STORE_EDGES, { keyPath: "key" });
      }
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => resolve(req.result);
  });
}

/** Canonical edge key: sorted-domain pair plus type, so (A→B, partner) and
 * (B→A, partner) collide on the same record. Direction is discarded for
 * dedup — "partner" is a symmetric relation and "A competitor B" ≡ "B
 * competitor A". Tiebreak by type keeps `partner` distinct from `customer`. */
export function edgeKey(
  sourceDomain: string,
  targetDomain: string,
  type: RelationshipType,
): string {
  const [lo, hi] = [sourceDomain, targetDomain].sort();
  return `${lo}__${hi}__${type}`;
}

/** Resolve a GraphEdge's source/target *names* to their *domains* using the
 * live companies map. If either side isn't in the map, returns null and the
 * edge is skipped (shouldn't happen in practice, but prevents a malformed
 * record from poisoning the store). */
function resolveEdgeDomains(
  edge: GraphEdge,
  nameToDomain: Map<string, string>,
): { sourceDomain: string; targetDomain: string } | null {
  const s = nameToDomain.get(edge.source);
  const t = nameToDomain.get(edge.target);
  if (!s || !t) return null;
  return { sourceDomain: s, targetDomain: t };
}

function promisifyTx(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveQueryResult(
  queryText: string,
  companies: Record<string, CompanyNode>,
  edges: GraphEdge[],
): Promise<StoredQuery | null> {
  const db = await openDb();
  if (!db) return null;
  const id = `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const now = Date.now();

  // Only persist companies that actually indexed successfully — pending/failed
  // nodes aren't useful as research memory and would pollute the "all research"
  // view with ghost entries.
  const completedCompanies = Object.values(companies).filter(
    (c) => c.status === "completed",
  );
  const companyDomains = completedCompanies.map((c) => c.domain);
  const nameToDomain = new Map(completedCompanies.map((c) => [c.name, c.domain]));

  const edgeRecords: StoredEdge[] = [];
  for (const e of edges) {
    const domains = resolveEdgeDomains(e, nameToDomain);
    if (!domains) continue;
    edgeRecords.push({
      key: edgeKey(domains.sourceDomain, domains.targetDomain, e.type),
      sourceName: e.source,
      targetName: e.target,
      sourceDomain: domains.sourceDomain,
      targetDomain: domains.targetDomain,
      type: e.type,
      confidence: e.confidence,
      evidence: e.evidence,
      queryIds: [id],
      firstSeen: now,
      lastSeen: now,
    });
  }

  const query: StoredQuery = {
    id,
    queryText,
    timestamp: now,
    companyDomains,
    edgeKeys: edgeRecords.map((e) => e.key),
  };

  // One transaction across all three stores so the write is atomic.
  const tx = db.transaction(
    [STORE_QUERIES, STORE_COMPANIES, STORE_EDGES],
    "readwrite",
  );
  const queriesStore = tx.objectStore(STORE_QUERIES);
  const companiesStore = tx.objectStore(STORE_COMPANIES);
  const edgesStore = tx.objectStore(STORE_EDGES);

  queriesStore.put(query);

  for (const c of completedCompanies) {
    // Read-modify-write merge: append this queryId, keep the earliest
    // firstSeen, bump lastSeen. Missing record → insert fresh.
    const existing = (await promisifyRequest(companiesStore.get(c.domain))) as
      | StoredCompany
      | undefined;
    const merged: StoredCompany = existing
      ? {
          ...existing,
          name: c.name,
          url: c.url,
          indexId: c.indexId ?? existing.indexId,
          pageCount: c.pageCount ?? existing.pageCount,
          queryIds: existing.queryIds.includes(id)
            ? existing.queryIds
            : [...existing.queryIds, id],
          lastSeen: now,
        }
      : {
          domain: c.domain,
          name: c.name,
          url: c.url,
          indexId: c.indexId,
          pageCount: c.pageCount,
          queryIds: [id],
          firstSeen: now,
          lastSeen: now,
        };
    companiesStore.put(merged);
  }

  for (const rec of edgeRecords) {
    const existing = (await promisifyRequest(edgesStore.get(rec.key))) as
      | StoredEdge
      | undefined;
    const merged: StoredEdge = existing
      ? {
          ...existing,
          // Keep the original source/target name orientation from the first
          // time the edge was found — otherwise the arrow flips visually
          // across queries even though the underlying relationship didn't.
          confidence: rec.confidence, // newest wins (fresher run)
          evidence: rec.evidence, // newest evidence wins
          queryIds: existing.queryIds.includes(id)
            ? existing.queryIds
            : [...existing.queryIds, id],
          lastSeen: now,
        }
      : rec;
    edgesStore.put(merged);
  }

  await promisifyTx(tx);
  db.close();
  return query;
}

export async function loadResearch(): Promise<ResearchSnapshot> {
  const empty: ResearchSnapshot = {
    queries: [],
    companies: new Map(),
    edges: new Map(),
  };
  const db = await openDb();
  if (!db) return empty;
  try {
    const tx = db.transaction(
      [STORE_QUERIES, STORE_COMPANIES, STORE_EDGES],
      "readonly",
    );
    const [queries, companies, edges] = await Promise.all([
      promisifyRequest(tx.objectStore(STORE_QUERIES).getAll()) as Promise<
        StoredQuery[]
      >,
      promisifyRequest(tx.objectStore(STORE_COMPANIES).getAll()) as Promise<
        StoredCompany[]
      >,
      promisifyRequest(tx.objectStore(STORE_EDGES).getAll()) as Promise<
        StoredEdge[]
      >,
    ]);
    return {
      queries: queries.sort((a, b) => b.timestamp - a.timestamp),
      companies: new Map(companies.map((c) => [c.domain, c])),
      edges: new Map(edges.map((e) => [e.key, e])),
    };
  } finally {
    db.close();
  }
}

export async function clearAllResearch(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(
      [STORE_QUERIES, STORE_COMPANIES, STORE_EDGES],
      "readwrite",
    );
    tx.objectStore(STORE_QUERIES).clear();
    tx.objectStore(STORE_COMPANIES).clear();
    tx.objectStore(STORE_EDGES).clear();
    await promisifyTx(tx);
  } finally {
    db.close();
  }
}
