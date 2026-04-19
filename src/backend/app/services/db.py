"""Async SQLite connection management for the temporal store.

Design:
  - Writes go through a single module-level connection guarded by an asyncio Lock.
    Serialization is what prevents "database is locked" errors when the extractor
    fans out edge upserts in parallel (concurrency=4 in extractor.py).
  - Reads open transient connections. SQLite WAL mode allows concurrent readers
    with one writer, so reads never block writes or vice versa.
  - WAL + busy_timeout=5000 are applied on every connection.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import aiosqlite

from app.config import settings

log = logging.getLogger(__name__)

_db_path: Path | None = None
_write_conn: aiosqlite.Connection | None = None
_write_lock = asyncio.Lock()


_SCHEMA = """
CREATE TABLE IF NOT EXISTS crawls (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  domain        TEXT NOT NULL,
  index_id      TEXT NOT NULL,
  version       INTEGER NOT NULL,
  page_count    INTEGER,
  indexed_at    TEXT NOT NULL,
  UNIQUE (domain, version)
);
CREATE INDEX IF NOT EXISTS crawls_domain_desc ON crawls(domain, version DESC);

CREATE TABLE IF NOT EXISTS edges (
  source_domain       TEXT NOT NULL,
  target_domain       TEXT NOT NULL,
  type                TEXT NOT NULL,
  confidence          TEXT NOT NULL,
  evidence_json       TEXT NOT NULL,
  first_seen_at       TEXT NOT NULL,
  last_confirmed_at   TEXT NOT NULL,
  last_source_version INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (source_domain, target_domain, type)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(source_domain);
"""


async def _configure(conn: aiosqlite.Connection) -> None:
    await conn.execute("PRAGMA journal_mode=WAL")
    await conn.execute("PRAGMA busy_timeout=5000")
    await conn.execute("PRAGMA synchronous=NORMAL")
    conn.row_factory = aiosqlite.Row


async def init(path: Path | None = None) -> None:
    """Open the write connection, apply PRAGMAs, create schema. Idempotent."""
    global _db_path, _write_conn
    resolved = path or (settings.cache_dir / "landscape.db")
    resolved.parent.mkdir(parents=True, exist_ok=True)
    if _write_conn is not None and _db_path == resolved:
        return
    if _write_conn is not None:
        await _write_conn.close()
    _db_path = resolved
    _write_conn = await aiosqlite.connect(_db_path)
    await _configure(_write_conn)
    await _write_conn.executescript(_SCHEMA)
    await _write_conn.commit()
    log.info("temporal DB ready at %s", _db_path)


async def close() -> None:
    global _write_conn
    if _write_conn is not None:
        await _write_conn.close()
        _write_conn = None


async def read_connection() -> aiosqlite.Connection:
    """Open a fresh read connection. Caller is responsible for close()."""
    if _db_path is None:
        raise RuntimeError("db.init() must be called first")
    conn = await aiosqlite.connect(_db_path)
    await _configure(conn)
    return conn


async def write(sql: str, params: tuple = ()) -> None:
    """Execute a single write statement under the write lock."""
    if _write_conn is None:
        raise RuntimeError("db.init() must be called first")
    async with _write_lock:
        await _write_conn.execute(sql, params)
        await _write_conn.commit()


async def write_many(stmts: list[tuple[str, tuple]]) -> None:
    """Execute multiple statements atomically under the write lock."""
    if _write_conn is None:
        raise RuntimeError("db.init() must be called first")
    async with _write_lock:
        for sql, params in stmts:
            await _write_conn.execute(sql, params)
        await _write_conn.commit()


async def write_fetchone(sql: str, params: tuple = ()) -> aiosqlite.Row | None:
    """Run a write statement that RETURNING's a row (e.g. INSERT ... RETURNING)."""
    if _write_conn is None:
        raise RuntimeError("db.init() must be called first")
    async with _write_lock:
        cursor = await _write_conn.execute(sql, params)
        row = await cursor.fetchone()
        await cursor.close()
        await _write_conn.commit()
        return row
