"use client";

import { useCallback, useEffect, useState } from "react";

import {
  clearAllResearch,
  loadResearch,
  saveQueryResult,
  type ResearchSnapshot,
} from "@/lib/researchStore";
import type { CompanyNode, GraphEdge } from "@/lib/types";

const EMPTY: ResearchSnapshot = {
  queries: [],
  companies: new Map(),
  edges: new Map(),
};

/** Subscribe to the IndexedDB-backed research memory. On mount, reads the
 * full snapshot; `persist` writes a new query and re-reads; `clear` wipes. */
export function useResearchStore() {
  const [snapshot, setSnapshot] = useState<ResearchSnapshot>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadResearch()
      .then((snap) => {
        if (!cancelled) {
          setSnapshot(snap);
          setLoaded(true);
        }
      })
      .catch((err) => {
        console.error("loadResearch failed", err);
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const persist = useCallback(
    async (
      queryText: string,
      companies: Record<string, CompanyNode>,
      edges: GraphEdge[],
    ) => {
      try {
        await saveQueryResult(queryText, companies, edges);
        const next = await loadResearch();
        setSnapshot(next);
      } catch (err) {
        console.error("saveQueryResult failed", err);
      }
    },
    [],
  );

  const clear = useCallback(async () => {
    try {
      await clearAllResearch();
      setSnapshot(EMPTY);
    } catch (err) {
      console.error("clearAllResearch failed", err);
    }
  }, []);

  return { snapshot, loaded, persist, clear };
}
