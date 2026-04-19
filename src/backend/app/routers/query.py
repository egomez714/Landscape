"""SSE endpoint: GET /query/stream?q=... orchestrates the full pipeline.

Event types (values are the SSE `event:` field):
  companies_parsed   — once, with the list of candidates
  index_started      — per company, when its crawl job has been created
  index_completed    — per company, when its crawl finishes successfully
  index_failed       — per company, when its crawl errors or times out
  edge_found         — per extracted edge
  done               — once, with counts (companies, edges)
  error              — once, if the whole pipeline cannot proceed
"""

from __future__ import annotations

import json
import logging
from typing import AsyncIterator

from fastapi import APIRouter, Query
from sse_starlette.sse import EventSourceResponse

from app.clients.gemini import GeminiClient
from app.clients.humandelta import HumanDeltaClient
from app.models import IndexedCompany
from app.services.extractor import EdgeFoundEvent, PairSkippedEvent, extract_graph
from app.services.indexer import (
    IndexCompletedEvent,
    IndexFailedEvent,
    IndexStartedEvent,
    index_all,
)

log = logging.getLogger(__name__)
router = APIRouter()


def _sse(event: str, payload: dict) -> dict:
    return {"event": event, "data": json.dumps(payload)}


async def _pipeline(query_text: str) -> AsyncIterator[dict]:
    hd = HumanDeltaClient()
    gemini = GeminiClient()
    try:
        # Step 1: parse query.
        try:
            candidates = await gemini.parse_query(query_text)
        except Exception as e:  # noqa: BLE001
            log.exception("parse_query failed")
            yield _sse("error", {"stage": "parse_query", "message": str(e)})
            return

        if not candidates:
            yield _sse("error", {"stage": "parse_query", "message": "no candidates returned"})
            return

        yield _sse("companies_parsed", {
            "companies": [
                {"name": c.name, "url": c.url, "domain": c.domain}
                for c in candidates
            ],
        })

        # Step 2: parallel indexing; step 3: emit per-company events.
        indexed: list[IndexedCompany] = []
        async for ev in index_all(hd, candidates):
            if isinstance(ev, IndexStartedEvent):
                yield _sse("index_started", {
                    "name": ev.company.name,
                    "domain": ev.company.domain,
                    "index_id": ev.index_id,
                })
            elif isinstance(ev, IndexCompletedEvent):
                indexed.append(ev.indexed)
                yield _sse("index_completed", {
                    "name": ev.indexed.name,
                    "domain": ev.indexed.domain,
                    "page_count": ev.indexed.page_count,
                })
            elif isinstance(ev, IndexFailedEvent):
                yield _sse("index_failed", {
                    "name": ev.company.name,
                    "domain": ev.company.domain,
                    "reason": ev.reason,
                })

        if len(indexed) < 2:
            yield _sse("error", {
                "stage": "extraction",
                "message": f"only {len(indexed)} companies indexed successfully, need >=2",
            })
            yield _sse("done", {"companies": len(indexed), "edges": 0})
            return

        # Step 4: extract edges across unordered pairs; stream as they land.
        edge_count = 0
        async for ev in extract_graph(hd, gemini, indexed):
            if isinstance(ev, EdgeFoundEvent):
                edge_count += 1
                yield _sse("edge_found", ev.edge.model_dump())
            elif isinstance(ev, PairSkippedEvent):
                # Don't spam the client with skip events — debug only.
                log.debug("pair skipped: %s + %s (%s)", ev.source, ev.target, ev.reason)

        # Step 5: done.
        yield _sse("done", {"companies": len(indexed), "edges": edge_count})
    finally:
        await hd.aclose()


@router.get("/query/stream")
async def query_stream(q: str = Query(..., min_length=3, max_length=200)) -> EventSourceResponse:
    """Stream the full pipeline for a query. Frontend consumes via EventSource."""
    return EventSourceResponse(_pipeline(q))
