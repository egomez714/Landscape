"use client";

import { useState } from "react";

import type { ViewMode } from "@/lib/types";

type Props = {
  mode: ViewMode;
  onModeChange: (m: ViewMode) => void;
  queriesRun: number;
  totalSpecimens: number;
  onClear: () => Promise<void> | void;
  disabled?: boolean;
};

/** View-mode toggle + accumulated-query counter + clear-all button.
 *
 * Sits in the header alongside the telemetry chips. Intentionally small —
 * the memory feature is a "what's next" layer, not the demo's hero surface.
 */
export default function ResearchControls({
  mode,
  onModeChange,
  queriesRun,
  totalSpecimens,
  onClear,
  disabled,
}: Props) {
  const [confirming, setConfirming] = useState(false);

  const onConfirmClear = async () => {
    await onClear();
    setConfirming(false);
  };

  return (
    <div className="flex items-center gap-[10px] font-mono text-[10.5px] uppercase tracking-[0.18em] text-[var(--fg-faint)]">
      <span
        className="inline-flex items-center gap-[6px] rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(8,14,30,0.55)] px-[10px] py-[5px] text-[var(--fg-dim)] backdrop-blur"
        title="Queries stored in this browser's research memory"
      >
        Queries <b className="font-medium text-[var(--fg)]">{queriesRun}</b>
      </span>

      <div
        className="inline-flex overflow-hidden rounded-full border border-[rgba(140,200,255,0.12)] bg-[rgba(8,14,30,0.55)] backdrop-blur"
        role="radiogroup"
        aria-label="Graph view mode"
      >
        <button
          type="button"
          role="radio"
          aria-checked={mode === "current"}
          disabled={disabled}
          onClick={() => onModeChange("current")}
          className={`px-[10px] py-[5px] transition ${
            mode === "current"
              ? "bg-[rgba(0,229,255,0.18)] text-[var(--cyan-soft)]"
              : "text-[var(--fg-dim)] hover:text-[var(--fg)]"
          }`}
          title="Show only the current query"
        >
          This query
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === "all"}
          disabled={disabled || queriesRun === 0}
          onClick={() => onModeChange("all")}
          className={`px-[10px] py-[5px] transition disabled:opacity-40 ${
            mode === "all"
              ? "bg-[rgba(0,229,255,0.18)] text-[var(--cyan-soft)]"
              : "text-[var(--fg-dim)] hover:text-[var(--fg)]"
          }`}
          title="Show accumulated graph across every query"
        >
          All research
          {mode === "all" && totalSpecimens > 0 && (
            <span className="ml-[6px] font-medium text-[var(--fg)]">
              {totalSpecimens}
            </span>
          )}
        </button>
      </div>

      {confirming ? (
        <span className="inline-flex items-center gap-[6px] rounded-full border border-red-400/30 bg-red-400/10 px-[10px] py-[5px] text-red-200">
          <span className="tracking-[0.16em]">Clear everything?</span>
          <button
            type="button"
            onClick={onConfirmClear}
            className="font-medium text-red-100 hover:underline"
          >
            Yes
          </button>
          <span className="opacity-40">·</span>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="font-medium text-red-200/80 hover:underline"
          >
            Cancel
          </button>
        </span>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={disabled || queriesRun === 0}
          className="inline-flex items-center gap-[6px] rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(8,14,30,0.55)] px-[10px] py-[5px] text-[var(--fg-dim)] backdrop-blur transition hover:text-[var(--fg)] disabled:cursor-not-allowed disabled:opacity-40"
          title="Wipe stored queries / companies / edges"
        >
          Clear
        </button>
      )}
    </div>
  );
}
