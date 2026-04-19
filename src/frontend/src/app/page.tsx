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
  const indexedCount = Object.values(state.companies).filter(
    (c) => c.status === "completed",
  ).length;
  const emptyEcosystem =
    state.phase === "done" && linkCount === 0 && indexedCount >= 2;

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
