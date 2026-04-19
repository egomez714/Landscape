# Human Delta API notes

Captured against `api.humandelta.ai` on 2026-04-18 using `langchain.com` (`max_pages: 20`) as a test index. Auth is `Authorization: Bearer $HD_API_KEY`. Endpoints observed:

- `POST /v1/indexes` — crawl a website (async, poll until `status: completed`)
- `GET  /v1/indexes/{id}` — poll status
- `POST /v1/documents` — upload PDF / CSV / image / markdown (not used in v1)
- `POST /v1/search` — vector search (cosine) over **all** indexed web + uploaded content in one pool; pass `top_k`
- `POST /v1/fs` — **shell** over the indexed VFS (`tree`, `ls`, `cat`, `grep`, pipes) — scoped by `index_id`

---

## POST /v1/indexes

### Request

```json
{
  "source_type": "website",
  "website": { "url": "https://www.langchain.com", "max_pages": 20 }
}
```

### Response (201)

```json
{
  "id": "198c38ea-…",
  "index_id": "198c38ea-…",
  "job_id": "198c38ea-…",
  "name": "Website index",
  "source_type": "website",
  "status": "queued",
  "message": "Index job queued. Poll GET /v1/indexes/<id> for progress."
}
```

- `id` == `index_id` == `job_id`. Use whichever, prefer `index_id` downstream.

### GET /v1/indexes/{id} (polling)

```json
{
  "id": "198c38ea-…",
  "index_id": "198c38ea-…",
  "status": "completed",         // queued → (running) → completed | failed
  "state": "completed",           // mirrors status
  "page_count": 20,
  "checks_requested": ["pages"],
  "checks_completed": ["pages"],
  "started_at": "2026-04-19T04:03:41.475+00:00",
  "finished_at": "2026-04-19T04:03:57.489+00:00",
  "duration_seconds": 15,
  "seed_urls": ["https://www.langchain.com"],
  "error_message": null
}
```

### Polling behavior & timing

- Poll `GET /v1/indexes/{id}` directly (no webhook observed).
- For `max_pages: 20`, **~15 seconds** start-to-finish. Queue time was ~0s.
- Poll interval: **3–5s is plenty**. Backend should poll every 3s with a 60s ceiling per job.
- Terminal states: `completed`, `failed`. Treat anything else (`queued`, `running`) as "keep polling."

### Gotchas

- `name` can be `null` in the GET response even though POST returned `"Website index"`.
- Response includes the original `seed_urls` so we don't need to remember the URL client-side.

---

## POST /v1/search

### Request

```json
{ "query": "partnerships or integrations with other companies", "top_k": 10 }
```

- **`index_id` is optional**. Omitting it searches **across all your indexes** in one pool, ranked by cosine. This is the preferred shape for Landscape — after we index N companies, one search call returns relationships spanning all of them.
- `top_k` caps result count (verified `top_k: 1` and `top_k: 3` return exactly that many).
- Pass `index_id` only when you want to scope to a single source.

### Response (200)

```json
{
  "results": [
    {
      "chunk_id": "chunk:45106",
      "score": 0.596,
      "raw_score": 0.596,
      "text": "Announcing the LangChain + MongoDB Partnership: The AI Agent Stack…",
      "source_url": "https://www.langchain.com/blog/structured-report-generation-blueprint",
      "page_title": "Structured Report Generation Blueprint with NVIDIA AI",
      "source_type": "web",
      "match_type": "semantic",
      "score_kind": "cosine"
    }
  ]
}
```

### Gotchas

- `text` chunks can be **noisy** — lots of image-tag blocks, repeated footer nav, etc. For relationship extraction, prefer `/v1/fs` with `grep` over pure semantic search, then only use `/v1/search` when you want narrative passages instead of exact mentions.
- `source_url` is the **page** the chunk came from. Good for citation rendering and for deriving which indexed company a result belongs to (parse the hostname).
- Both `score` and `raw_score` were identical in my sample (cosine; no re-ranker applied).
- Default `top_k` looks like ~8 when omitted. Always pass `top_k` explicitly.

---

## POST /v1/fs  ⭐ (more powerful than the plan assumed)

This is not just `grep` — it's a **sandboxed shell** over a virtual filesystem where each indexed source mounts as a directory. Supports `tree`, `ls`, `cat`, `head`, `grep -r`, pipes, globs.

### Request

```json
{ "index_id": "198c38ea-…", "cmd": "grep -r -i -l 'MongoDB' /source/website/langchain.com" }
```

Required field is **`cmd`** (not `pattern`). Missing `cmd` → HTTP 400 `{"detail": "Missing \"cmd\""}`.

### Response (200)

```json
{
  "ok": true,
  "op": "shell",
  "stdout": "/source/website/langchain.com/blog/langfriend.md\n/source/website/langchain.com/blog/multion-x-langchain-powering-next-gen-web-automation-navigation-with-ai.md\n…",
  "stderr": "",
  "exit_code": 0,
  "truncated": false,
  "sources": ["langchain.com"],
  "elapsed_ms": 66
}
```

### VFS layout

Absolute paths only. From the `README.md` at the VFS root:

```
/source/website/<domain>/       # crawled pages as .md files, mirroring URL structure
/source/<other_source_type>/…
/agent                          # org-wide team notes (symlinked as workspace/team-notes)
/uploads/library/               # uploaded docs
/skills                         # agent skills
```

`ls /source/website/langchain.com` → mixture of `.md` files and sub-dirs like `blog/`, `articles/`, `breakoutagents/`. File names are slugified page paths.

Convenience files at the VFS root:
- `README.md` — explains the layout
- `SOURCES.md` — markdown table of sidebar label → VFS path → active page count

### Commands verified working

| Command | Notes |
|---|---|
| `ls /source/website/<d>` | list top-level pages |
| `tree -L 2 /source/website/<d>` | full tree |
| `cat <path.md>` | read page content |
| `grep -r -i -l 'Term' /source/website/<d>` | list files mentioning a term |
| `grep -r -i --include='*.md' -h 'Term' /source/website/<d>` | dump matching lines without filenames |
| `grep -r -i -l 'Term' sources` | ⚠️ fails silently (returns exit 0, no stdout) — use absolute paths |

### Why this matters for Landscape

This endpoint is how we generate high-confidence graph edges:

1. After indexing Company A, `grep -r -i -l '<CompanyB>' /source/website/<CompanyA>` → proves co-occurrence cheaply.
2. If matches exist, `grep -r -i -h '<CompanyB>'` → raw evidence lines to feed the extraction prompt.
3. Evidence quotes with `-h` stripped of file prefix are ~15-word passages — exactly the `evidence_quote` shape the extraction prompt requires.

Sample findings on `langchain.com` alone in <1s: LangChain↔MongoDB (partnership), LangChain↔Anthropic (hackathon), LangChain↔MultiOn (integration), LangChain↔NVIDIA (blog collab). All grounded in specific file paths → citable URLs.

### Gotchas

- Relative paths don't work — always use `/source/…` absolute paths.
- `grep` uses standard BRE unless you pass `-E`. `-i`, `-r`, `-l`, `-h`, `--include='*.md'` all work.
- `stderr` is captured separately; check `exit_code` before assuming stdout is the whole answer.
- `truncated: true` means output was cut — tighten the query or use `head`/`tail` in the pipeline.

---

## Auth & general

- Header: `Authorization: Bearer $HD_API_KEY` (prefix observed: `hd_live_…`). Same key for all endpoints.
- 4xx errors return `{"detail": "<message>"}`.
- No rate-limit headers surfaced yet; monitor during the parallel-index burst in hours 5-9.
- `/v1/documents` not exercised — out of scope for hackathon v1 (we only need website sources).

---

## Implications for the backend client (`app/clients/humandelta.py`)

Revise the stub method signatures to match reality:

- `create_index(url, max_pages=20)` → returns `{index_id, status}`
- `get_index(index_id)` → returns full status dict; treat `status in {"completed","failed"}` as terminal
- `search(query, top_k=10, index_id=None)` → omit `index_id` to pool across all indexes (the common case for Landscape); returns `{results: [...]}`
- `fs(index_id, cmd)` → **rename plan's `pattern` param to `cmd`**; returns `{stdout, stderr, exit_code, truncated}`

Keep a `find_cooccurrences(index_id, term)` convenience wrapper that composes two `fs` calls (`grep -l` then `grep -h`) since every relationship-extraction call uses that pattern.
