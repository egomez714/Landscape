"use client";

import { EDGE_COLOR, EDGE_LABEL } from "@/lib/graph";
import type { CompanyNode, GraphEdge } from "@/lib/types";

type Props = {
  selected: CompanyNode | null;
  edges: GraphEdge[];
  companies: Record<string, CompanyNode>;
  onSelect: (domain: string | null) => void;
};

export default function SidePanel({
  selected,
  edges,
  companies,
  onSelect,
}: Props) {
  if (!selected) {
    return (
      <div className="flex h-full flex-col gap-3 rounded-xl border border-white/5 bg-white/[0.02] p-5 text-sm text-[#8892b0]">
        <div className="text-[#e6f1fb] font-medium">No node selected</div>
        <p>
          Click a company in the graph to see its relationships and the
          verbatim passages that support them.
        </p>
      </div>
    );
  }

  const connected = edges.filter(
    (e) => e.source === selected.name || e.target === selected.name,
  );

  const statusLabel = {
    pending: "queued",
    started: "indexing",
    completed: "indexed",
    failed: "failed",
  }[selected.status];

  return (
    <div className="flex h-full flex-col gap-4 overflow-y-auto rounded-xl border border-white/5 bg-white/[0.02] p-5 text-sm">
      <div>
        <div className="text-lg font-semibold text-[#e6f1fb]">
          {selected.name}
        </div>
        <a
          href={selected.url}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all text-xs text-[#8892b0] hover:text-[#c8d4eb] underline underline-offset-2"
        >
          {selected.url}
        </a>
        <div className="mt-1 text-xs text-[#8892b0]">
          Status: {statusLabel}
          {selected.pageCount ? ` · ${selected.pageCount} pages indexed` : ""}
        </div>
        {selected.failReason && (
          <div className="mt-2 rounded-md border border-red-400/30 bg-red-400/5 px-2 py-1 text-xs text-red-300">
            {selected.failReason}
          </div>
        )}
      </div>

      <div className="border-t border-white/5 pt-3">
        <div className="mb-2 text-xs uppercase tracking-wide text-[#8892b0]">
          Relationships ({connected.length})
        </div>
        {connected.length === 0 ? (
          <div className="text-xs text-[#8892b0]">
            No relationships found in the indexed content.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {connected.map((edge, i) => {
              const otherName =
                edge.source === selected.name ? edge.target : edge.source;
              const otherDomain = Object.values(companies).find(
                (c) => c.name === otherName,
              )?.domain;
              return (
                <li
                  key={`${edge.source}-${edge.target}-${i}`}
                  className="rounded-lg border border-white/5 bg-white/[0.03] p-3"
                >
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className="inline-block h-2 w-2 rounded-full"
                      style={{ background: EDGE_COLOR[edge.type] }}
                    />
                    <span className="font-medium text-[#e6f1fb]">
                      {EDGE_LABEL[edge.type]}
                    </span>
                    <span className="text-[#8892b0]">[{edge.confidence}]</span>
                    <span className="ml-auto">
                      {otherDomain ? (
                        <button
                          type="button"
                          onClick={() => onSelect(otherDomain)}
                          className="text-[#c8d4eb] hover:text-[#e6f1fb] underline underline-offset-2"
                        >
                          {otherName}
                        </button>
                      ) : (
                        <span className="text-[#c8d4eb]">{otherName}</span>
                      )}
                    </span>
                  </div>
                  <div className="mt-2 text-xs italic text-[#b3c1d9]">
                    “{edge.evidence_quote}”
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
