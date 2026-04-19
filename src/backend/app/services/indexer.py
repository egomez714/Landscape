"""Parallel indexing: fan out create_index across all candidate companies, poll until
each is terminal, yield per-company events as they complete.

Usage:
    async for event in index_all(hd, candidates, concurrency=6):
        ...  # event is one of: IndexStartedEvent, IndexCompletedEvent, IndexFailedEvent
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from typing import AsyncIterator

from app.clients.humandelta import HumanDeltaClient
from app.models import CompanyCandidate, IndexedCompany
from app.services import index_cache

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class IndexStartedEvent:
    company: CompanyCandidate
    index_id: str


@dataclass(frozen=True)
class IndexCompletedEvent:
    indexed: IndexedCompany


@dataclass(frozen=True)
class IndexFailedEvent:
    company: CompanyCandidate
    reason: str


IndexEvent = IndexStartedEvent | IndexCompletedEvent | IndexFailedEvent


async def _index_one(
    hd: HumanDeltaClient,
    company: CompanyCandidate,
    queue: asyncio.Queue[IndexEvent],
    max_pages: int,
    timeout_seconds: float,
    use_cache: bool,
) -> None:
    # Cache hit → skip crawl, go straight to completed event.
    if use_cache:
        cached = await index_cache.get(hd, company.domain)
        if cached:
            cached_id, cached_pages = cached
            await queue.put(IndexStartedEvent(company=company, index_id=cached_id))
            await queue.put(IndexCompletedEvent(indexed=IndexedCompany(
                name=company.name,
                url=company.url,
                domain=company.domain,
                index_id=cached_id,
                page_count=cached_pages,
            )))
            return

    try:
        index_id = await hd.create_index(url=company.url, max_pages=max_pages)
    except Exception as e:  # noqa: BLE001
        log.exception("create_index failed for %s", company.name)
        await queue.put(IndexFailedEvent(company=company, reason=f"create_index: {e}"))
        return

    await queue.put(IndexStartedEvent(company=company, index_id=index_id))

    status = await hd.wait_for_index(index_id, timeout_seconds=timeout_seconds)
    if status.status != "completed":
        await queue.put(IndexFailedEvent(
            company=company,
            reason=status.error_message or f"terminal status: {status.status}",
        ))
        return

    page_count = status.page_count or 0
    if use_cache:
        index_cache.put(company.domain, index_id, page_count)

    await queue.put(IndexCompletedEvent(indexed=IndexedCompany(
        name=company.name,
        url=company.url,
        domain=company.domain,
        index_id=index_id,
        page_count=page_count,
    )))


async def index_all(
    hd: HumanDeltaClient,
    companies: list[CompanyCandidate],
    *,
    concurrency: int = 6,
    max_pages: int = 20,
    timeout_seconds: float = 180.0,
    use_cache: bool = True,
) -> AsyncIterator[IndexEvent]:
    """Fan out indexing across all companies, yield events as they arrive."""
    queue: asyncio.Queue[IndexEvent] = asyncio.Queue()
    sem = asyncio.Semaphore(concurrency)

    async def guarded(c: CompanyCandidate) -> None:
        async with sem:
            await _index_one(hd, c, queue, max_pages, timeout_seconds, use_cache)

    tasks = [asyncio.create_task(guarded(c)) for c in companies]
    pending_terminal = len(companies)  # each company emits exactly one terminal event

    try:
        while pending_terminal > 0:
            event = await queue.get()
            yield event
            if isinstance(event, (IndexCompletedEvent, IndexFailedEvent)):
                pending_terminal -= 1
    finally:
        for t in tasks:
            if not t.done():
                t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
