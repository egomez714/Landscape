"use client";

import type { CompanyNode, StreamPhase } from "@/lib/types";

type Props = {
  phase: StreamPhase;
  companies: Record<string, CompanyNode>;
  edgeCount: number;
  error?: { stage: string; message: string } | null;
};

export default function StatusBar({
  phase,
  companies,
  edgeCount,
  error,
}: Props) {
  const total = Object.keys(companies).length;
  const completed = Object.values(companies).filter(
    (c) => c.status === "completed",
  ).length;
  const failed = Object.values(companies).filter(
    (c) => c.status === "failed",
  ).length;
  const started = Object.values(companies).filter(
    (c) => c.status === "started",
  ).length;

  let text: string;
  switch (phase) {
    case "idle":
      text = "Ready — type a query above.";
      break;
    case "parsing":
      text = "Parsing query via Gemini…";
      break;
    case "indexing":
      text = `Indexing ${completed + failed}/${total} via Human Delta · ${started} in flight`;
      break;
    case "extracting":
      text = `Extracting relationships · ${edgeCount} edges so far · ${completed}/${total} indexed`;
      break;
    case "done":
      text = `Done · ${completed} companies · ${edgeCount} edges${failed ? ` · ${failed} failed` : ""}`;
      break;
    case "error":
      text = `Error${error ? ` (${error.stage}): ${error.message}` : ""}`;
      break;
  }

  const color =
    phase === "error"
      ? "text-red-300"
      : phase === "done"
        ? "text-[#5dcaa5]"
        : "text-[#c8d4eb]";

  return (
    <div
      className={`flex items-center gap-2 rounded-full border border-white/5 bg-white/[0.03] px-4 py-2 text-xs ${color}`}
    >
      {phase !== "idle" && phase !== "done" && phase !== "error" && (
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-[#00d9ff]" />
      )}
      {text}
    </div>
  );
}
