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
from urllib.parse import urlparse

import httpx

from app.config import settings

TERMINAL_STATUSES = {"completed", "failed"}

# Evidence lines are almost never useful when they're a wrapper around an image file
# (logo walls, next/image srcs, <img> tags). We drop them before sending to Gemini;
# the LLM otherwise tends to pattern-match a logo co-location as a "partnership".
_IMAGE_URL_RE = re.compile(
    r"(?:\w[\w\-]*\.(?:svg|png|jpg|jpeg|webp|gif|avif)\b)|!\[|<img|src=[\"']",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class IndexStatus:
    index_id: str
    status: str
    page_count: int | None
    error_message: str | None
    seed_urls: list[str]


@dataclass(frozen=True)
class EvidenceLine:
    """A single grep match with its VFS-derived source URL."""
    text: str
    source_url: str


def _vfs_path_to_url(vfs_path: str, base_url: str) -> str:
    """Convert /source/website/<domain>/path/to/page.md → https://<netloc>/path/to/page."""
    prefix = "/source/website/"
    if not vfs_path.startswith(prefix):
        return base_url
    after_prefix = vfs_path[len(prefix):]
    _, _, subpath = after_prefix.partition("/")
    if subpath.endswith(".md"):
        subpath = subpath[:-3]
    parsed = urlparse(base_url)
    scheme = parsed.scheme or "https"
    netloc = parsed.netloc or parsed.path.strip("/")
    return f"{scheme}://{netloc}/{subpath}".rstrip("/")


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
        source_base_url: str,
        target_name: str,
        max_lines: int = 12,
        max_chars_per_line: int = 320,
    ) -> list[EvidenceLine]:
        """Grep source's VFS for target's name. Returns up to max_lines deduped
        evidence lines, each carrying the URL of the page it was found on.

        Drops image-URL / logo-wall noise before returning.
        """
        pattern = rf"\b{re.escape(target_name)}\b"
        vfs = f"/source/website/{source_domain}"
        # Drop -h so grep emits "filename:line" — we need the filename to build a source URL.
        cmd = (
            f"grep -riE --include='*.md' {shlex.quote(pattern)} {vfs} "
            f"| head -n {max_lines * 3}"
        )
        res = await self.fs(index_id=source_index_id, cmd=cmd)
        raw = res.get("stdout") or ""

        out: list[EvidenceLine] = []
        seen_texts: set[str] = set()
        for ln in raw.splitlines():
            if not ln.strip():
                continue
            file_path, sep, text = ln.partition(":")
            if not sep:
                continue
            text = text.strip()
            if not text:
                continue
            if text.startswith("![") or text.startswith("http"):
                continue
            if _IMAGE_URL_RE.search(text):
                continue
            text = text[:max_chars_per_line]
            if text in seen_texts:
                continue
            seen_texts.add(text)
            out.append(EvidenceLine(
                text=text,
                source_url=_vfs_path_to_url(file_path, source_base_url),
            ))
            if len(out) >= max_lines:
                break
        return out

    async def summarize_page(
        self,
        *,
        index_id: str,
        source_domain: str,
        max_bytes: int = 4000,
    ) -> str:
        """Return up to max_bytes of text from the first few .md pages in the VFS.

        Tries `<domain>` and `www.<domain>` since HD may mount at either depending on
        how the crawl resolved redirects. If both are empty (e.g. a just-completed
        index whose VFS isn't queryable yet), waits 2s and retries once.
        """
        candidates = [source_domain]
        if not source_domain.startswith("www."):
            candidates.append(f"www.{source_domain}")
        elif source_domain.startswith("www."):
            candidates.append(source_domain[4:])

        async def try_once() -> str:
            for dom in candidates:
                vfs = f"/source/website/{dom}"
                cmd = (
                    f"find {vfs} -maxdepth 3 -name '*.md' -print 2>/dev/null "
                    f"| head -n 3 | xargs -I {{}} cat {{}} 2>/dev/null "
                    f"| head -c {max_bytes}"
                )
                res = await self.fs(index_id=index_id, cmd=cmd)
                stdout = (res.get("stdout") or "").strip()
                if stdout:
                    return stdout
            return ""

        content = await try_once()
        if content:
            return content
        await asyncio.sleep(2.0)
        return await try_once()
