"""Feature 1 — temporal_store tests.

The load-bearing test is `test_mark_stale_flags_dropped_edges`: it simulates a
second crawl of a domain where one prior edge is no longer discoverable, and
asserts the dropped row is flagged stale while its last_source_version sticks at
the prior value (so we can still tell when it was last confirmed).
"""

from __future__ import annotations

import pytest

from app.models import EvidenceSnippet, GraphEdge
from app.services import db, temporal_store


@pytest.fixture
async def tmp_db(tmp_path):
    await db.init(tmp_path / "test.db")
    try:
        yield
    finally:
        await db.close()


def _edge(src: str, tgt: str, type_: str = "partner") -> GraphEdge:
    return GraphEdge(
        source=src,
        target=tgt,
        type=type_,
        confidence="high",
        evidence=[EvidenceSnippet(text="x", source_url="https://example.com/p")],
    )


async def _edge_row(src: str, tgt: str, type_: str) -> dict | None:
    conn = await db.read_connection()
    try:
        cur = await conn.execute(
            "SELECT * FROM edges WHERE source_domain=? AND target_domain=? AND type=?",
            (src, tgt, type_),
        )
        row = await cur.fetchone()
        await cur.close()
        return dict(row) if row else None
    finally:
        await conn.close()


# ---- crawls ----

async def test_record_crawl_auto_increments_per_domain(tmp_db):
    v1 = await temporal_store.record_crawl("a.com", "idx1", 10)
    v2 = await temporal_store.record_crawl("a.com", "idx2", 11)
    v1b = await temporal_store.record_crawl("b.com", "idxb", 20)
    assert v1 == 1
    assert v2 == 2
    assert v1b == 1


async def test_latest_version(tmp_db):
    assert await temporal_store.latest_version("x.com") is None
    await temporal_store.record_crawl("x.com", "i", 0)
    assert await temporal_store.latest_version("x.com") == 1
    await temporal_store.record_crawl("x.com", "i", 0)
    assert await temporal_store.latest_version("x.com") == 2


async def test_latest_version_or_backfill(tmp_db):
    v = await temporal_store.latest_version_or_backfill("new.com", "ix", 5)
    assert v == 1
    # Re-calling returns existing, doesn't duplicate
    v2 = await temporal_store.latest_version_or_backfill("new.com", "ix", 5)
    assert v2 == 1
    assert await temporal_store.latest_version("new.com") == 1


async def test_get_crawl_history_newest_first(tmp_db):
    await temporal_store.record_crawl("a.com", "i1", 10)
    await temporal_store.record_crawl("a.com", "i2", 12)
    await temporal_store.record_crawl("a.com", "i3", 15)
    history = await temporal_store.get_crawl_history("a.com")
    assert [r.version for r in history] == [3, 2, 1]
    assert history[0].index_id == "i3"


async def test_get_crawl_history_unknown_domain_is_empty(tmp_db):
    assert await temporal_store.get_crawl_history("never-seen.com") == []


# ---- edges ----

async def test_upsert_preserves_first_seen_bumps_confirmed(tmp_db):
    await temporal_store.record_crawl("a.com", "idx", 10)
    e = _edge("A", "B")
    await temporal_store.upsert_edge("a.com", "b.com", e, source_version=1)
    r1 = await _edge_row("a.com", "b.com", "partner")
    assert r1 is not None
    first_seen = r1["first_seen_at"]
    first_confirmed = r1["last_confirmed_at"]

    await temporal_store.upsert_edge("a.com", "b.com", e, source_version=2)
    r2 = await _edge_row("a.com", "b.com", "partner")
    assert r2 is not None
    assert r2["first_seen_at"] == first_seen  # never changes after insert
    assert r2["last_confirmed_at"] >= first_confirmed
    assert r2["last_source_version"] == 2
    assert r2["status"] == "active"


async def test_mark_stale_flags_dropped_edges(tmp_db):
    """The one this whole feature hinges on. Two edges recorded at v1; v2 only
    sees one of them. The missing edge must be marked stale with
    last_source_version=1 (unchanged), status='stale'. The re-seen edge must be
    active with last_source_version=2.
    """
    await temporal_store.record_crawl("a.com", "idx1", 10)
    e_ab = _edge("A", "B", "partner")
    e_ac = _edge("A", "C", "competitor")
    await temporal_store.upsert_edge("a.com", "b.com", e_ab, source_version=1)
    await temporal_store.upsert_edge("a.com", "c.com", e_ac, source_version=1)

    # v2 crawl: simulate the extractor re-discovering only e_ab.
    await temporal_store.record_crawl("a.com", "idx2", 11)
    await temporal_store.upsert_edge("a.com", "b.com", e_ab, source_version=2)
    fresh_keys = {("a.com", "b.com", "partner")}
    await temporal_store.mark_stale("a.com", fresh_keys, current_version=2)

    r_ab = await _edge_row("a.com", "b.com", "partner")
    r_ac = await _edge_row("a.com", "c.com", "competitor")
    assert r_ab is not None
    assert r_ac is not None

    assert r_ab["status"] == "active"
    assert r_ab["last_source_version"] == 2

    assert r_ac["status"] == "stale"
    assert r_ac["last_source_version"] == 1  # unchanged — we never touched it this run


async def test_mark_stale_ignores_other_source_domains(tmp_db):
    """Staleness is scoped per source_domain. Re-crawling A must never flip an
    edge sourced from B, even if B's corpus also mentioned the target.
    """
    await temporal_store.record_crawl("a.com", "ixa", 10)
    await temporal_store.record_crawl("b.com", "ixb", 10)
    await temporal_store.upsert_edge("a.com", "c.com", _edge("A", "C"), source_version=1)
    await temporal_store.upsert_edge("b.com", "c.com", _edge("B", "C"), source_version=1)

    # Re-crawl only a.com and do NOT re-confirm any a-edges.
    await temporal_store.record_crawl("a.com", "ixa2", 11)
    await temporal_store.mark_stale("a.com", fresh_edge_keys=set(), current_version=2)

    r_a = await _edge_row("a.com", "c.com", "partner")
    r_b = await _edge_row("b.com", "c.com", "partner")
    assert r_a is not None and r_b is not None
    assert r_a["status"] == "stale"
    assert r_b["status"] == "active"  # untouched — its source wasn't re-crawled


async def test_mark_stale_does_not_flip_edges_fresh_this_run(tmp_db):
    """If an edge's last_source_version is already >= current_version, we must
    not flag it stale (guards against ordering bugs where mark_stale runs before
    all edges of the run are persisted).
    """
    await temporal_store.record_crawl("a.com", "idx", 10)
    e = _edge("A", "B")
    await temporal_store.upsert_edge("a.com", "b.com", e, source_version=1)

    # Deliberately simulate a bug where mark_stale is called without the fresh_keys
    # including this edge, but the edge was already upserted at current_version.
    await temporal_store.mark_stale("a.com", fresh_edge_keys=set(), current_version=1)

    r = await _edge_row("a.com", "b.com", "partner")
    assert r is not None
    assert r["status"] == "active"  # last_source_version >= current_version, safe


async def test_rediscovering_stale_edge_reactivates(tmp_db):
    """Upsert of an edge currently flagged stale must set it back to active."""
    await temporal_store.record_crawl("a.com", "ix1", 10)
    e = _edge("A", "B")
    await temporal_store.upsert_edge("a.com", "b.com", e, source_version=1)

    await temporal_store.record_crawl("a.com", "ix2", 10)
    await temporal_store.mark_stale("a.com", fresh_edge_keys=set(), current_version=2)
    r = await _edge_row("a.com", "b.com", "partner")
    assert r is not None and r["status"] == "stale"

    # v3: edge reappears
    await temporal_store.record_crawl("a.com", "ix3", 10)
    await temporal_store.upsert_edge("a.com", "b.com", e, source_version=3)
    r2 = await _edge_row("a.com", "b.com", "partner")
    assert r2 is not None
    assert r2["status"] == "active"
    assert r2["last_source_version"] == 3
