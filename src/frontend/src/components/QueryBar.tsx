"use client";

import { useState } from "react";

type Props = {
  onSubmit: (query: string) => void;
  disabled?: boolean;
  initialValue?: string;
};

const SUGGESTIONS = [
  "vector database companies",
  "AI agent infrastructure",
  "prediction market platforms",
  "carbon capture startups",
];

export default function QueryBar({
  onSubmit,
  disabled = false,
  initialValue = "",
}: Props) {
  const [value, setValue] = useState(initialValue);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const q = value.trim();
        if (q.length >= 3) onSubmit(q);
      }}
      className="flex flex-col gap-[10px]"
    >
      <div className="flex items-stretch gap-[10px]">
        <div className="relative flex flex-1 items-center rounded-[14px] border border-[rgba(140,200,255,0.08)] bg-[linear-gradient(180deg,rgba(10,18,40,0.65),rgba(4,8,20,0.55))] pl-11 pr-4 transition-[border-color,box-shadow] duration-300 focus-within:border-[rgba(0,229,255,0.35)] focus-within:shadow-[0_0_0_3px_rgba(0,229,255,0.08),inset_0_0_40px_rgba(0,229,255,0.05)] backdrop-blur-md min-h-[52px]">
          {/* radar dot */}
          <span className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 rounded-full border border-[var(--cyan)] shadow-[0_0_10px_rgba(0,229,255,0.4),inset_0_0_8px_rgba(0,229,255,0.25)]" />
          {/* sweeping radar line */}
          <span
            className="pointer-events-none absolute left-6 top-1/2 h-[14px] w-px bg-[linear-gradient(180deg,transparent,var(--cyan),transparent)] opacity-80"
            style={{ animation: "abyss-scan 2.4s linear infinite" }}
          />
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Map an industry — e.g. 'AI agent infrastructure companies'"
            disabled={disabled}
            className="flex-1 bg-transparent py-3 text-[15px] font-[var(--font-body)] text-[var(--fg)] outline-none placeholder:text-[#4a5c7d] disabled:opacity-60"
          />
        </div>
        <button
          type="submit"
          disabled={disabled || value.trim().length < 3}
          className="rounded-[14px] border border-[rgba(0,229,255,0.4)] bg-[linear-gradient(180deg,rgba(0,229,255,0.18),rgba(0,229,255,0.06))] px-[22px] font-mono text-[11px] font-medium uppercase tracking-[0.22em] text-[var(--cyan-soft)] shadow-[0_0_24px_rgba(0,229,255,0.15),inset_0_0_20px_rgba(0,229,255,0.06)] transition-[transform,background,box-shadow] hover:bg-[linear-gradient(180deg,rgba(0,229,255,0.28),rgba(0,229,255,0.1))] hover:shadow-[0_0_32px_rgba(0,229,255,0.3),inset_0_0_24px_rgba(0,229,255,0.1)] active:translate-y-[1px] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {disabled ? "… Diving" : "⌁ Dive"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-[var(--fg-faint)]">
        <span>Recent dives ›</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setValue(s);
              if (!disabled) onSubmit(s);
            }}
            disabled={disabled}
            className="rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(10,18,40,0.4)] px-[11px] py-[5px] text-[var(--fg-dim)] transition hover:border-[rgba(120,200,255,0.28)] hover:bg-[rgba(0,229,255,0.06)] hover:text-[var(--cyan-soft)] disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>
    </form>
  );
}
