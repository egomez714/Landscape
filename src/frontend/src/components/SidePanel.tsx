"use client";

import { useEffect, useRef, useState } from "react";

import { API_BASE, EDGE_COLOR, EDGE_LABEL } from "@/lib/graph";
import type { CompanyNode, GraphEdge } from "@/lib/types";

type Props = {
  selected: CompanyNode | null;
  edges: GraphEdge[];
  companies: Record<string, CompanyNode>;
  onSelect: (domain: string | null) => void;
};

type SummaryState = "idle" | "loading" | "loaded" | "error";

export default function SidePanel({
  selected,
  edges,
  companies,
  onSelect,
}: Props) {
  const [summaries, setSummaries] = useState<Record<string, string>>({});
  const [summaryState, setSummaryState] = useState<Record<string, SummaryState>>({});
  const attemptedRef = useRef<Set<string>>(new Set());

  // Shared fetcher so we can use it both for lazy (on-click) and eager (prefetch) paths.
  function fetchSummary(domain: string, indexId: string) {
    if (attemptedRef.current.has(domain)) return;
    attemptedRef.current.add(domain);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    setSummaryState((s) => ({ ...s, [domain]: "loading" }));
    fetch(
      `${API_BASE}/company/summary?domain=${encodeURIComponent(domain)}` +
        `&index_id=${encodeURIComponent(indexId)}`,
      { signal: controller.signal },
    )
      .then(async (r) => {
        if (r.status === 404) return { summary: "", notFound: true };
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return { ...(await r.json()), notFound: false };
      })
      .then((data: { summary: string; notFound: boolean }) => {
        setSummaries((s) => ({ ...s, [domain]: data.summary || "" }));
        setSummaryState((s) => ({ ...s, [domain]: "loaded" }));
      })
      .catch((err) => {
        // AbortError (timeout) and HTTP errors are surfaced to the user via the
        // "Summary unavailable." state; no need to shout in the console for 404s.
        if ((err as Error).name !== "AbortError") {
          console.warn("summary fetch failed", domain, err);
        }
        setSummaryState((s) => ({ ...s, [domain]: "error" }));
        attemptedRef.current.delete(domain);
      })
      .finally(() => clearTimeout(timer));
  }

  const domain = selected?.domain;
  const status = selected?.status;
  const indexId = selected?.indexId;

  // Lazy fetch on click (safety net — summary should usually be prefetched by now).
  useEffect(() => {
    if (!domain || status !== "completed" || !indexId) return;
    fetchSummary(domain, indexId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domain, status, indexId]);

  // Prefetch summaries for every company that has finished indexing, so by the time
  // the user clicks a node the panel is already populated. Fires in the background
  // with no concurrency cap — Vertex handles 10 parallel Flash-Lite calls fine.
  useEffect(() => {
    Object.values(companies).forEach((c) => {
      if (c.status !== "completed") return;
      if (!c.indexId) return;
      if (attemptedRef.current.has(c.domain)) return;
      fetchSummary(c.domain, c.indexId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companies]);

  return (
    <aside className="relative flex h-full min-h-0 flex-col overflow-hidden rounded-[18px] border border-[rgba(140,200,255,0.08)] bg-[linear-gradient(180deg,rgba(10,18,40,0.65),rgba(3,6,16,0.7))] backdrop-blur-[14px]">
      {/* top accent line */}
      <span className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(0,229,255,0.4),transparent)]" />

      <div className="abyss-scroll min-h-0 flex-1 overflow-y-auto p-[18px]">
        <SectionLabel
          label="Specimen dossier"
          count={selected ? connectedEdges(selected, edges).length : null}
        />
        {!selected ? <EmptyPanel /> : <PanelBody
          selected={selected}
          edges={edges}
          companies={companies}
          onSelect={onSelect}
          summary={summaries[selected.domain]}
          summaryState={summaryState[selected.domain] ?? "idle"}
        />}
      </div>
    </aside>
  );
}

function SectionLabel({ label, count }: { label: string; count: number | null }) {
  return (
    <div className="mb-[10px] flex items-center justify-between font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--fg-faint)]">
      <span>{label}</span>
      {count !== null && (
        <span className="rounded-[4px] bg-[rgba(0,229,255,0.08)] px-[6px] py-[2px] text-[9px] text-[var(--cyan-soft)]">
          {count}
        </span>
      )}
      {count === null && <span>—</span>}
    </div>
  );
}

function EmptyPanel() {
  return (
    <div className="px-1 pt-2 pb-2 text-[13px] leading-[1.6] text-[var(--fg-dim)]">
      <div className="mb-[10px] font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-faint)]">
        Awaiting capture
      </div>
      No specimen selected. Click a luring node in the survey to pull it into the dossier.
      <div className="mt-[14px] font-mono text-[10px] leading-[1.8] tracking-[0.1em] text-[var(--fg-faint)]">
        › hover &nbsp;<span className="text-[var(--cyan-soft)]">inspect</span>
        <br />
        › click &nbsp;&nbsp;<span className="text-[var(--cyan-soft)]">lock dossier</span>
        <br />
        › esc &nbsp;&nbsp;&nbsp;&nbsp;<span className="text-[var(--cyan-soft)]">release</span>
      </div>
    </div>
  );
}

function PanelBody({
  selected,
  edges,
  companies,
  onSelect,
  summary,
  summaryState,
}: {
  selected: CompanyNode;
  edges: GraphEdge[];
  companies: Record<string, CompanyNode>;
  onSelect: (domain: string | null) => void;
  summary: string | undefined;
  summaryState: SummaryState;
}) {
  const connected = connectedEdges(selected, edges);
  const statusLabel = {
    pending: "queued",
    started: "indexing",
    completed: "indexed",
    failed: "failed",
  }[selected.status];
  const statusColor =
    selected.status === "completed"
      ? "var(--green)"
      : selected.status === "failed"
        ? "#ff6b6b"
        : "var(--amber)";

  return (
    <>
      <div className="flex flex-col gap-[6px]">
        <div className="text-[22px] leading-[1.1] font-normal font-[var(--font-display)] text-[var(--fg)]">
          {selected.name}
        </div>
        <a
          href={selected.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-mono text-[10.5px] text-[var(--fg-dim)] hover:text-[var(--cyan-soft)]"
        >
          {selected.url}
        </a>
        <div className="mt-[4px] flex gap-[10px] font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--fg-faint)]">
          <span className="inline-flex items-center gap-[4px]">
            <span
              className="inline-block h-[6px] w-[6px] rounded-full"
              style={{
                background: statusColor,
                boxShadow: `0 0 8px ${statusColor}`,
              }}
            />
            <span style={{ color: statusColor }}>{statusLabel}</span>
          </span>
          {selected.pageCount ? <span>{selected.pageCount} pages</span> : null}
        </div>
        {selected.failReason && (
          <div className="mt-2 rounded-md border border-red-400/30 bg-red-400/5 px-2 py-1 text-xs text-red-300">
            {selected.failReason}
          </div>
        )}

        {/* summary */}
        {selected.status === "completed" && (
          <div className="mt-3 border-l border-[rgba(0,229,255,0.35)] px-3 py-1 text-[13px] italic leading-[1.55] text-[#b9cce8]">
            {summaryState === "loading" && (
              <span className="not-italic text-[var(--fg-faint)]">Summarizing…</span>
            )}
            {summaryState === "loaded" && (summary || (
              <span className="not-italic text-[var(--fg-faint)]">
                No summary available.
              </span>
            ))}
            {summaryState === "error" && (
              <span className="not-italic text-[var(--fg-faint)]">
                Summary unavailable.
              </span>
            )}
          </div>
        )}
      </div>

      <div className="mt-[14px]">
        <SectionLabel label="Relationships" count={connected.length} />
        {connected.length === 0 ? (
          <div className="font-mono text-[10px] text-[var(--fg-faint)]">
            No links detected.
          </div>
        ) : (
          <ul className="flex flex-col">
            {connected.map((edge, i) => {
              const otherName =
                edge.source === selected.name ? edge.target : edge.source;
              const otherDomain = Object.values(companies).find(
                (c) => c.name === otherName,
              )?.domain;
              const color = EDGE_COLOR[edge.type];
              return (
                <li
                  key={`${edge.source}-${edge.target}-${i}`}
                  onClick={() => otherDomain && onSelect(otherDomain)}
                  className="mb-[10px] cursor-pointer rounded-[10px] border border-[rgba(140,200,255,0.08)] bg-[rgba(10,18,40,0.4)] px-3 py-[10px] transition hover:border-[rgba(0,229,255,0.25)] hover:bg-[rgba(0,229,255,0.04)]"
                >
                  <div className="flex items-center gap-2 text-[12px]">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: color, boxShadow: `0 0 6px ${color}` }}
                    />
                    <span
                      className="font-mono text-[10px] uppercase tracking-[0.16em]"
                      style={{ color }}
                    >
                      {EDGE_LABEL[edge.type]}
                    </span>
                    <span className="font-mono text-[9px] tracking-[0.1em] text-[var(--fg-faint)]">
                      [{edge.confidence}]
                    </span>
                    <span className="ml-auto text-[12.5px] font-medium text-[var(--fg)]">
                      {otherName}
                    </span>
                  </div>
                  <ul className="mt-2 flex flex-col gap-[6px]">
                    {edge.evidence.map((ev, j) => (
                      <li
                        key={j}
                        className="text-[11.5px] leading-[1.5] text-[#a7bad4]"
                      >
                        <span className="italic text-[#c1d4ee]">“{ev.text}”</span>{" "}
                        <a
                          href={ev.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          className="ml-[6px] font-mono text-[9.5px] tracking-[0.12em] text-[var(--cyan-soft)] opacity-85 hover:opacity-100 hover:underline"
                        >
                          src ↗
                        </a>
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}

function connectedEdges(selected: CompanyNode, edges: GraphEdge[]): GraphEdge[] {
  return edges.filter(
    (e) => e.source === selected.name || e.target === selected.name,
  );
}
