"""Pretty-print the /query/stream SSE feed in real time.

Usage:
    uv run python scripts/stream_test.py "vector database companies"
"""

from __future__ import annotations

import json
import sys
import time
from collections import Counter

import httpx

BASE = "http://localhost:8000"


def _parse_sse(stream: httpx.Response):
    """Yield (event, payload) tuples as they arrive."""
    event = None
    for raw in stream.iter_lines():
        if raw is None:
            continue
        line = raw if isinstance(raw, str) else raw.decode("utf-8")
        if not line.strip():
            event = None
            continue
        if line.startswith("event:"):
            event = line[6:].strip()
        elif line.startswith("data:"):
            payload = json.loads(line[5:].strip())
            yield event or "message", payload


def main() -> None:
    q = sys.argv[1] if len(sys.argv) > 1 else "vector database companies"
    t0 = time.time()
    counts: Counter[str] = Counter()
    with httpx.stream(
        "GET", f"{BASE}/query/stream",
        params={"q": q},
        timeout=httpx.Timeout(300.0, connect=5.0),
    ) as r:
        r.raise_for_status()
        for event, payload in _parse_sse(r):
            counts[event] += 1
            dt = time.time() - t0
            tag = f"[{dt:6.2f}s] {event:>18}"
            if event == "companies_parsed":
                names = ", ".join(c["name"] for c in payload["companies"])
                print(f"{tag}  {len(payload['companies'])} companies: {names}")
            elif event == "index_started":
                print(f"{tag}  {payload['name']} ({payload['domain']})")
            elif event == "index_completed":
                print(f"{tag}  {payload['name']} · {payload['page_count']} pages")
            elif event == "index_failed":
                print(f"{tag}  {payload['name']}: {payload['reason']}")
            elif event == "edge_found":
                ev = payload.get("evidence", [])
                first_text = ev[0]["text"] if ev else ""
                print(f"{tag}  {payload['source']} --{payload['type']}[{payload['confidence']}]--> "
                      f"{payload['target']}  ({len(ev)} quote(s): {first_text[:60]})")
                for i, e in enumerate(ev[:3]):
                    print(f"           [{i}] {e['text'][:90]}")
                    print(f"               → {e['source_url']}")
            elif event == "done":
                print(f"{tag}  {payload}")
                break
            elif event == "error":
                print(f"{tag}  {payload}")
                break
            else:
                print(f"{tag}  {payload}")
    print(f"\n=== summary (wall clock {time.time()-t0:.1f}s) ===")
    for k, v in counts.items():
        print(f"  {k}: {v}")


if __name__ == "__main__":
    main()
