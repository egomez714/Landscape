import { EDGE_COLOR, EDGE_LABEL } from "@/lib/graph";
import type { RelationshipType } from "@/lib/types";

const TYPES: RelationshipType[] = [
  "partner",
  "competitor",
  "uses",
  "customer",
];

export default function Legend() {
  return (
    <div className="inline-flex items-center gap-4 rounded-full border border-[rgba(140,200,255,0.08)] bg-[rgba(10,18,40,0.5)] px-4 py-2 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--fg-dim)] backdrop-blur">
      {TYPES.map((t) => (
        <div
          key={t}
          className="inline-flex items-center gap-[7px]"
          style={{ color: EDGE_COLOR[t] }}
        >
          <span
            className="inline-block h-[2px] w-[18px] rounded-[2px]"
            style={{
              background: EDGE_COLOR[t],
              boxShadow: `0 0 6px ${EDGE_COLOR[t]}`,
            }}
          />
          <span>{EDGE_LABEL[t]}</span>
        </div>
      ))}
    </div>
  );
}
