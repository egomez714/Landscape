"""GET /company/summary?domain=...&index_id=...

Returns a one-sentence description of the company, generated from the first few
pages of its indexed website. Results are cached per-(domain, index_id) in memory
for the process lifetime — safe because index_ids are stable and the underlying
indexed content doesn't change.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query

from app.clients.gemini import GeminiClient
from app.clients.humandelta import HumanDeltaClient

log = logging.getLogger(__name__)
router = APIRouter()

_summary_cache: dict[tuple[str, str], str] = {}


@router.get("/company/summary")
async def company_summary(
    domain: str = Query(..., min_length=3, max_length=100),
    index_id: str = Query(..., min_length=8, max_length=100),
) -> dict:
    key = (domain, index_id)
    if key in _summary_cache:
        return {"domain": domain, "summary": _summary_cache[key], "cached": True}

    hd = HumanDeltaClient()
    gemini = GeminiClient()
    try:
        content = await hd.summarize_page(index_id=index_id, source_domain=domain)
        if not content:
            raise HTTPException(status_code=404, detail="no content indexed for this domain")
        name_guess = domain.split(".")[0].capitalize()
        summary = await gemini.summarize_company(company_name=name_guess, content=content)
    finally:
        await hd.aclose()

    if summary:
        _summary_cache[key] = summary
    return {"domain": domain, "summary": summary, "cached": False}
