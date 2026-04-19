"""Shared helper for persisting an edge to the temporal store.

Extracted from app/routers/query.py so both the initial-query pipeline and the
expansion pipeline (Feature 2) use the same name→domain resolution, warn-and-skip
on failure, and fresh-edge-key tracking.
"""

from __future__ import annotations

import logging

from app.models import GraphEdge
from app.services import temporal_store

log = logging.getLogger(__name__)


async def persist_and_track(
    *,
    edge: GraphEdge,
    name_to_domain: dict[str, str],
    version_by_domain: dict[str, int],
    fresh_edge_keys_by_source: dict[str, set[tuple[str, str, str]]],
) -> None:
    """Upsert one GraphEdge into the temporal store and record its key under
    its source domain (for later mark_stale). Never writes a row with a guessed
    or null domain — failures log a warning and return.
    """
    src_dom = name_to_domain.get(edge.source)
    tgt_dom = name_to_domain.get(edge.target)
    if not src_dom or not tgt_dom:
        log.warning(
            "name→domain resolution failed for edge %s→%s; skipping persistence",
            edge.source, edge.target,
        )
        return
    version = version_by_domain.get(src_dom)
    if version is None:
        log.warning(
            "no known crawl version for source domain %s; skipping persistence",
            src_dom,
        )
        return
    try:
        await temporal_store.upsert_edge(src_dom, tgt_dom, edge, version)
    except Exception:  # noqa: BLE001
        log.exception("upsert_edge failed for %s→%s", src_dom, tgt_dom)
        return
    fresh_edge_keys_by_source.setdefault(src_dom, set()).add(
        (src_dom, tgt_dom, edge.type)
    )
