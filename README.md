# Landscape

Turn any industry into a live, grounded knowledge graph. Type a query — "AI agent infrastructure companies" — and Landscape indexes each candidate company through Human Delta, extracts relationships from the indexed content via Gemini, and renders a force-directed Cytoscape graph where every edge is citable.

Solo build for FullyHacks 2026, targeting the Human Delta sponsor prize. Full spec and 24-hour schedule in [`CLAUDE.md`](./CLAUDE.md).

## Run locally

Prereqs: `uv`, Node 20+, and `src/backend/.env` with `HD_API_KEY` + `GEMINI_API_KEY` (see `.env.example` at repo root).

```bash
# backend
cd src/backend
uv sync
uv run uvicorn app.main:app --reload --port 8000

# frontend (separate terminal)
cd src/frontend
npm install
npm run dev
```

Open http://localhost:3000 — you should see the backend health JSON rendered on a dark page.

## Layout

```
src/backend/   FastAPI, Human Delta + Gemini clients
src/frontend/  Next.js 16 + Tailwind v4 + Cytoscape.js (fcose layout)
docs/          API notes captured during Explorer testing
CLAUDE.md      Full build plan — read this first
```
