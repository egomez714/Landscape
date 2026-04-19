"use client";

import cytoscape, { type Core, type ElementDefinition } from "cytoscape";
// @ts-expect-error — no types shipped
import fcose from "cytoscape-fcose";
import { useEffect, useMemo, useRef } from "react";

import {
  EDGE_COLOR,
  nodeBorderColor,
  nodeDiameter,
  nodeOpacity,
} from "@/lib/graph";
import type { CompanyNode, GraphEdge } from "@/lib/types";

if (typeof window !== "undefined") {
  try {
    cytoscape.use(fcose);
  } catch {
    // already registered on hot-reload — ignore
  }
}

type Props = {
  companies: Record<string, CompanyNode>;
  edges: GraphEdge[];
  selectedDomain: string | null;
  onSelect: (domain: string | null) => void;
};

const LAYOUT_DEBOUNCE_MS = 250;

export default function GraphCanvas({
  companies,
  edges,
  selectedDomain,
  onSelect,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const cyRef = useRef<Core | null>(null);
  const layoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const elements = useMemo<ElementDefinition[]>(() => {
    const nodes: ElementDefinition[] = Object.values(companies).map((c) => ({
      data: {
        id: c.domain,
        label: c.name,
        status: c.status,
        pageCount: c.pageCount ?? 0,
      },
    }));
    const edgeEls: ElementDefinition[] = edges.map((e, i) => ({
      data: {
        id: `${e.source}|${e.target}|${i}`,
        source: findDomain(companies, e.source) ?? e.source,
        target: findDomain(companies, e.target) ?? e.target,
        type: e.type,
        confidence: e.confidence,
      },
    }));
    return [...nodes, ...edgeEls];
  }, [companies, edges]);

  // Initialize Cytoscape once.
  useEffect(() => {
    if (!hostRef.current || cyRef.current) return;

    const cy = cytoscape({
      container: hostRef.current,
      elements: [],
      wheelSensitivity: 0.2,
      style: [
        {
          selector: "node",
          style: {
            "background-color": "#1a2542",
            "border-width": 2,
            "border-color": (ele: cytoscape.NodeSingular) =>
              nodeBorderColor(ele.data("status")),
            opacity: (ele: cytoscape.NodeSingular) => nodeOpacity(ele.data("status")),
            width: (ele: cytoscape.NodeSingular) => nodeDiameter(ele.data("pageCount")),
            height: (ele: cytoscape.NodeSingular) => nodeDiameter(ele.data("pageCount")),
            label: "data(label)",
            "font-size": 11,
            "font-family": "Inter, ui-sans-serif, system-ui",
            color: "#e6f1fb",
            "text-valign": "bottom",
            "text-margin-y": 6,
            "text-background-color": "#0a0e1a",
            "text-background-opacity": 0.75,
            "text-background-padding": "3px",
            "text-border-width": 0,
          },
        },
        {
          selector: "node:selected",
          style: {
            "border-color": "#ffffff",
            "border-width": 3,
            "background-color": "#2a3a66",
          },
        },
        {
          selector: "edge",
          style: {
            width: (ele: cytoscape.EdgeSingular) =>
              ele.data("confidence") === "high"
                ? 2.5
                : ele.data("confidence") === "medium"
                  ? 1.75
                  : 1,
            "line-color": (ele: cytoscape.EdgeSingular) =>
              EDGE_COLOR[ele.data("type") as keyof typeof EDGE_COLOR] ?? "#394b6a",
            "curve-style": "bezier",
            opacity: 0.85,
          },
        },
        {
          selector: "edge:selected",
          style: {
            opacity: 1,
            width: 3,
          },
        },
      ],
    });

    cy.on("tap", "node", (evt) => {
      onSelect(evt.target.id());
    });
    cy.on("tap", (evt) => {
      if (evt.target === cy) onSelect(null);
    });

    cyRef.current = cy;
  }, [onSelect]);

  // Sync elements into Cytoscape whenever state changes.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    cy.batch(() => {
      // Upsert: add new, update existing data.
      const seen = new Set<string>();
      for (const el of elements) {
        const id = el.data?.id as string;
        if (!id) continue;
        seen.add(id);
        const existing = cy.getElementById(id);
        if (existing.empty()) {
          cy.add(el);
        } else {
          existing.data(el.data);
        }
      }
      // Remove any elements no longer in the set (e.g. after a new query).
      cy.elements().forEach((el) => {
        if (!seen.has(el.id())) el.remove();
      });
    });

    // Debounced layout re-run.
    if (layoutTimerRef.current) clearTimeout(layoutTimerRef.current);
    layoutTimerRef.current = setTimeout(() => {
      if (cy.elements().length === 0) return;
      cy.layout({
        name: "fcose",
        animate: true,
        animationDuration: 450,
        nodeRepulsion: 6000,
        idealEdgeLength: 120,
        edgeElasticity: 0.35,
        gravity: 0.25,
        randomize: false,
        padding: 40,
        fit: true,
      } as cytoscape.LayoutOptions).run();
    }, LAYOUT_DEBOUNCE_MS);
  }, [elements]);

  // Reflect external selection (e.g. clicking in the side panel) into Cytoscape.
  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.$("node:selected").unselect();
    if (selectedDomain) {
      cy.getElementById(selectedDomain).select();
    }
  }, [selectedDomain]);

  return (
    <div
      ref={hostRef}
      className="h-full w-full rounded-xl border border-white/5 bg-[#060914]"
    />
  );
}

function findDomain(
  companies: Record<string, CompanyNode>,
  name: string,
): string | null {
  for (const c of Object.values(companies)) {
    if (c.name === name) return c.domain;
  }
  return null;
}
