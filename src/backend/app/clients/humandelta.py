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
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

from app.config import settings

TERMINAL_STATUSES = {"completed", "failed"}

# Hosts that aggregate third-party uploads and listings. Evidence lines sourced
# from these are NOT first-party statements about the source company — they're
# a chenxwh-uploaded-DeepSeek-model on Replicate, or an NVIDIA-quantized-DeepSeek
# weight set on Hugging Face. Tagging them lets the extraction prompt downweight
# or ignore them. Single source of truth shared with parse_query's candidate
# filter in app.clients.gemini.
AGGREGATOR_DOMAINS: frozenset[str] = frozenset({
    "huggingface.co",
    "github.com",
    "gitlab.com",
    "bitbucket.org",
    "replicate.com",
    "npmjs.com",
    "www.npmjs.com",
    "pypi.org",
    "producthunt.com",
    "www.producthunt.com",
    "crunchbase.com",
    "www.crunchbase.com",
    "wikipedia.org",
    "en.wikipedia.org",
    "linkedin.com",
    "www.linkedin.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "www.youtube.com",
    "medium.com",
    "dev.to",
    "news.ycombinator.com",
    "ycombinator.com",
})


# URL-path → page_type classifier. Checked in order; first match wins, so the
# more specific patterns (compare, migrate) come before the general ones (docs,
# blog, other). `page_type` is attached to every EvidenceLine and formatted
# into the extraction prompt so the LLM can use the URL's structural signal
# — which is usually stronger than the sentence's surface form — to pick edge
# direction and type. Example: "Redis" appearing on a Qdrant page at
# `/documentation/migrate-to-qdrant/from-redis/` is `migrate`, which forbids
# a `uses` classification regardless of the words on the page.
_PAGE_TYPE_PATTERNS: tuple[tuple[str, tuple[str, ...]], ...] = (
    ("compare", ("/compare", "/comparison", "/vs/", "-vs-", "/alternatives",
                 "/alternative-to", "/alternative/")),
    ("migrate", ("/migrate", "/migration", "/from-", "/switch-from",
                 "/moving-from", "/move-from")),
    ("customer", ("/customers", "/case-stud", "/case_stud", "/success-stor",
                  "/testimonial", "/clients")),
    ("partner", ("/partners", "/partner/", "/partnership", "/alliance",
                 "/ecosystem")),
    ("integration", ("/integrations", "/integration/", "/connector",
                     "/plugins", "/plugin/", "/marketplace")),
    ("press", ("/press", "/newsroom", "/announcement")),
    ("blog", ("/blog", "/news", "/articles", "/posts")),
    ("docs", ("/docs", "/documentation", "/reference", "/api-reference",
              "/guides", "/tutorial", "/manual")),
    ("about", ("/about", "/company", "/team", "/mission", "/careers",
               "/leadership")),
)


def classify_page_type(url_path: str) -> str:
    """Classify a URL path into a coarse page type. Fallback: ``"other"``."""
    if not url_path:
        return "other"
    p = url_path.lower()
    for page_type, needles in _PAGE_TYPE_PATTERNS:
        if any(n in p for n in needles):
            return page_type
    return "other"


def _is_aggregator_url(url: str) -> bool:
    """True if the URL's host is in AGGREGATOR_DOMAINS (or its root is)."""
    try:
        host = (urlparse(url).hostname or "").lower()
    except ValueError:
        return False
    if not host:
        return False
    if host in AGGREGATOR_DOMAINS:
        return True
    parts = host.split(".")
    if len(parts) >= 2:
        root = ".".join(parts[-2:])
        if root in AGGREGATOR_DOMAINS:
            return True
    return False

# Evidence lines are almost never useful when they're a wrapper around an image file
# (logo walls, next/image srcs, <img> tags). We drop them before sending to Gemini;
# the LLM otherwise tends to pattern-match a logo co-location as a "partnership".
_IMAGE_URL_RE = re.compile(
    r"(?:\w[\w\-]*\.(?:svg|png|jpg|jpeg|webp|gif|avif)\b)|!\[|<img|src=[\"']",
    re.IGNORECASE,
)

# Code-block syntax also produces terrible evidence quotes: `from pinecone import Client`
# tells you nothing about the relationship — it's just a code sample showing usage.
# Rejected patterns: import/require statements, declaration keywords, heavy-brace lines.
_CODE_LINE_RE = re.compile(
    r"^\s*(?:import\s+|from\s+\S+\s+import\s+|require\(|const\s+\w|let\s+\w|var\s+\w"
    r"|function\s+\w|def\s+\w|class\s+\w|export\s+(?:const|let|function|default|class)"
    r"|#include|package\s+\w|\$\s+npm\s|pip\s+install\s)",
    re.IGNORECASE,
)

# Process-wide TTL cache for summarize_page. Keyed on
# (index_id, domain, max_bytes, max_files) — HD indexes are immutable per-id so
# stale reads aren't a correctness risk. Bounded + never caches empty (the 2s
# retry inside summarize_page exists for the just-completed-VFS race; caching
# empty would poison that path).
_SUMMARIZE_CACHE: dict[tuple[str, str, int, int], tuple[float, str]] = {}
_SUMMARIZE_LOCK = asyncio.Lock()
_SUMMARIZE_TTL = 600.0  # 10 minutes
_SUMMARIZE_MAX = 64


# Directories most likely to carry either "what this company does" identity content
# or mentions of other companies. Order matters: earlier = higher priority.
# Identity first (about/company/mission) so summaries establish a baseline before
# topical blog posts skew them, then partnership/customer signal, then blog/news last.
_PRIORITY_DIRS: tuple[str, ...] = (
    "about",
    "company",
    "mission",
    "investors",
    "customers",
    "partners",
    "case-studies",
    "case_studies",
    "integrations",
    "announcements",
    "press",
    "news",
    "research",
    "blog",
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
    """A single grep match with its VFS-derived source URL and the structural
    signals we extract from that URL before the LLM sees the line.

    The LLM-visible prompt is built from (page_type, url_path, text). URL-based
    signals let the classifier reason about direction/type without having to
    re-derive them from the text itself — which is the one signal that was
    reliably misleading in earlier versions (migrate pages reading as `uses`,
    third-party upload pages on aggregators reading as `partner`).
    """
    text: str
    source_url: str
    url_path: str = ""
    page_type: str = "other"
    is_aggregator: bool = False


def _center_window(text: str, target: str, max_chars: int) -> str:
    """Return at most max_chars of text, centered around the first occurrence of
    target so the name is visible in the displayed quote. Adds an ellipsis prefix
    if we trimmed the start. Case-sensitive search matches grep.
    """
    if len(text) <= max_chars:
        return text
    idx = text.find(target)
    if idx < 0:
        return text[:max_chars]
    # Keep ~half the budget before the match, the rest after.
    before = max_chars // 3
    start = max(0, idx - before)
    end = min(len(text), start + max_chars)
    # If we clipped the end, back-adjust start so we still show max_chars.
    if end - start < max_chars and start > 0:
        start = max(0, end - max_chars)
    snippet = text[start:end]
    if start > 0:
        snippet = "…" + snippet
    if end < len(text):
        snippet = snippet + "…"
    return snippet


def vfs_path_to_url(vfs_path: str, base_url: str) -> str:
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
        """POST /v1/indexes. Returns index_id. Retries on 429 with backoff."""
        delays = [2.0, 5.0, 10.0]  # 3 retries, ~17s total worst case
        last_exc: httpx.HTTPStatusError | None = None
        for attempt in range(len(delays) + 1):
            try:
                r = await self._client.post(
                    "/v1/indexes",
                    json={
                        "source_type": "website",
                        "website": {"url": url, "max_pages": max_pages},
                    },
                )
                r.raise_for_status()
                return r.json()["index_id"]
            except httpx.HTTPStatusError as e:
                if e.response.status_code != 429 or attempt == len(delays):
                    raise
                last_exc = e
                await asyncio.sleep(delays[attempt])
        # Unreachable — the loop always either returns or raises.
        raise last_exc  # type: ignore[misc]

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
        """POST /v1/fs. Returns {stdout, stderr, exit_code, truncated, sources, elapsed_ms}.

        Retries once on transient 5xx from HD — they happen intermittently (502 Bad
        Gateway in particular). Non-5xx errors still propagate.
        """
        for attempt in range(2):
            try:
                r = await self._client.post(
                    "/v1/fs",
                    json={"index_id": index_id, "cmd": cmd},
                )
                r.raise_for_status()
                return r.json()
            except httpx.HTTPStatusError as e:
                if 500 <= e.response.status_code < 600 and attempt == 0:
                    await asyncio.sleep(1.0)
                    continue
                raise
        raise RuntimeError("unreachable")  # for typing

    async def source_has_content(self, *, index_id: str, source_domain: str) -> bool:
        """Return True if the indexed VFS still has the source directory populated.

        HD sometimes reports `status: completed` for an index whose filesystem
        content has been deleted (e.g. after the user wipes Sources via the
        dashboard). We check both `<domain>` and `www.<domain>` since HD may mount
        at either depending on redirects.
        """
        candidates = [source_domain]
        if not source_domain.startswith("www."):
            candidates.append(f"www.{source_domain}")
        elif source_domain.startswith("www."):
            candidates.append(source_domain[4:])
        for dom in candidates:
            try:
                r = await self._client.post(
                    "/v1/fs",
                    json={
                        "op": "stat",
                        "path": f"/source/website/{dom}",
                        "index_id": index_id,
                    },
                )
                r.raise_for_status()
                data = r.json()
                # op=stat returns {exists: bool, entries: [...], entry_count: N}.
                if data.get("exists") and (data.get("entry_count") or 0) > 0:
                    return True
            except httpx.HTTPError:
                continue
        return False

    async def find_cooccurrences(
        self,
        *,
        source_index_id: str,
        source_domain: str,
        source_base_url: str,
        target_name: str,
        max_lines: int = 12,
        max_chars_per_line: int = 420,
    ) -> list[EvidenceLine]:
        """Grep source's VFS for target's name. Returns up to max_lines deduped
        evidence lines, each carrying the URL of the page it was found on.

        Case-sensitive matching — company names are proper nouns, and
        case-insensitive matching produces nasty false positives (e.g. "chroma
        features" in audio DSP vs the Chroma vector database). Drops image-URL
        and code-import noise. Evidence text windows are centered on the match
        so the target name is visible in the quote shown to the user.
        """
        pattern = rf"\b{re.escape(target_name)}\b"
        vfs = f"/source/website/{source_domain}"
        # Drop -h so grep emits "filename:line"; drop -i so matches are case-sensitive.
        cmd = (
            f"grep -rE --include='*.md' {shlex.quote(pattern)} {vfs} "
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
            if _CODE_LINE_RE.match(text):
                continue
            text = _center_window(text, target_name, max_chars_per_line)
            if text in seen_texts:
                continue
            seen_texts.add(text)
            src_url = vfs_path_to_url(file_path, source_base_url)
            try:
                url_path = urlparse(src_url).path or "/"
            except ValueError:
                url_path = "/"
            out.append(EvidenceLine(
                text=text,
                source_url=src_url,
                url_path=url_path,
                page_type=classify_page_type(url_path),
                is_aggregator=_is_aggregator_url(src_url),
            ))
            if len(out) >= max_lines:
                break
        return out

    async def summarize_page(
        self,
        *,
        index_id: str,
        source_domain: str,
        max_bytes: int = 8_000,
        max_files: int = 6,
    ) -> str:
        """Return up to max_bytes of text from the crawled .md pages in the VFS,
        prioritizing directories that tend to name other companies (blog, news,
        research, partners, customers, case-studies, etc.) and falling back to
        root-level pages and then anything else.

        Retries are layered:
          1. Priority-dir pipeline at requested size
          2. Same again after a 2s wait (catches just-completed-VFS race)
          3. Any-content fallback at 2.5× budget, 2× files, no priority filter
             — guarantees Gemini sees *something* if any .md exists
        Returns "" only if all three return nothing.

        Results are memoized for _SUMMARIZE_TTL seconds (see module-level cache).
        Indexes are immutable per-id on HD's side, so cached reads are safe until
        TTL expires. Empty results are never cached — the 2s retry inside this
        function exists specifically for the just-completed-VFS race.

        Also tries `<domain>` and `www.<domain>` since HD may mount at either
        depending on how the crawl resolved redirects.
        """
        cache_key = (index_id, source_domain, max_bytes, max_files)
        async with _SUMMARIZE_LOCK:
            cached = _SUMMARIZE_CACHE.get(cache_key)
            if cached is not None:
                ts, content = cached
                if time.monotonic() - ts < _SUMMARIZE_TTL:
                    return content
                # Expired — drop so we don't grow unbounded on near-misses.
                _SUMMARIZE_CACHE.pop(cache_key, None)

        candidates = [source_domain]
        if not source_domain.startswith("www."):
            candidates.append(f"www.{source_domain}")
        elif source_domain.startswith("www."):
            candidates.append(source_domain[4:])

        async def fetch(*, with_priority: bool, n_files: int, n_bytes: int) -> str:
            for dom in candidates:
                vfs = f"/source/website/{dom}"
                if with_priority:
                    finds = " ; ".join(
                        f"find {vfs} -name '*.md' -path '*/{p}/*'"
                        for p in _PRIORITY_DIRS
                    )
                    # Root-level pages FIRST (homepage / about / careers etc. — best for
                    # establishing what the company does), THEN topical dirs (blog / news /
                    # partners — best for mentions of other companies), THEN total fallback.
                    pipeline = (
                        f"( find {vfs} -maxdepth 2 -name '*.md' ; "
                        f"{finds} ; "
                        f"find {vfs} -name '*.md' ) 2>/dev/null "
                        f"| awk '!seen[$0]++' "
                        f"| head -n {n_files} "
                        f"| xargs -I {{}} cat {{}} 2>/dev/null "
                        f"| head -c {n_bytes}"
                    )
                else:
                    pipeline = (
                        f"find {vfs} -name '*.md' 2>/dev/null "
                        f"| head -n {n_files} "
                        f"| xargs -I {{}} cat {{}} 2>/dev/null "
                        f"| head -c {n_bytes}"
                    )
                try:
                    res = await self.fs(index_id=index_id, cmd=pipeline)
                except httpx.HTTPStatusError:
                    # HD transient error — treat as "no content" for this attempt; the
                    # outer retry schedule may succeed later. Don't let it 500 the caller.
                    continue
                stdout = (res.get("stdout") or "").strip()
                if stdout:
                    return stdout
            return ""

        async def _cache_and_return(content: str) -> str:
            if not content:
                return ""
            async with _SUMMARIZE_LOCK:
                _SUMMARIZE_CACHE[cache_key] = (time.monotonic(), content)
                # Bounded eviction: if we're over the soft cap, drop the oldest.
                if len(_SUMMARIZE_CACHE) > _SUMMARIZE_MAX:
                    oldest = min(
                        _SUMMARIZE_CACHE.items(), key=lambda kv: kv[1][0],
                    )[0]
                    _SUMMARIZE_CACHE.pop(oldest, None)
            return content

        content = await fetch(with_priority=True, n_files=max_files, n_bytes=max_bytes)
        if content:
            return await _cache_and_return(content)
        await asyncio.sleep(2.0)
        content = await fetch(with_priority=True, n_files=max_files, n_bytes=max_bytes)
        if content:
            return await _cache_and_return(content)
        # Last-resort: any-content grab at bigger budget, no priority filter.
        content = await fetch(
            with_priority=False,
            n_files=max_files * 2,
            n_bytes=int(max_bytes * 2.5),
        )
        return await _cache_and_return(content)
