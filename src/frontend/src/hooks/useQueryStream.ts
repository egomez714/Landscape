"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { API_BASE } from "@/lib/graph";
import { postSSEStream } from "@/lib/sse";
import type {
  CompaniesParsedEvent,
  CompanyNode,
  DiscoveredVia,
  DoneEvent,
  EdgeFoundEvent,
  ErrorEvent,
  ExpandCandidate,
  GraphState,
  IndexCompletedEvent,
  IndexFailedEvent,
  IndexStartedEvent,
} from "@/lib/types";

type Action =
  | { type: "start"; query: string }
  | {
      type: "expand_start";
      sourceCompany: { name: string; domain: string };
      candidates: ExpandCandidate[];
      newCompanyUrls: Record<string, { name: string; url: string; domain: string }>;
    }
  | { type: "companies_parsed"; payload: CompaniesParsedEvent }
  | { type: "index_started"; payload: IndexStartedEvent }
  | { type: "index_completed"; payload: IndexCompletedEvent }
  | { type: "index_failed"; payload: IndexFailedEvent }
  | { type: "edge_found"; payload: EdgeFoundEvent }
  | { type: "done"; payload: DoneEvent }
  | { type: "error"; payload: ErrorEvent }
  | { type: "select"; domain: string | null };

const initial: GraphState = {
  phase: "idle",
  query: null,
  companies: {},
  edges: [],
  selectedDomain: null,
  error: null,
  totals: null,
  discoveredVia: {},
};

function reducer(state: GraphState, action: Action): GraphState {
  switch (action.type) {
    case "start":
      return { ...initial, phase: "parsing", query: action.query };

    case "companies_parsed": {
      const companies: GraphState["companies"] = {};
      for (const c of action.payload.companies) {
        companies[c.domain] = { ...c, status: "pending" };
      }
      return { ...state, phase: "indexing", companies };
    }

    case "expand_start": {
      // Merge new candidates into the existing graph state as pending nodes.
      // Existing companies + edges stay intact; only new domains are added.
      const newCompanies: Record<string, CompanyNode> = { ...state.companies };
      const newDV: Record<string, DiscoveredVia> = { ...state.discoveredVia };
      for (const c of action.candidates) {
        const urlInfo = action.newCompanyUrls[c.name];
        if (!urlInfo) continue; // no homepage url available → can't index
        if (newCompanies[urlInfo.domain]) continue; // already in graph
        newCompanies[urlInfo.domain] = {
          name: urlInfo.name,
          url: urlInfo.url,
          domain: urlInfo.domain,
          status: "pending",
        };
        newDV[urlInfo.domain] = {
          source_name: action.sourceCompany.name,
          source_domain: action.sourceCompany.domain,
          evidence_quote: c.evidence_quote,
          source_url: c.source_url,
        };
      }
      return {
        ...state,
        phase: "indexing",
        companies: newCompanies,
        discoveredVia: newDV,
        error: null,
        totals: null,
      };
    }

    case "index_started": {
      const existing = state.companies[action.payload.domain];
      if (!existing) return state;
      return {
        ...state,
        companies: {
          ...state.companies,
          [action.payload.domain]: {
            ...existing,
            status: "started",
            indexId: action.payload.index_id,
          },
        },
      };
    }

    case "index_completed": {
      const existing = state.companies[action.payload.domain];
      if (!existing) return state;
      return {
        ...state,
        companies: {
          ...state.companies,
          [action.payload.domain]: {
            ...existing,
            status: "completed",
            pageCount: action.payload.page_count,
          },
        },
      };
    }

    case "index_failed": {
      const existing = state.companies[action.payload.domain];
      if (!existing) return state;
      return {
        ...state,
        companies: {
          ...state.companies,
          [action.payload.domain]: {
            ...existing,
            status: "failed",
            failReason: action.payload.reason,
          },
        },
      };
    }

    case "edge_found":
      return {
        ...state,
        phase: "extracting",
        edges: [...state.edges, action.payload],
      };

    case "done":
      return { ...state, phase: "done", totals: action.payload };

    case "error":
      return { ...state, phase: "error", error: action.payload };

    case "select":
      return { ...state, selectedDomain: action.domain };
  }
}

export function useQueryStream() {
  const [state, dispatch] = useReducer(reducer, initial);
  const sourceRef = useRef<EventSource | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // The reducer needs the latest companies to build `existing_indexed` for expand.
  // Closure over state would stale here since runExpand is memoized; use a ref.
  const stateRef = useRef(state);
  stateRef.current = state;

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const run = useCallback(
    (query: string) => {
      close();
      dispatch({ type: "start", query });

      const url = `${API_BASE}/query/stream?q=${encodeURIComponent(query)}`;
      const src = new EventSource(url);
      sourceRef.current = src;

      const handler =
        <T>(type: Action["type"]) =>
        (e: MessageEvent) => {
          try {
            const payload = JSON.parse(e.data) as T;
            // @ts-expect-error — union narrowing by `type` handled in reducer
            dispatch({ type, payload });
          } catch (err) {
            console.error("failed to parse SSE event", type, err);
          }
        };

      src.addEventListener("companies_parsed", handler<CompaniesParsedEvent>("companies_parsed"));
      src.addEventListener("index_started", handler<IndexStartedEvent>("index_started"));
      src.addEventListener("index_completed", handler<IndexCompletedEvent>("index_completed"));
      src.addEventListener("index_failed", handler<IndexFailedEvent>("index_failed"));
      src.addEventListener("edge_found", handler<EdgeFoundEvent>("edge_found"));
      src.addEventListener("done", (e) => {
        handler<DoneEvent>("done")(e);
        close();
      });
      src.addEventListener("error", (e) => {
        const me = e as MessageEvent;
        if (typeof me.data === "string") {
          handler<ErrorEvent>("error")(me);
        } else {
          dispatch({
            type: "error",
            payload: { stage: "connection", message: "EventSource connection error" },
          });
        }
        close();
      });
    },
    [close],
  );

  const runExpand = useCallback(
    async (
      sourceCompany: { name: string; domain: string },
      candidates: ExpandCandidate[],
      resolved: Record<string, { name: string; url: string; domain: string }>,
    ) => {
      close();

      // Preliminary state update — pending nodes + discoveredVia.
      dispatch({
        type: "expand_start",
        sourceCompany,
        candidates,
        newCompanyUrls: resolved,
      });

      const existing = Object.values(stateRef.current.companies)
        .filter((c) => c.status === "completed" && c.indexId)
        .map((c) => ({
          name: c.name,
          url: c.url,
          domain: c.domain,
          index_id: c.indexId!,
          page_count: c.pageCount ?? 0,
        }));
      const newDomains = Object.values(resolved);
      if (newDomains.length === 0) return;

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        for await (const frame of postSSEStream(
          `${API_BASE}/v1/expand/stream`,
          {
            context: {
              source_name: sourceCompany.name,
              source_domain: sourceCompany.domain,
            },
            existing_indexed: existing,
            new_candidates: newDomains,
          },
          ctrl.signal,
        )) {
          if (frame.event === "expansion_context") continue;
          if (frame.event === "index_started") {
            dispatch({ type: "index_started", payload: frame.data as IndexStartedEvent });
          } else if (frame.event === "index_completed") {
            dispatch({ type: "index_completed", payload: frame.data as IndexCompletedEvent });
          } else if (frame.event === "index_failed") {
            dispatch({ type: "index_failed", payload: frame.data as IndexFailedEvent });
          } else if (frame.event === "edge_found") {
            dispatch({ type: "edge_found", payload: frame.data as EdgeFoundEvent });
          } else if (frame.event === "done") {
            dispatch({ type: "done", payload: frame.data as DoneEvent });
          } else if (frame.event === "error") {
            dispatch({ type: "error", payload: frame.data as ErrorEvent });
          }
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          console.error("expand stream error", err);
          dispatch({
            type: "error",
            payload: { stage: "expand", message: String(err) },
          });
        }
      } finally {
        if (abortRef.current === ctrl) abortRef.current = null;
      }
    },
    [close],
  );

  const select = useCallback((domain: string | null) => {
    dispatch({ type: "select", domain });
  }, []);

  useEffect(() => close, [close]);

  return { state, run, runExpand, select };
}
