"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import ExpandModal from "@/components/ExpandModal";
import GraphCanvas from "@/components/GraphCanvas";
import HudCorners from "@/components/HudCorners";
import Legend from "@/components/Legend";
import QueryBar from "@/components/QueryBar";
import ResearchControls from "@/components/ResearchControls";
import SidePanel from "@/components/SidePanel";
import StatusBar from "@/components/StatusBar";
import TelemetryChips from "@/components/TelemetryChips";
import { useQueryStream } from "@/hooks/useQueryStream";
import { useResearchStore } from "@/hooks/useResearchStore";
import type { CompanyNode, GraphEdge, ViewMode } from "@/lib/types";

export default function Home() {
  const { state, run, runExpand, select } = useQueryStream();
  const [expandOpen, setExpandOpen] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("current");
  const { snapshot, persist, clear } = useResearchStore();

  // Persist finished queries to IndexedDB. Fires on the phase→done transition
  // (live-state reducer resets phase out of "done" on next start/expand_start,
  // so this effect lands exactly once per completion, including expansions —
  // each expansion effectively captures a fresh snapshot of the accumulated
  // query+expand session).
  const prevPhaseRef = useRef<string>("idle");
  useEffect(() => {
    if (
      prevPhaseRef.current !== "done" &&
      state.phase === "done" &&
      state.query
    ) {
      persist(state.query, state.companies, state.edges);
    }
    prevPhaseRef.current = state.phase;
  }, [state.phase, state.query, state.companies, state.edges, persist]);

  // When the user explicitly runs a new query, snap back to "This query" view.
  // Flipping to "All research" on top of a fresh live query would double-render
  // the live nodes plus everything else — confusing. Reset on each `run`.
  const runAndResetView = (q: string) => {
    setViewMode("current");
    run(q);
  };

  // Merged view for "All research" mode: the research snapshot, overlaid with
  // the live query's companies/edges (live state wins on conflict — newer
  // indexId / status / pageCount take precedence over the stored copy).
  const { displayCompanies, displayEdges } = useMemo(() => {
    if (viewMode === "current" || snapshot.companies.size === 0) {
      return {
        displayCompanies: state.companies,
        displayEdges: state.edges,
      };
    }
    const merged: Record<string, CompanyNode> = {};
    for (const [domain, c] of snapshot.companies) {
      merged[domain] = {
        name: c.name,
        url: c.url,
        domain,
        status: "completed",
        indexId: c.indexId,
        pageCount: c.pageCount,
        queryCount: c.queryIds.length,
      };
    }
    // Live overwrite — preserves in-flight statuses (pending/started/failed)
    // and the indexId we just learned for the current crawl.
    for (const c of Object.values(state.companies)) {
      const existing = merged[c.domain];
      merged[c.domain] = {
        ...existing,
        ...c,
        queryCount: Math.max(existing?.queryCount ?? 0, 1),
      };
    }

    // Reverse map name→domain for the live edges so we can rehydrate stored
    // edges without duplicating a live edge for the same pair+type.
    const liveKeys = new Set<string>();
    const nameToDomain = new Map(
      Object.values(merged).map((c) => [c.name, c.domain]),
    );
    for (const e of state.edges) {
      const s = nameToDomain.get(e.source);
      const t = nameToDomain.get(e.target);
      if (s && t) {
        const [lo, hi] = [s, t].sort();
        liveKeys.add(`${lo}__${hi}__${e.type}`);
      }
    }

    const edges: GraphEdge[] = [...state.edges];
    for (const [key, stored] of snapshot.edges) {
      if (liveKeys.has(key)) continue;
      edges.push({
        source: stored.sourceName,
        target: stored.targetName,
        type: stored.type,
        confidence: stored.confidence,
        evidence: stored.evidence,
      });
    }
    return { displayCompanies: merged, displayEdges: edges };
  }, [viewMode, snapshot, state.companies, state.edges]);

  const selected = useMemo(
    () => (state.selectedDomain ? displayCompanies[state.selectedDomain] : null),
    [displayCompanies, state.selectedDomain],
  );

  const isBusy =
    state.phase === "parsing" ||
    state.phase === "indexing" ||
    state.phase === "extracting";

  const specimenCount = Object.keys(state.companies).length;
  const linkCount = state.edges.length;
  const totalSpecimens = Object.keys(displayCompanies).length;
  const indexedCount = Object.values(state.companies).filter(
    (c) => c.status === "completed",
  ).length;
  const emptyEcosystem =
    viewMode === "current" &&
    state.phase === "done" &&
    linkCount === 0 &&
    indexedCount >= 2;

  // Expansion available only when: selected node is indexed + not busy + we're
  // viewing the current query (expanding from a stored-only node has no
  // meaningful "source" to re-extract against).
  const onExpandFromNode =
    viewMode === "current" &&
    selected &&
    selected.status === "completed" &&
    selected.indexId &&
    !isBusy
      ? () => setExpandOpen(true)
      : null;

  return (
    <main
      className="grid h-screen w-screen gap-[14px] p-[14px]"
      style={{
        gridTemplateRows: "auto auto 1fr auto",
        gridTemplateColumns: "1fr 360px",
      }}
    >
      {/* header */}
      <header
        className="flex items-center justify-between gap-5 z-[5]"
        style={{ gridColumn: "1 / -1" }}
      >
        <div className="flex items-baseline gap-[14px]">
          <div
            className="inline-flex items-center gap-[10px] text-[22px] font-normal tracking-[0.02em] text-[var(--fg)]"
            style={{ fontFamily: "var(--font-display)" }}
          >
            <span
              className="h-2 w-2 rounded-full bg-[var(--cyan)]"
              style={{
                boxShadow:
                  "0 0 12px var(--cyan), 0 0 24px rgba(0,229,255,0.4)",
                animation: "abyss-pulse 2.6s ease-in-out infinite",
              }}
            />
            Landscape
          </div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.22em] text-[var(--fg-faint)]">
            Knowledge graph · Abyssal zone · −3,280 m
          </div>
        </div>
        <div className="flex items-center gap-[10px]">
          <ResearchControls
            mode={viewMode}
            onModeChange={setViewMode}
            queriesRun={snapshot.queries.length}
            totalSpecimens={totalSpecimens}
            onClear={clear}
            disabled={isBusy}
          />
          <TelemetryChips specimenCount={specimenCount} linkCount={linkCount} />
        </div>
      </header>

      {/* query bar */}
      <section className="z-[5]" style={{ gridColumn: "1 / -1" }}>
        <QueryBar onSubmit={runAndResetView} disabled={isBusy} />
      </section>

      {/* main graph */}
      <section
        className="relative isolate h-full min-h-0 overflow-hidden"
        style={{ gridColumn: "1 / 2" }}
      >
        <GraphCanvas
          companies={displayCompanies}
          edges={displayEdges}
          selectedDomain={state.selectedDomain}
          onSelect={select}
        />
        <HudCorners specimenCount={totalSpecimens} linkCount={displayEdges.length} />
        {emptyEcosystem && (
          <div className="pointer-events-none absolute left-1/2 top-1/2 z-[3] max-w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-xl border border-[rgba(140,200,255,0.12)] bg-[rgba(4,8,20,0.82)] px-6 py-5 text-center backdrop-blur-md">
            <div className="mb-[6px] font-mono text-[10px] uppercase tracking-[0.25em] text-[var(--cyan-soft)]">
              Silent ecosystem
            </div>
            <div className="mb-2 font-[var(--font-display)] text-[18px] leading-[1.3] text-[var(--fg)]">
              No public cross-mentions found
            </div>
            <div className="text-[12.5px] leading-[1.55] text-[var(--fg-dim)]">
              These companies don&apos;t publicly name each other on their websites —
              common for enterprise biotech, pharma, and industrial incumbents. Try a
              more open ecosystem like{" "}
              <span className="text-[var(--cyan-soft)]">
                AI agent infrastructure
              </span>
              ,{" "}
              <span className="text-[var(--cyan-soft)]">vector database companies</span>
              , or{" "}
              <span className="text-[var(--cyan-soft)]">
                developer tools startups
              </span>
              .
            </div>
          </div>
        )}
      </section>

      {/* side panel */}
      <section className="h-full min-h-0" style={{ gridColumn: "2 / 3" }}>
        <SidePanel
          selected={selected ?? null}
          edges={displayEdges}
          companies={displayCompanies}
          discoveredVia={state.discoveredVia}
          onSelect={select}
          onExpandFromNode={onExpandFromNode}
        />
      </section>

      {/* footer */}
      <footer
        className="flex flex-wrap items-center justify-between gap-[14px] z-[5]"
        style={{ gridColumn: "1 / -1" }}
      >
        <StatusBar
          phase={state.phase}
          companies={state.companies}
          edgeCount={state.edges.length}
          error={state.error}
        />
        <Legend />
      </footer>

      {expandOpen && selected && selected.indexId && (
        <ExpandModal
          sourceNode={selected}
          existingNodes={Object.values(state.companies).map((c) => ({
            name: c.name,
            domain: c.domain,
          }))}
          onClose={() => setExpandOpen(false)}
          onAdd={(accepted, resolved) => {
            setExpandOpen(false);
            runExpand(
              { name: selected.name, domain: selected.domain },
              accepted,
              resolved,
            );
          }}
        />
      )}
    </main>
  );
}
