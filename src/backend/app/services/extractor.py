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
    # Gather evidence from BOTH corpora. Previously we picked one direction by
    # line count and threw the rest away; that collapsed to whichever side had
    # the bigger crawl and silently produced wrong-direction `uses` edges when
    # the "winning" direction was a migrate or compare page. Now both sides go
    # to the LLM tagged with their page_type, and the model picks direction.
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
    if not ev_ab and not ev_ba:
        return PairSkippedEvent(source=a.name, target=b.name, reason="no_evidence")

    edge = await gemini.extract_relationship(
        a_name=a.name,
        b_name=b.name,
        evidence_a_to_b=ev_ab,
        evidence_b_to_a=ev_ba,
    )
    if edge is None:
        return PairSkippedEvent(
            source=a.name, target=b.name, reason="error_or_hallucinated",
        )
    if edge.type == "none":
        return PairSkippedEvent(source=a.name, target=b.name, reason="none_classification")

    # Map LLM-picked direction back to (source, target). `symmetric` falls
    # through to a_to_b — the GraphEdge only has two slots and the UI doesn't
    # distinguish symmetric visually, so picking A as source is consistent
    # with the prompt's convention that A is the first-named entity.
    if edge.direction == "b_to_a":
        src, tgt = b, a
    else:
        src, tgt = a, b

    # Snippet source matches the direction the LLM chose, so users clicking the
    # quote land on the page the model actually used to justify it. Fall back
    # to the combined pool if the quote doesn't substring-match the primary
    # direction (rare; usually means the LLM picked a quote from the other
    # corpus for a `symmetric` classification).
    primary_evidence = ev_ab if src is a else ev_ba
    secondary_evidence = ev_ba if src is a else ev_ab
    snippets = _build_evidence_snippets(
        edge.evidence_quote, primary_evidence, secondary_evidence,
    )
    return EdgeFoundEvent(edge=GraphEdge(
        source=src.name,
        target=tgt.name,
        type=edge.type,
        confidence=edge.confidence,
        evidence=snippets,
    ))


def _build_evidence_snippets(
    primary_quote: str,
    primary_evidence: list[EvidenceLine],
    secondary_evidence: list[EvidenceLine] = (),  # type: ignore[assignment]
    max_total: int = 3,
) -> list[EvidenceSnippet]:
    """Return up to `max_total` snippets. The first matches the LLM's chosen
    quote (searched in primary first, then secondary). Remaining slots fill
    from the primary pool, then the secondary, preserving order."""
    pq = primary_quote.lower().strip()
    pool_primary = list(primary_evidence)
    pool_secondary = list(secondary_evidence)

    primary_idx = next(
        (i for i, e in enumerate(pool_primary) if pq and pq in e.text.lower()),
        None,
    )
    secondary_idx: int | None = None
    if primary_idx is None:
        secondary_idx = next(
            (i for i, e in enumerate(pool_secondary) if pq and pq in e.text.lower()),
            None,
        )

    ordered: list[EvidenceLine] = []
    if primary_idx is not None:
        ordered.append(pool_primary[primary_idx])
        ordered.extend(e for i, e in enumerate(pool_primary) if i != primary_idx)
        ordered.extend(pool_secondary)
    elif secondary_idx is not None:
        ordered.append(pool_secondary[secondary_idx])
        ordered.extend(pool_primary)
        ordered.extend(e for i, e in enumerate(pool_secondary) if i != secondary_idx)
    else:
        ordered = pool_primary + pool_secondary
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
