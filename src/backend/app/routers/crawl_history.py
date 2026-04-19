"""GET /v1/crawl_history/{domain} — inspection endpoint for the temporal store.

Not wired to the UI in Feature 1; exists for debugging and future features.
Returns [] (not 404) for unknown domains so callers can treat the response uniformly.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.services import temporal_store

router = APIRouter()


@router.get("/v1/crawl_history/{domain}")
async def crawl_history(domain: str) -> list[dict]:
    records = await temporal_store.get_crawl_history(domain)
    return [
        {
            "version": r.version,
            "index_id": r.index_id,
            "page_count": r.page_count,
            "indexed_at": r.indexed_at,
        }
        for r in records
    ]
