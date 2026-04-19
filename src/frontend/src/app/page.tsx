"use client";

import { useMemo } from "react";

import GraphCanvas from "@/components/GraphCanvas";
import Legend from "@/components/Legend";
import QueryBar from "@/components/QueryBar";
import SidePanel from "@/components/SidePanel";
import StatusBar from "@/components/StatusBar";
import { useQueryStream } from "@/hooks/useQueryStream";

export default function Home() {
  const { state, run, select } = useQueryStream();

  const selected = useMemo(
    () => (state.selectedDomain ? state.companies[state.selectedDomain] : null),
    [state.companies, state.selectedDomain],
  );

  const isBusy =
    state.phase === "parsing" ||
    state.phase === "indexing" ||
    state.phase === "extracting";

  return (
    <main className="flex min-h-screen flex-col gap-3 p-4">
      <header className="flex items-center justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <h1 className="text-xl font-semibold tracking-tight text-[#e6f1fb]">
            Landscape
          </h1>
          <span className="text-xs text-[#8892b0]">
            A live knowledge graph of any industry
          </span>
        </div>
      </header>

      <div className="flex-none">
        <QueryBar onSubmit={run} disabled={isBusy} />
      </div>

      <section className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-[3fr_1fr]">
        <div className="relative min-h-[500px]">
          <GraphCanvas
            companies={state.companies}
            edges={state.edges}
            selectedDomain={state.selectedDomain}
            onSelect={select}
          />
        </div>
        <div className="min-h-[500px]">
          <SidePanel
            selected={selected ?? null}
            edges={state.edges}
            companies={state.companies}
            onSelect={select}
          />
        </div>
      </section>

      <footer className="flex flex-wrap items-center justify-between gap-3">
        <StatusBar
          phase={state.phase}
          companies={state.companies}
          edgeCount={state.edges.length}
          error={state.error}
        />
        <Legend />
      </footer>
    </main>
  );
}
