import type { RelationshipType } from "./types";

// Bioluminescent palette from the design — used for edge colors and the Legend.
export const EDGE_COLOR: Record<RelationshipType, string> = {
  partner: "#00e5ff",
  competitor: "#ff8c64",
  investor: "#b19cff",
  downstream: "#5dcaa5",
  talent: "#f0c978",
  none: "#394b6a",
};
// Alias used by the GraphCanvas/SidePanel as the CSS hex source of truth.
export const EDGE_COLOR_HEX = EDGE_COLOR;

export const EDGE_LABEL: Record<RelationshipType, string> = {
  partner: "Partner",
  competitor: "Competitor",
  investor: "Investor",
  downstream: "Downstream",
  talent: "Talent",
  none: "None",
};

// Depth-zone palettes for the three.js scene. MVP only uses "abyss"; the others
// are here so a future toggle can swap them without changing component code.
export const ZONE_PALETTES = {
  abyss: {
    bgTop: 0x04081a,
    bgBot: 0x000105,
    fog: 0x02050d,
    ambient: 0x203855,
    rim: 0x7ab0e0,
    lure: 0x00e5ff,
    particles: 0x7fc6ff,
    body: 0x0c1a33,
    fogDens: 0.04,
  },
  twilight: {
    bgTop: 0x0e1f3f,
    bgBot: 0x030a1a,
    fog: 0x091a33,
    ambient: 0x1a2c55,
    rim: 0x5a7bc2,
    lure: 0x8ecaff,
    particles: 0xbcd4ff,
    body: 0x08102a,
    fogDens: 0.045,
  },
  vent: {
    bgTop: 0x1a0808,
    bgBot: 0x030000,
    fog: 0x0b0302,
    ambient: 0x1a0c0a,
    rim: 0xffa270,
    lure: 0xff5a28,
    particles: 0xffb38a,
    body: 0x0a0405,
    fogDens: 0.07,
  },
  sunlit: {
    bgTop: 0x0a3550,
    bgBot: 0x063046,
    fog: 0x0a3b55,
    ambient: 0x1a6088,
    rim: 0xaaeaff,
    lure: 0x9ff0ff,
    particles: 0xdff5ff,
    body: 0x06283a,
    fogDens: 0.035,
  },
} as const;

export const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8000";
