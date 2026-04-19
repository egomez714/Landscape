"use client";

import { useCallback, useEffect, useReducer, useRef } from "react";

import { API_BASE } from "@/lib/graph";
import type {
  CompaniesParsedEvent,
  DoneEvent,
  EdgeFoundEvent,
  ErrorEvent,
  GraphState,
  IndexCompletedEvent,
  IndexFailedEvent,
  IndexStartedEvent,
} from "@/lib/types";

type Action =
  | { type: "start"; query: string }
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

    case "index_started": {
      const existing = state.companies[action.payload.domain];
      if (!existing) return state;
      return {
        ...state,
        companies: {
          ...state.companies,
          [action.payload.domain]: { ...existing, status: "started" },
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

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
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
        // SSE "error" arrives as a MessageEvent only if the server emits event: error.
        // Connection errors arrive as plain Events with no data.
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

  const select = useCallback((domain: string | null) => {
    dispatch({ type: "select", domain });
  }, []);

  useEffect(() => close, [close]);

  return { state, run, select };
}
