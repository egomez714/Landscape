"""Async client for the Human Delta API.

Endpoints documented in CLAUDE.md:
  - POST /v1/indexes  — index a company's blog/docs/about; async, poll for status
  - POST /v1/search   — find passages describing relationships
  - POST /v1/fs       — grep entity co-occurrences across sources

Exact request/response shapes live in docs/api-notes.md after Hour 0-2 Explorer testing.
Fill in methods during Hours 5-9 per CLAUDE.md.
"""

from __future__ import annotations

import httpx

from app.config import settings


class HumanDeltaClient:
    def __init__(self, api_key: str | None = None, base_url: str | None = None) -> None:
        self._api_key = api_key or settings.hd_api_key
        self._base_url = (base_url or settings.hd_base_url).rstrip("/")
        self._client = httpx.AsyncClient(
            base_url=self._base_url,
            headers={"Authorization": f"Bearer {self._api_key}"},
            timeout=httpx.Timeout(30.0, connect=5.0),
        )

    async def create_index(self, *, source_url: str) -> dict:
        """POST /v1/indexes — kick off an indexing job. Returns job handle.

        TODO(hours 5-9): implement after Explorer test pins response shape.
        """
        raise NotImplementedError

    async def get_index(self, index_id: str) -> dict:
        """GET /v1/indexes/{id} — poll for status: "completed" | "pending" | "failed".

        TODO(hours 5-9): implement.
        """
        raise NotImplementedError

    async def search(self, *, index_ids: list[str], query: str) -> dict:
        """POST /v1/search — semantic passage search across indexes.

        TODO(hours 5-9): implement.
        """
        raise NotImplementedError

    async def fs(self, *, index_ids: list[str], pattern: str) -> dict:
        """POST /v1/fs — grep for exact string/entity co-occurrences.

        TODO(hours 5-9): implement.
        """
        raise NotImplementedError

    async def aclose(self) -> None:
        await self._client.aclose()
