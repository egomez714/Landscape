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
      text = "Ready · drop a query to begin the dive";
      break;
    case "parsing":
      text = "Parsing query · mapping specimens";
      break;
    case "indexing":
      text = `Trawling · ${completed + failed}/${total} captured · ${started} in flight`;
      break;
    case "extracting":
      text = `Linking · ${edgeCount} relationships · ${completed}/${total} indexed`;
      break;
    case "done":
      if (edgeCount === 0 && completed >= 2) {
        text = `No public cross-mentions found · ${completed} specimens indexed · try a more open ecosystem`;
      } else {
        text = `Trawl complete · ${completed} specimens · ${edgeCount} links${
          failed ? ` · ${failed} lost` : ""
        }`;
      }
      break;
    case "error":
      text = `Error${error ? ` (${error.stage}): ${error.message}` : ""}`;
      break;
  }

  const beaconColor =
    phase === "error"
      ? "#ff6b6b"
      : phase === "done"
        ? "var(--green)"
        : "var(--cyan)";

  return (
    <div className="inline-flex items-center gap-[10px] rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(10,18,40,0.5)] px-[14px] py-2 font-mono text-[10.5px] uppercase tracking-[0.16em] text-[var(--fg-dim)] backdrop-blur">
      <span
        className="relative inline-block h-2 w-2 rounded-full"
        style={{
          background: beaconColor,
          boxShadow: `0 0 10px ${beaconColor}`,
        }}
      >
        {phase !== "error" && (
          <span
            className="absolute -inset-[4px] rounded-full border"
            style={{
              borderColor: beaconColor,
              animation: "abyss-ping 1.8s ease-out infinite",
            }}
          />
        )}
      </span>
      <span>Survey</span>
      <b className="font-medium text-[var(--fg)]">{text}</b>
    </div>
  );
}
