"""Relationship extraction across pairs of indexed companies.

Given N indexed companies, walk all *unordered* pairs. For each pair:
  1. grep A's corpus for B's name (HumanDelta.find_cooccurrences)
  2. grep B's corpus for A's name
  3. merge evidence; if non-empty, call Gemini; keep non-"none" edges with verbatim quotes

Unordered halves the Gemini call count vs. ordered pairs. Since partnership/integration
edges are usually symmetric, the directional signal isn't worth 2x the calls.

Emits edges one at a time via async generator so the SSE stream stays responsive.
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator

from app.clients.gemini import GeminiClient
from app.clients.humandelta import EvidenceLine, HumanDeltaClient
from app.models import EvidenceSnippet, GraphEdge, IndexedCompany

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class EdgeFoundEvent:
    edge: GraphEdge


@dataclass(frozen=True)
class PairSkippedEvent:
    source: str
    target: str
    reason: str  # "no_evidence" | "none_classification" | "hallucinated_quote" | "error"


ExtractionEvent = EdgeFoundEvent | PairSkippedEvent


async def _extract_pair(
    hd: HumanDeltaClient,
    gemini: GeminiClient,
    a: IndexedCompany,
    b: IndexedCompany,
) -> ExtractionEvent:
    # Gather evidence from BOTH corpora; stronger signal than one-directional.
    ev_ab, ev_ba = await asyncio.gather(
        hd.find_cooccurrences(
            source_index_id=a.index_id,
            source_domain=a.domain,
            source_base_url=a.url,
            target_name=b.name,
        ),
        hd.find_cooccurrences(
            source_index_id=b.index_id,
            source_domain=b.domain,
            source_base_url=b.url,
            target_name=a.name,
        ),
    )
    # Pick the source direction with more evidence; that's the one we query Gemini on.
    if len(ev_ab) >= len(ev_ba):
        src, tgt, evidence = a, b, ev_ab
    else:
        src, tgt, evidence = b, a, ev_ba

    if not evidence:
        return PairSkippedEvent(source=a.name, target=b.name, reason="no_evidence")

    # Gemini sees only the text; URLs stay on our side.
    edge = await gemini.extract_relationship(
        source_name=src.name,
        target_name=tgt.name,
        evidence=[e.text for e in evidence],
    )
    if edge is None:
        return PairSkippedEvent(
            source=a.name, target=b.name, reason="error_or_hallucinated",
        )
    if edge.type == "none":
        return PairSkippedEvent(source=a.name, target=b.name, reason="none_classification")

    snippets = _build_evidence_snippets(edge.evidence_quote, evidence)
    return EdgeFoundEvent(edge=GraphEdge(
        source=src.name,
        target=tgt.name,
        type=edge.type,
        confidence=edge.confidence,
        evidence=snippets,
    ))


def _build_evidence_snippets(
    primary_quote: str,
    evidence: list[EvidenceLine],
    max_total: int = 3,
) -> list[EvidenceSnippet]:
    """Return up to `max_total` snippets. First matches the LLM's chosen quote; rest
    are the other grep lines, in order, for context."""
    pq = primary_quote.lower().strip()
    # Find the grep line that the LLM's quote came from — substring match, first wins.
    primary_idx = next(
        (i for i, e in enumerate(evidence) if pq and pq in e.text.lower()),
        None,
    )
    ordered: list[EvidenceLine] = []
    if primary_idx is not None:
        ordered.append(evidence[primary_idx])
        ordered.extend(e for i, e in enumerate(evidence) if i != primary_idx)
    else:
        ordered = list(evidence)
    return [
        EvidenceSnippet(text=e.text, source_url=e.source_url)
        for e in ordered[:max_total]
    ]


async def extract_graph(
    hd: HumanDeltaClient,
    gemini: GeminiClient,
    pairs: list[tuple[IndexedCompany, IndexedCompany]],
    *,
    concurrency: int = 4,
) -> AsyncIterator[ExtractionEvent]:
    """Extract edges for each given pair concurrently (capped).

    Callers build the pair list so they control scope — e.g. the initial query uses
    `combinations(indexed, 2)` (all pairs), whereas expansion uses only pairs where
    at least one side is a newly-added company (see app/routers/expand.py).
    """
    sem = asyncio.Semaphore(concurrency)

    async def guarded(a: IndexedCompany, b: IndexedCompany) -> ExtractionEvent:
        async with sem:
            try:
                return await _extract_pair(hd, gemini, a, b)
            except Exception as e:  # noqa: BLE001
                log.exception("extract_pair failed for %s + %s", a.name, b.name)
                return PairSkippedEvent(source=a.name, target=b.name, reason=f"error:{e}")

    tasks = [asyncio.create_task(guarded(a, b)) for a, b in pairs]
    try:
        for coro in asyncio.as_completed(tasks):
            yield await coro
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
