import { EDGE_COLOR, EDGE_LABEL } from "@/lib/graph";
import type { RelationshipType } from "@/lib/types";

const RENDERED_TYPES: RelationshipType[] = [
  "partner",
  "competitor",
  "investor",
  "downstream",
  "talent",
];

export default function Legend() {
  return (
    <div className="flex items-center gap-4 rounded-full border border-white/5 bg-white/[0.03] px-4 py-2 text-xs text-[#c8d4eb]">
      {RENDERED_TYPES.map((t) => (
        <div key={t} className="flex items-center gap-1.5">
          <span
            className="inline-block h-[2px] w-5"
            style={{ background: EDGE_COLOR[t] }}
          />
          <span>{EDGE_LABEL[t]}</span>
        </div>
      ))}
    </div>
  );
}
