"use client";

import { useEffect, useRef, useState } from "react";

import { fetchExpansionCandidates, type ExistingNodeRef } from "@/lib/expand";
import type { CompanyNode, ExpandCandidate } from "@/lib/types";

type Props = {
  sourceNode: CompanyNode;
  existingNodes: ExistingNodeRef[];
  onClose: () => void;
  onAdd: (
    accepted: ExpandCandidate[],
    resolved: Record<string, { name: string; url: string; domain: string }>,
  ) => void;
};

type LoadState = "loading" | "ready" | "empty" | "error";

/** Derive a domain from a URL string. Mirrors CompanyCandidate.domain server-side. */
function urlToDomain(url: string): string | null {
  try {
    const withScheme = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    const u = new URL(withScheme);
    const host = u.hostname;
    if (!host || !host.includes(".")) return null;
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return null;
  }
}

export default function ExpandModal({
  sourceNode,
  existingNodes,
  onClose,
  onAdd,
}: Props) {
  const [candidates, setCandidates] = useState<ExpandCandidate[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sourceNode.indexId) {
      setLoadState("error");
      setErrorMsg("This specimen hasn't finished indexing yet.");
      return;
    }
    const ctrl = new AbortController();
    controllerRef.current = ctrl;
    (async () => {
      try {
        const cands = await fetchExpansionCandidates(
          sourceNode.domain,
          sourceNode.indexId!,
          existingNodes,
          ctrl.signal,
        );
        if (ctrl.signal.aborted) return;
        // Backend guarantees every returned candidate has a usable homepage_url
        // (it rejects candidates without one before sending them). Still, be
        // defensive: filter client-side too in case of schema drift.
        const usable = cands.filter(
          (c) => !!c.homepage_url && !!urlToDomain(c.homepage_url),
        );
        setCandidates(usable);
        setLoadState(usable.length === 0 ? "empty" : "ready");
        // Default: pre-check every *non-colliding* candidate. Collided ones
        // would be silently dropped downstream anyway (the reducer dedupes by
        // domain); pre-checking them would be a promise the UI can't keep.
        const initial: Record<string, boolean> = {};
        for (const c of usable) {
          if (!c.collides_with) initial[c.name] = true;
        }
        setSelected(initial);
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setErrorMsg((e as Error).message || "Could not fetch candidates");
          setLoadState("error");
        }
      }
    })();

    return () => {
      ctrl.abort();
    };
  }, [sourceNode.domain, sourceNode.indexId, existingNodes]);

  // Esc to close
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const selectedCount = Object.values(selected).filter(Boolean).length;

  const handleAdd = () => {
    const accepted = candidates.filter((c) => selected[c.name]);
    const resolved: Record<string, { name: string; url: string; domain: string }> = {};
    for (const c of accepted) {
      if (!c.homepage_url) continue;
      const domain = urlToDomain(c.homepage_url);
      if (!domain) continue;
      resolved[c.name] = { name: c.name, url: c.homepage_url, domain };
    }
    if (Object.keys(resolved).length === 0) return;
    onAdd(
      accepted.filter((c) => resolved[c.name]),
      resolved,
    );
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[80vh] w-[min(640px,92vw)] flex-col rounded-[18px] border border-[rgba(140,200,255,0.12)] bg-[linear-gradient(180deg,rgba(10,18,40,0.92),rgba(3,6,16,0.95))] shadow-[0_20px_60px_rgba(0,0,0,0.6)] backdrop-blur-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="pointer-events-none absolute left-0 right-0 top-0 h-px bg-[linear-gradient(90deg,transparent,rgba(0,229,255,0.5),transparent)]" />

        <header className="flex items-start justify-between gap-4 border-b border-[rgba(140,200,255,0.08)] px-5 py-4">
          <div>
            <div className="mb-[6px] font-mono text-[9.5px] uppercase tracking-[0.22em] text-[var(--cyan-soft)]">
              Deeper survey
            </div>
            <div className="font-[var(--font-display)] text-[19px] leading-[1.2] text-[var(--fg)]">
              More specimens near{" "}
              <span className="text-[var(--cyan-soft)]">{sourceNode.name}</span>
            </div>
            <div className="mt-1 text-[12px] leading-[1.5] text-[var(--fg-dim)]">
              Other companies mentioned in {sourceNode.name}&apos;s indexed corpus.
              Each has a verbatim quote from that source.
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="text-[var(--fg-faint)] text-lg font-mono hover:text-[var(--fg)]"
          >
            ✕
          </button>
        </header>

        <div className="abyss-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {loadState === "loading" && (
            <div className="py-8 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-[var(--fg-faint)]">
              Scanning corpus…
            </div>
          )}
          {loadState === "error" && (
            <div className="rounded-md border border-red-400/30 bg-red-400/5 px-3 py-2 text-xs text-red-300">
              {errorMsg ?? "Could not fetch candidates"}
            </div>
          )}
          {loadState === "empty" && (
            <div className="py-8 text-center text-sm text-[var(--fg-dim)]">
              No new specimens found in this corpus.
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-[var(--fg-faint)]">
                The page mostly references things already in the graph.
              </div>
            </div>
          )}
          {loadState === "ready" && (
            <ul className="flex flex-col gap-2">
              {candidates.map((c) => {
                const isSelected = !!selected[c.name];
                const collides = !!c.collides_with;
                return (
                  <li
                    key={c.name}
                    className={`flex items-start gap-3 rounded-[10px] border px-3 py-[10px] transition ${
                      collides
                        ? "border-[rgba(140,200,255,0.06)] bg-[rgba(10,18,40,0.2)] opacity-55"
                        : "border-[rgba(140,200,255,0.1)] bg-[rgba(10,18,40,0.4)] hover:border-[rgba(0,229,255,0.3)]"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={collides}
                      onChange={() =>
                        setSelected((s) => ({ ...s, [c.name]: !s[c.name] }))
                      }
                      className="mt-[3px] h-4 w-4 shrink-0 accent-[var(--cyan)] disabled:cursor-not-allowed"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span className="truncate font-[var(--font-display)] text-[15px] text-[var(--fg)]">
                          {c.name}
                        </span>
                        <a
                          href={c.homepage_url!}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="truncate font-mono text-[10px] text-[var(--fg-dim)] hover:text-[var(--cyan-soft)]"
                        >
                          {c.homepage_url}
                        </a>
                      </div>
                      {collides && (
                        <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--fg-faint)]">
                          already in graph as{" "}
                          <span className="text-[var(--cyan-soft)]">
                            {c.collides_with}
                          </span>
                        </div>
                      )}
                      <div className="mt-1 text-[12px] italic leading-[1.5] text-[#b9cce8]">
                        “{c.evidence_quote}”
                      </div>
                      <a
                        href={c.source_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mt-1 inline-block font-mono text-[9.5px] tracking-[0.12em] text-[var(--cyan-soft)] opacity-85 hover:opacity-100 hover:underline"
                      >
                        src ↗
                      </a>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <footer className="flex items-center justify-between gap-3 border-t border-[rgba(140,200,255,0.08)] px-5 py-3">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-faint)]">
            {loadState === "ready"
              ? `${selectedCount} of ${candidates.length} selected`
              : ""}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-[10px] border border-[rgba(140,200,255,0.12)] bg-[rgba(10,18,40,0.4)] px-3 py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--fg-dim)] hover:text-[var(--fg)]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleAdd}
              disabled={loadState !== "ready" || selectedCount === 0}
              className="rounded-[10px] border border-[rgba(0,229,255,0.4)] bg-[linear-gradient(180deg,rgba(0,229,255,0.18),rgba(0,229,255,0.06))] px-3 py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--cyan-soft)] shadow-[0_0_24px_rgba(0,229,255,0.15),inset_0_0_20px_rgba(0,229,255,0.06)] hover:bg-[linear-gradient(180deg,rgba(0,229,255,0.28),rgba(0,229,255,0.1))] disabled:cursor-not-allowed disabled:opacity-40"
            >
              ⌁ Add {selectedCount > 0 ? selectedCount : ""} to graph
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
