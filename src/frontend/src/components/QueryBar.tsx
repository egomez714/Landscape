"use client";

import { useState } from "react";

type Props = {
  onSubmit: (query: string) => void;
  disabled?: boolean;
  initialValue?: string;
};

const SUGGESTIONS = [
  "vector database companies",
  "AI agent infrastructure companies",
  "prediction market platforms",
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
      className="flex flex-col gap-2"
    >
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Map an industry — e.g. 'vector database companies'"
            disabled={disabled}
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-4 py-2.5 text-[15px] text-[#e6f1fb] placeholder:text-[#5e6b88] focus:border-[#00d9ff]/50 focus:outline-none focus:ring-1 focus:ring-[#00d9ff]/30 disabled:opacity-50"
          />
        </div>
        <button
          type="submit"
          disabled={disabled || value.trim().length < 3}
          className="rounded-lg bg-[#00d9ff] px-4 py-2.5 text-sm font-medium text-[#0a0e1a] hover:bg-[#3ee3ff] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {disabled ? "Building…" : "Map"}
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-[#8892b0]">
        <span>Try:</span>
        {SUGGESTIONS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setValue(s);
              if (!disabled) onSubmit(s);
            }}
            disabled={disabled}
            className="rounded-full border border-white/5 bg-white/[0.02] px-2.5 py-0.5 hover:border-white/20 hover:text-[#c8d4eb] disabled:opacity-40"
          >
            {s}
          </button>
        ))}
      </div>
    </form>
  );
}
