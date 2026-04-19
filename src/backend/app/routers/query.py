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
from app.services import temporal_store
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
        # Track which domains got a fresh crawl this run (candidates for staleness
        # detection at the end) and map every indexed domain to its current version
        # (needed when we persist edges keyed by source_domain).
        indexed: list[IndexedCompany] = []
        fresh_sources: dict[str, int] = {}
        version_by_domain: dict[str, int] = {}
        async for ev in index_all(hd, candidates):
            if isinstance(ev, IndexStartedEvent):
                yield _sse("index_started", {
                    "name": ev.company.name,
                    "domain": ev.company.domain,
                    "index_id": ev.index_id,
                })
            elif isinstance(ev, IndexCompletedEvent):
                indexed.append(ev.indexed)
                version_by_domain[ev.indexed.domain] = ev.crawl_version
                if ev.is_fresh:
                    fresh_sources[ev.indexed.domain] = ev.crawl_version
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
        # While streaming, persist every edge to the temporal store so that re-runs
        # can detect which edges survived and which went stale.
        name_to_domain: dict[str, str] = {c.name: c.domain for c in indexed}
        fresh_edge_keys_by_source: dict[str, set[tuple[str, str, str]]] = {}
        edge_count = 0
        async for ev in extract_graph(hd, gemini, indexed):
            if isinstance(ev, EdgeFoundEvent):
                edge_count += 1
                yield _sse("edge_found", ev.edge.model_dump())
                # Persist. If the display-name → domain resolution fails for either
                # endpoint, warn and skip — never write a row with a guessed domain.
                src_dom = name_to_domain.get(ev.edge.source)
                tgt_dom = name_to_domain.get(ev.edge.target)
                if not src_dom or not tgt_dom:
                    log.warning(
                        "name→domain resolution failed for edge %s→%s; skipping persistence",
                        ev.edge.source, ev.edge.target,
                    )
                    continue
                version = version_by_domain.get(src_dom)
                if version is None:
                    log.warning(
                        "no known crawl version for source domain %s; skipping persistence",
                        src_dom,
                    )
                    continue
                try:
                    await temporal_store.upsert_edge(src_dom, tgt_dom, ev.edge, version)
                except Exception:  # noqa: BLE001
                    log.exception("upsert_edge failed for %s→%s", src_dom, tgt_dom)
                    continue
                fresh_edge_keys_by_source.setdefault(src_dom, set()).add(
                    (src_dom, tgt_dom, ev.edge.type)
                )
            elif isinstance(ev, PairSkippedEvent):
                log.debug("pair skipped: %s + %s (%s)", ev.source, ev.target, ev.reason)

        # Step 4.5: staleness. For each domain that got a fresh crawl this run, mark
        # any previously-known edges from that source that weren't re-seen as stale.
        # Cache-hit domains are skipped — their corpora didn't change, so their
        # edges' status must not be touched.
        for src_domain, version in fresh_sources.items():
            try:
                await temporal_store.mark_stale(
                    src_domain,
                    fresh_edge_keys_by_source.get(src_domain, set()),
                    version,
                )
            except Exception:  # noqa: BLE001
                log.exception("mark_stale failed for %s", src_domain)

        # Step 5: done.
        yield _sse("done", {"companies": len(indexed), "edges": edge_count})
    finally:
        await hd.aclose()


@router.get("/query/stream")
async def query_stream(q: str = Query(..., min_length=3, max_length=200)) -> EventSourceResponse:
    """Stream the full pipeline for a query. Frontend consumes via EventSource."""
    return EventSourceResponse(_pipeline(q))
