"""High-level API over the temporal DB (crawls + edges).

Keeps two load-bearing invariants:
  1. Crawl version is monotonically increasing per domain. First crawl = version 1.
  2. Staleness is scoped to a single source_domain. When we re-crawl X and an edge
     previously sourced from X is not re-seen, we mark that row stale. Edges
     sourced from some OTHER domain are never touched (their corpus didn't change).
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from app.models import GraphEdge
from app.services import db

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class CrawlRecord:
    version: int
    index_id: str
    page_count: int | None
    indexed_at: str


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ---- crawls ----

async def record_crawl(
    domain: str,
    index_id: str,
    page_count: int,
    *,
    indexed_at: str | None = None,
) -> int:
    """Insert a new crawl row; returns the newly-assigned version.

    Version is computed as MAX(version)+1 for this domain. The subquery + UNIQUE
    constraint combo means concurrent inserts either succeed with sequential
    versions or raise IntegrityError — not silently corrupt.
    """
    ts = indexed_at or _now_iso()
    sql = """
    INSERT INTO crawls (domain, index_id, version, page_count, indexed_at)
    VALUES (
      ?,
      ?,
      COALESCE((SELECT MAX(version) FROM crawls WHERE domain = ?), 0) + 1,
      ?,
      ?
    )
    RETURNING version
    """
    row = await db.write_fetchone(sql, (domain, index_id, domain, page_count, ts))
    if row is None:  # unreachable in practice; sqlite returns RETURNING on success
        raise RuntimeError(f"record_crawl failed for {domain}")
    return int(row[0])


async def latest_version(domain: str) -> int | None:
    """Return the most recent crawl version for a domain, or None if never seen."""
    conn = await db.read_connection()
    try:
        cur = await conn.execute(
            "SELECT MAX(version) FROM crawls WHERE domain = ?", (domain,),
        )
        row = await cur.fetchone()
        await cur.close()
        if row is None or row[0] is None:
            return None
        return int(row[0])
    finally:
        await conn.close()


async def latest_version_or_backfill(
    domain: str, index_id: str, page_count: int,
) -> int:
    """Used on cache hits: return latest version, or create a version=1 row if the
    DB knows nothing about this domain yet. Keeps the temporal store self-consistent
    with the existing JSON cache on first run after Feature 1 ships.
    """
    v = await latest_version(domain)
    if v is not None:
        return v
    return await record_crawl(domain, index_id, page_count)


async def get_crawl_history(domain: str) -> list[CrawlRecord]:
    conn = await db.read_connection()
    try:
        cur = await conn.execute(
            "SELECT version, index_id, page_count, indexed_at "
            "FROM crawls WHERE domain = ? ORDER BY version DESC",
            (domain,),
        )
        rows = await cur.fetchall()
        await cur.close()
        return [
            CrawlRecord(
                version=int(r["version"]),
                index_id=r["index_id"],
                page_count=int(r["page_count"]) if r["page_count"] is not None else None,
                indexed_at=r["indexed_at"],
            )
            for r in rows
        ]
    finally:
        await conn.close()


# ---- edges ----

async def upsert_edge(
    source_domain: str,
    target_domain: str,
    edge: GraphEdge,
    source_version: int,
) -> None:
    """Insert or update an edge row. On conflict, last_confirmed_at + confidence +
    evidence + last_source_version are refreshed; first_seen_at is preserved;
    status is reset to 'active' (a re-discovered edge cannot be stale).
    """
    now = _now_iso()
    evidence_json = json.dumps([e.model_dump() for e in edge.evidence])
    sql = """
    INSERT INTO edges (
      source_domain, target_domain, type, confidence, evidence_json,
      first_seen_at, last_confirmed_at, last_source_version, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
    ON CONFLICT(source_domain, target_domain, type) DO UPDATE SET
      confidence          = excluded.confidence,
      evidence_json       = excluded.evidence_json,
      last_confirmed_at   = excluded.last_confirmed_at,
      last_source_version = excluded.last_source_version,
      status              = 'active'
    """
    await db.write(sql, (
        source_domain, target_domain, edge.type, edge.confidence, evidence_json,
        now, now, source_version,
    ))


async def mark_stale(
    source_domain: str,
    fresh_edge_keys: set[tuple[str, str, str]],
    current_version: int,
) -> None:
    """Mark edges sourced from `source_domain` as stale if they weren't in the
    fresh set from the current crawl AND their last_source_version is strictly
    less than current_version (so we never mark an edge freshly-upserted in this
    same run as stale due to ordering).

    Only touches edges whose source_domain matches — other-source edges are
    untouched because their corpora weren't re-crawled.
    """
    conn = await db.read_connection()
    try:
        cur = await conn.execute(
            "SELECT source_domain, target_domain, type, last_source_version "
            "FROM edges WHERE source_domain = ? AND status = 'active'",
            (source_domain,),
        )
        rows = await cur.fetchall()
        await cur.close()
    finally:
        await conn.close()

    stmts: list[tuple[str, tuple]] = []
    for r in rows:
        key = (r["source_domain"], r["target_domain"], r["type"])
        if key in fresh_edge_keys:
            continue  # still present; upsert_edge kept it active
        if int(r["last_source_version"]) >= current_version:
            continue  # freshly-written this run, or from a newer version; leave alone
        stmts.append((
            "UPDATE edges SET status='stale' "
            "WHERE source_domain=? AND target_domain=? AND type=?",
            key,
        ))
    if stmts:
        await db.write_many(stmts)


async def active_edges_from(source_domain: str) -> list[dict]:
    """Return all active edges sourced from a domain (Feature 3 will use this)."""
    conn = await db.read_connection()
    try:
        cur = await conn.execute(
            "SELECT * FROM edges WHERE source_domain = ? AND status = 'active'",
            (source_domain,),
        )
        rows = await cur.fetchall()
        await cur.close()
        return [dict(r) for r in rows]
    finally:
        await conn.close()
