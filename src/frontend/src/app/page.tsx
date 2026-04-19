"use client";

import { useMemo } from "react";

import GraphCanvas from "@/components/GraphCanvas";
import HudCorners from "@/components/HudCorners";
import Legend from "@/components/Legend";
import QueryBar from "@/components/QueryBar";
import SidePanel from "@/components/SidePanel";
import StatusBar from "@/components/StatusBar";
import TelemetryChips from "@/components/TelemetryChips";
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

  const specimenCount = Object.keys(state.companies).length;
  const linkCount = state.edges.length;

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
        <TelemetryChips specimenCount={specimenCount} linkCount={linkCount} />
      </header>

      {/* query bar */}
      <section className="z-[5]" style={{ gridColumn: "1 / -1" }}>
        <QueryBar onSubmit={run} disabled={isBusy} />
      </section>

      {/* main graph */}
      <section
        className="relative isolate h-full min-h-0 overflow-hidden"
        style={{ gridColumn: "1 / 2" }}
      >
        <GraphCanvas
          companies={state.companies}
          edges={state.edges}
          selectedDomain={state.selectedDomain}
          onSelect={select}
        />
        <HudCorners specimenCount={specimenCount} linkCount={linkCount} />
      </section>

      {/* side panel */}
      <section className="h-full min-h-0" style={{ gridColumn: "2 / 3" }}>
        <SidePanel
          selected={selected ?? null}
          edges={state.edges}
          companies={state.companies}
          onSelect={select}
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
    </main>
  );
}
