"""Feature 2 — click-to-expand endpoints.

Two endpoints:

1. `POST /v1/expand_from_node`  (synchronous)
   Given one indexed company and the list of companies currently in the graph,
   return candidates to add — other company/product names mentioned in that
   company's indexed corpus, with substring-validated evidence quotes and
   source URLs. No side effects, no persistence.

2. `POST /v1/expand/stream`  (SSE, POST-based so we can carry the candidate
    payload in a body rather than URL query params)
   Given a list of new candidates to add and the existing indexed set,
   index the new companies and extract edges *only* for pairs involving at
   least one new company. Existing pairs are untouched. Emits the same SSE
   event types as /query/stream plus one extra `expansion_context` frame up
   front carrying the provenance for the expansion.

Both endpoints reuse the existing indexer, extractor, and edge-persistence
helpers so staleness and crawl-version semantics from Feature 1 keep working.
"""

from __future__ import annotations

import json
import logging
import shlex
from itertools import combinations
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from sse_starlette.sse import EventSourceResponse

from app.clients.gemini import GeminiClient
from app.clients.humandelta import HumanDeltaClient
from app.models import CompanyCandidate, IndexedCompany
from app.services import edge_persist, temporal_store
from app.services.extractor import EdgeFoundEvent, PairSkippedEvent, extract_graph
from app.services.indexer import (
    IndexCompletedEvent,
    IndexFailedEvent,
    IndexStartedEvent,
    index_all,
)

log = logging.getLogger(__name__)
router = APIRouter()


# ---- /v1/expand_from_node ---------------------------------------------------

class ExpandFromNodeRequest(BaseModel):
    source_domain: str
    source_index_id: str
    # Names (or domains) currently in the graph — we won't propose any of these.
    exclusions: list[str] = Field(default_factory=list)


class ExpandCandidateOut(BaseModel):
    name: str
    evidence_quote: str
    source_url: str
    homepage_url: str | None = None


class ExpandFromNodeResponse(BaseModel):
    candidates: list[ExpandCandidateOut]


async def _resolve_quote_source_url(
    hd: HumanDeltaClient,
    domain: str,
    index_id: str,
    quote: str,
) -> str | None:
    """Locate the .md file the quote came from and convert to a real URL.

    Uses a distinctive snippet (first 40 chars) to minimize false matches.
    Returns None if grep finds no file — caller falls back to the domain root.
    """
    snippet = quote.strip()[:40]
    if not snippet:
        return None
    cmd = (
        f"grep -rl --include='*.md' {shlex.quote(snippet)} "
        f"/source/website/{domain} 2>/dev/null | head -n 1"
    )
    res = await hd.fs(index_id=index_id, cmd=cmd)
    stdout = (res.get("stdout") or "").strip()
    if not stdout:
        return None
    path = stdout.splitlines()[0]
    prefix = f"/source/website/{domain}/"
    if not path.startswith(prefix):
        return None
    tail = path[len(prefix):]
    if tail.endswith(".md"):
        tail = tail[:-3]
    return f"https://www.{domain}/{tail}".rstrip("/")


@router.post("/v1/expand_from_node", response_model=ExpandFromNodeResponse)
async def expand_from_node(req: ExpandFromNodeRequest) -> ExpandFromNodeResponse:
    hd = HumanDeltaClient()
    gemini = GeminiClient()
    try:
        # Pull a generous slice of the corpus (larger than the one-sentence summary).
        corpus = await hd.summarize_page(
            index_id=req.source_index_id,
            source_domain=req.source_domain,
            max_bytes=12_000,
        )
        if not corpus:
            raise HTTPException(
                status_code=404,
                detail=f"no indexed content for {req.source_domain}",
            )

        source_name_guess = req.source_domain.split(".")[0].capitalize()
        # Ensure the source company itself is never proposed. Include the domain
        # so the "same root" filter in suggest_expansion_candidates can use it.
        exclusions = list(req.exclusions) + [source_name_guess, req.source_domain]
        gemini_candidates = await gemini.suggest_expansion_candidates(
            source_company=source_name_guess,
            exclusions=exclusions,
            corpus_text=corpus,
        )

        out: list[ExpandCandidateOut] = []
        for c in gemini_candidates:
            source_url = await _resolve_quote_source_url(
                hd, req.source_domain, req.source_index_id, c.evidence_quote,
            )
            out.append(ExpandCandidateOut(
                name=c.name,
                evidence_quote=c.evidence_quote,
                source_url=source_url or f"https://www.{req.source_domain}",
                homepage_url=c.homepage_url,
            ))
        return ExpandFromNodeResponse(candidates=out)
    finally:
        await hd.aclose()


# ---- /v1/expand/stream ------------------------------------------------------

class IndexedCompanyInput(BaseModel):
    name: str
    url: str
    domain: str
    index_id: str
    page_count: int


class CandidateInput(BaseModel):
    name: str
    url: str
    domain: str


class ExpansionContext(BaseModel):
    """Identifies which company the expansion originated from. Per-candidate
    evidence lives client-side (it was returned by /v1/expand_from_node already).
    """
    source_name: str
    source_domain: str


class ExpandStreamRequest(BaseModel):
    context: ExpansionContext
    existing_indexed: list[IndexedCompanyInput] = Field(default_factory=list)
    new_candidates: list[CandidateInput] = Field(min_length=1)


def _sse(event: str, payload: dict) -> dict:
    return {"event": event, "data": json.dumps(payload)}


async def _expand_pipeline(req: ExpandStreamRequest) -> AsyncIterator[dict]:
    hd = HumanDeltaClient()
    gemini = GeminiClient()
    try:
        # Emit the provenance context up-front so the frontend can tag any
        # index_* events that follow with "discovered via {context}".
        yield _sse("expansion_context", req.context.model_dump())

        existing = [
            IndexedCompany(
                name=e.name, url=e.url, domain=e.domain,
                index_id=e.index_id, page_count=e.page_count,
            )
            for e in req.existing_indexed
        ]
        new_cands = [
            CompanyCandidate(name=c.name, url=c.url) for c in req.new_candidates
        ]

        # Versions for *existing* companies are already recorded in the temporal
        # store (or will be lazily backfilled when latest_version_or_backfill
        # fires on a cache hit). Seed the lookup up-front.
        version_by_domain: dict[str, int] = {}
        for e in existing:
            v = await temporal_store.latest_version_or_backfill(
                e.domain, e.index_id, e.page_count,
            )
            version_by_domain[e.domain] = v

        # Index *only* the new candidates.
        new_indexed: list[IndexedCompany] = []
        fresh_sources: dict[str, int] = {}
        async for ev in index_all(hd, new_cands):
            if isinstance(ev, IndexStartedEvent):
                yield _sse("index_started", {
                    "name": ev.company.name,
                    "domain": ev.company.domain,
                    "index_id": ev.index_id,
                })
            elif isinstance(ev, IndexCompletedEvent):
                new_indexed.append(ev.indexed)
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

        if not new_indexed:
            yield _sse("done", {"companies": 0, "edges": 0})
            return

        # Pairs: every pair where at least one side is a freshly-added company.
        # combinations(all, 2) minus (existing, existing) pairs.
        all_indexed = existing + new_indexed
        existing_domains = {e.domain for e in existing}
        pairs = [
            (a, b) for a, b in combinations(all_indexed, 2)
            if a.domain not in existing_domains or b.domain not in existing_domains
        ]

        name_to_domain: dict[str, str] = {c.name: c.domain for c in all_indexed}
        fresh_edge_keys_by_source: dict[str, set[tuple[str, str, str]]] = {}
        edge_count = 0

        async for ev in extract_graph(hd, gemini, pairs):
            if isinstance(ev, EdgeFoundEvent):
                edge_count += 1
                yield _sse("edge_found", ev.edge.model_dump())
                await edge_persist.persist_and_track(
                    edge=ev.edge,
                    name_to_domain=name_to_domain,
                    version_by_domain=version_by_domain,
                    fresh_edge_keys_by_source=fresh_edge_keys_by_source,
                )
            elif isinstance(ev, PairSkippedEvent):
                log.debug(
                    "pair skipped during expansion: %s + %s (%s)",
                    ev.source, ev.target, ev.reason,
                )

        # Staleness tracking — only for freshly-crawled sources (i.e. the newly-
        # added companies). Existing companies' edges are never touched here;
        # their corpora weren't re-crawled.
        for src_domain, version in fresh_sources.items():
            try:
                await temporal_store.mark_stale(
                    src_domain,
                    fresh_edge_keys_by_source.get(src_domain, set()),
                    version,
                )
            except Exception:  # noqa: BLE001
                log.exception("mark_stale failed for %s during expansion", src_domain)

        yield _sse("done", {"companies": len(new_indexed), "edges": edge_count})
    finally:
        await hd.aclose()


@router.post("/v1/expand/stream")
async def expand_stream(req: ExpandStreamRequest) -> EventSourceResponse:
    return EventSourceResponse(_expand_pipeline(req))
