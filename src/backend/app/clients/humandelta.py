"""Async client for the Human Delta API.

Endpoints and behavior documented in docs/api-notes.md.

  - POST /v1/indexes          → create a crawl, returns {index_id, status: "queued"}
  - GET  /v1/indexes/{id}     → poll for status, terminal = "completed" | "failed"
  - POST /v1/search           → semantic search across all indexes (omit index_id)
  - POST /v1/fs               → shell over the indexed VFS, grep/tree/cat/ls

Convenience method `find_cooccurrences` composes two /v1/fs calls (grep -l then grep -h)
to pull evidence lines for relationship extraction.
"""

from __future__ import annotations

import asyncio
import re
import shlex
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import settings

TERMINAL_STATUSES = {"completed", "failed"}


@dataclass(frozen=True)
class IndexStatus:
    index_id: str
    status: str
    page_count: int | None
    error_message: str | None
    seed_urls: list[str]


class HumanDeltaClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self._api_key = api_key or settings.hd_api_key
        self._base_url = (base_url or settings.hd_base_url).rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=httpx.Timeout(60.0, connect=5.0),
        )

    async def aclose(self) -> None:
        await self._client.aclose()

    async def __aenter__(self) -> HumanDeltaClient:
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.aclose()

    # ---- indexes ----

    async def create_index(self, *, url: str, max_pages: int = 20) -> str:
        """POST /v1/indexes. Returns index_id."""
        r = await self._client.post(
            "/v1/indexes",
            json={
                "source_type": "website",
                "website": {"url": url, "max_pages": max_pages},
            },
        )
        r.raise_for_status()
        return r.json()["index_id"]

    async def get_index(self, index_id: str) -> IndexStatus:
        """GET /v1/indexes/{id}."""
        r = await self._client.get(f"/v1/indexes/{index_id}")
        r.raise_for_status()
        data = r.json()
        return IndexStatus(
            index_id=data["index_id"],
            status=data["status"],
            page_count=data.get("page_count"),
            error_message=data.get("error_message"),
            seed_urls=data.get("seed_urls") or [],
        )

    async def wait_for_index(
        self,
        index_id: str,
        *,
        poll_interval: float = 3.0,
        timeout_seconds: float = 180.0,
    ) -> IndexStatus:
        """Poll until the job reaches a terminal state or timeout."""
        deadline = asyncio.get_event_loop().time() + timeout_seconds
        while True:
            status = await self.get_index(index_id)
            if status.status in TERMINAL_STATUSES:
                return status
            if asyncio.get_event_loop().time() > deadline:
                return IndexStatus(
                    index_id=index_id,
                    status="failed",
                    page_count=status.page_count,
                    error_message=f"Polling timed out after {timeout_seconds}s "
                                  f"(last status: {status.status})",
                    seed_urls=status.seed_urls,
                )
            await asyncio.sleep(poll_interval)

    # ---- search ----

    async def search(
        self,
        *,
        query: str,
        top_k: int = 10,
        index_id: str | None = None,
    ) -> list[dict]:
        """POST /v1/search. Omit index_id to search across all indexes."""
        payload: dict[str, Any] = {"query": query, "top_k": top_k}
        if index_id:
            payload["index_id"] = index_id
        r = await self._client.post("/v1/search", json=payload)
        r.raise_for_status()
        return r.json().get("results", [])

    # ---- fs (shell) ----

    async def fs(self, *, index_id: str, cmd: str) -> dict:
        """POST /v1/fs. Returns {stdout, stderr, exit_code, truncated, sources, elapsed_ms}."""
        r = await self._client.post(
            "/v1/fs",
            json={"index_id": index_id, "cmd": cmd},
        )
        r.raise_for_status()
        return r.json()

    async def find_cooccurrences(
        self,
        *,
        source_index_id: str,
        source_domain: str,
        target_name: str,
        max_lines: int = 12,
        max_chars_per_line: int = 320,
    ) -> list[str]:
        """Grep source's VFS for target's name. Returns up to max_lines deduped evidence lines.

        Drops obvious noise (markdown image tags, bare URLs) before returning.
        """
        pattern = rf"\b{re.escape(target_name)}\b"
        vfs = f"/source/website/{source_domain}"
        cmd = (
            f"grep -rhiE --include='*.md' {shlex.quote(pattern)} {vfs} "
            f"| head -n {max_lines * 2}"   # over-fetch to survive filter
        )
        res = await self.fs(index_id=source_index_id, cmd=cmd)
        raw = res.get("stdout") or ""
        lines = [ln.strip() for ln in raw.splitlines() if ln.strip()]
        lines = [ln for ln in lines if not ln.startswith("![") and not ln.startswith("http")]
        lines = [ln[:max_chars_per_line] for ln in lines]

        seen: set[str] = set()
        uniq: list[str] = []
        for ln in lines:
            if ln not in seen:
                seen.add(ln)
                uniq.append(ln)
            if len(uniq) >= max_lines:
                break
        return uniq
