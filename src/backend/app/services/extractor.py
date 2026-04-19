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
from itertools import combinations
from typing import AsyncIterator

from app.clients.gemini import GeminiClient
from app.clients.humandelta import HumanDeltaClient
from app.models import GraphEdge, IndexedCompany

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
            source_index_id=a.index_id, source_domain=a.domain, target_name=b.name,
        ),
        hd.find_cooccurrences(
            source_index_id=b.index_id, source_domain=b.domain, target_name=a.name,
        ),
        return_exceptions=False,
    )
    # Pick the source direction with more evidence; that's the one we query Gemini on.
    if len(ev_ab) >= len(ev_ba):
        src, tgt, evidence = a, b, ev_ab
    else:
        src, tgt, evidence = b, a, ev_ba

    if not evidence:
        return PairSkippedEvent(source=a.name, target=b.name, reason="no_evidence")

    edge = await gemini.extract_relationship(
        source_name=src.name, target_name=tgt.name, evidence=evidence,
    )
    if edge is None:
        return PairSkippedEvent(
            source=a.name, target=b.name,
            reason="error_or_hallucinated",
        )
    if edge.type == "none":
        return PairSkippedEvent(source=a.name, target=b.name, reason="none_classification")

    return EdgeFoundEvent(edge=GraphEdge(
        source=src.name,
        target=tgt.name,
        type=edge.type,
        evidence_quote=edge.evidence_quote,
        confidence=edge.confidence,
    ))


async def extract_graph(
    hd: HumanDeltaClient,
    gemini: GeminiClient,
    indexed: list[IndexedCompany],
    *,
    concurrency: int = 4,
) -> AsyncIterator[ExtractionEvent]:
    """Extract edges for every unordered pair, concurrently (capped)."""
    sem = asyncio.Semaphore(concurrency)
    pairs = list(combinations(indexed, 2))

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
