"""Persistent domain → index_id cache.

Avoids re-crawling the same website across runs. This is what turns cold 60-90s demos
into warm ~15-30s demos.

On lookup, we verify the cached index is still queryable via GET /v1/indexes/{id};
if it's 404 or in a non-completed state, we treat the entry as stale and evict.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING

from app.config import settings

if TYPE_CHECKING:
    from app.clients.humandelta import HumanDeltaClient

log = logging.getLogger(__name__)


def _cache_path() -> Path:
    return settings.cache_dir / "indexes.json"


def _load() -> dict[str, dict]:
    p = _cache_path()
    if not p.exists():
        return {}
    try:
        return json.loads(p.read_text())
    except (OSError, json.JSONDecodeError):
        return {}


def _save(cache: dict[str, dict]) -> None:
    p = _cache_path()
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(cache, indent=2, sort_keys=True))


async def get(hd: "HumanDeltaClient", domain: str) -> tuple[str, int] | None:
    """Return (index_id, page_count) if the cached index is still valid.

    Two checks:
      1. HD reports status=completed for the index_id
      2. HD's VFS still has content at /source/website/<domain>
    HD sometimes keeps #1 true even when the user clears Sources in the
    dashboard, leaving us with a live index_id pointing at an empty filesystem.
    Both checks must pass.
    """
    cache = _load()
    entry = cache.get(domain)
    if not entry:
        return None
    index_id = entry.get("index_id")
    if not index_id:
        return None
    try:
        status = await hd.get_index(index_id)
    except Exception as e:  # noqa: BLE001
        log.info("cache verification failed for %s (%s); evicting", domain, e)
        cache.pop(domain, None)
        _save(cache)
        return None
    if status.status != "completed":
        cache.pop(domain, None)
        _save(cache)
        return None
    # Second check: does the VFS still have content? Cheap stat call.
    try:
        has_content = await hd.source_has_content(
            index_id=index_id, source_domain=domain,
        )
    except Exception as e:  # noqa: BLE001
        log.info("stat check failed for %s (%s); evicting", domain, e)
        cache.pop(domain, None)
        _save(cache)
        return None
    if not has_content:
        log.info("cache for %s points to empty VFS; evicting", domain)
        cache.pop(domain, None)
        _save(cache)
        return None
    return index_id, status.page_count or entry.get("page_count", 0)


def put(domain: str, index_id: str, page_count: int) -> None:
    cache = _load()
    cache[domain] = {
        "index_id": index_id,
        "page_count": page_count,
        "indexed_at": datetime.now(timezone.utc).isoformat(),
    }
    _save(cache)
