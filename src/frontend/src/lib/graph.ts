import type { RelationshipType } from "./types";

// Colors from CLAUDE.md UI notes. Used in Cytoscape styles and the Legend.
export const EDGE_COLOR: Record<RelationshipType, string> = {
  partner: "#00d9ff",
  competitor: "#ff8c64",
  investor: "#b19cff",
  downstream: "#5dcaa5",
  talent: "#f0c978",
  none: "#394b6a", // unreachable in practice — we drop "none" before rendering
};

export const EDGE_LABEL: Record<RelationshipType, string> = {
  partner: "Partner",
  competitor: "Competitor",
  investor: "Investor",
  downstream: "Downstream",
  talent: "Talent",
  none: "None",
};

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";

// Scale node size by crawled page count — companies with more content get bigger nodes.
export function nodeDiameter(pageCount: number | undefined): number {
  const base = 28;
  if (!pageCount) return base;
  return Math.min(72, base + Math.sqrt(pageCount) * 6);
}

// Node style by indexing status — pending/started are faded, completed pops, failed dims red.
export function nodeBorderColor(
  status: "pending" | "started" | "completed" | "failed",
): string {
  switch (status) {
    case "completed":
      return "#e6f1fb";
    case "failed":
      return "#ff6b6b";
    case "started":
      return "#8a9fc0";
    default:
      return "#394b6a";
  }
}

export function nodeOpacity(
  status: "pending" | "started" | "completed" | "failed",
): number {
  switch (status) {
    case "completed":
      return 1;
    case "failed":
      return 0.35;
    case "started":
      return 0.7;
    default:
      return 0.5;
  }
}
