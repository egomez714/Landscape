"""Prompt-iteration CLI for the relationship extractor.

Goal: given N indexed companies, produce a clean list of graph edges like
    {source, target, type, evidence_quote, confidence}
for every ordered pair that has real co-occurrence evidence in the indexed corpus.

Usage:
    cd src/backend
    uv run python scripts/extract.py
"""

from __future__ import annotations

import json
import os
import re
import shlex
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
from dotenv import load_dotenv
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, Field
from tenacity import (
    retry,
    retry_if_exception,
    stop_after_attempt,
    wait_exponential,
)

# ---- config ----

BACKEND_ROOT = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_ROOT / ".env")
HD_API_KEY = os.environ["HD_API_KEY"]
GEMINI_API_KEY = os.environ["GEMINI_API_KEY"]
HD_BASE = "https://api.humandelta.ai"

MODEL = "gemini-2.5-flash-lite"  # free tier: 15 RPM (Flash is 5, Pro is 0)
EVIDENCE_MAX_LINES = 12
EVIDENCE_MAX_CHARS_PER_LINE = 320
INTER_CALL_SLEEP_S = 1.0  # conservative pacing under free-tier RPM

OUTPUT_PATH = Path(__file__).resolve().parent / "extraction_output.json"


@dataclass(frozen=True)
class Company:
    name: str           # display name, used as the grep pattern
    domain: str         # hostname without scheme, matches fs mount path
    index_id: str

    @property
    def vfs_path(self) -> str:
        return f"/source/website/{self.domain}"


# ---- Gemini structured output schema ----

RelationshipType = Literal[
    "competitor",   # serve the same customers with overlapping products
    "partner",      # formal partnership, integration, or joint product
    "investor",     # one invested in the other, or shared major investor
    "downstream",   # one uses the other as infrastructure
    "talent",       # documented hires between the two
    "none",         # no clear relationship in evidence
]

Confidence = Literal["high", "medium", "low"]


class Edge(BaseModel):
    type: RelationshipType
    evidence_quote: str = Field(
        description="Exact passage (<=15 words) copied verbatim from the provided evidence. "
                    "Must be a literal substring. Empty string only if type='none'."
    )
    confidence: Confidence


# ---- Human Delta fs helper ----

def hd_fs(index_id: str, cmd: str) -> dict:
    r = httpx.post(
        f"{HD_BASE}/v1/fs",
        headers={"Authorization": f"Bearer {HD_API_KEY}"},
        json={"index_id": index_id, "cmd": cmd},
        timeout=30.0,
    )
    r.raise_for_status()
    return r.json()


def _grep_safe_pattern(term: str) -> str:
    # Escape regex metacharacters; use word boundaries so "AI" doesn't match "OpenAI".
    escaped = re.escape(term)
    return rf"\b{escaped}\b"


def gather_evidence(source: Company, target: Company) -> list[str]:
    """Return up to EVIDENCE_MAX_LINES lines from source's corpus mentioning target.name."""
    pattern = _grep_safe_pattern(target.name)
    # -h drops filenames; -i case-insensitive; -E extended regex (for \b).
    cmd = (
        f"grep -rhiE --include='*.md' {shlex.quote(pattern)} {source.vfs_path} "
        f"| head -n {EVIDENCE_MAX_LINES}"
    )
    res = hd_fs(source.index_id, cmd)
    stdout = res.get("stdout") or ""
    lines = [ln.strip() for ln in stdout.splitlines() if ln.strip()]
    # Drop image-tag / alt-text noise — those lines start with `![` or are just a URL.
    lines = [ln for ln in lines if not ln.startswith("![") and not ln.startswith("http")]
    # Truncate each line to keep the prompt small and the LLM focused.
    lines = [ln[:EVIDENCE_MAX_CHARS_PER_LINE] for ln in lines]
    # Dedupe preserving order.
    seen: set[str] = set()
    uniq = []
    for ln in lines:
        if ln not in seen:
            seen.add(ln)
            uniq.append(ln)
    return uniq[:EVIDENCE_MAX_LINES]


# ---- Gemini extractor ----

# Vertex AI Express mode — routes to aiplatform.googleapis.com, bills against GCP credits.
# The key is a Vertex-scoped key (starts with "AQ…") and is rejected by the AI Studio endpoint.
gemini = genai.Client(vertexai=True, api_key=GEMINI_API_KEY)

PROMPT_TEMPLATE = """\
You are a business-intelligence analyst extracting relationships between companies \
for a knowledge graph. You must be extremely literal: ONLY use the evidence text \
provided below; NEVER use your training knowledge.

Source company: {source}
Target company: {target}

Evidence (lines from {source}'s indexed website that mention "{target}"):
<<<EVIDENCE_START
{evidence}
EVIDENCE_END>>>

Task: classify the relationship from {source}'s perspective toward {target}.

Relationship types (pick exactly one):
- "competitor": they serve the same customers with overlapping products
- "partner": formal partnership, integration, co-marketing, or joint announcement
- "investor": one invested in the other, or they share a named major investor
- "downstream": {source} uses {target} as infrastructure or vice versa
- "talent": documented hires / founders / executives moving between the two
- "none": evidence is only a passing mention with no real relationship \
(logos on a wall, keyword match, unrelated context)

Strict rules:
1. The `evidence_quote` MUST be an exact substring of the evidence above, \
<=15 words, that supports your classification. Copy verbatim; no paraphrasing.
2. If you pick "none", set `evidence_quote` to "" and `confidence` to "low".
3. A single mention of a company's name (e.g. in a logo wall) is NOT a partnership. \
Require explicit relationship language: "partnership with", "integrates with", \
"invested in", "powered by", "hired from", etc.
4. If uncertain, prefer "none" over guessing.
"""


def _is_rate_limit(exc: BaseException) -> bool:
    return isinstance(exc, genai_errors.ClientError) and getattr(exc, "code", None) == 429


@retry(
    retry=retry_if_exception(_is_rate_limit),
    wait=wait_exponential(multiplier=2, min=15, max=60),
    stop=stop_after_attempt(4),
    reraise=True,
)
def _gemini_call(prompt: str) -> str:
    resp = gemini.models.generate_content(
        model=MODEL,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.0,
            response_mime_type="application/json",
            response_schema=Edge,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        ),
    )
    return resp.text


def extract_edge(source: Company, target: Company, evidence: list[str]) -> Edge | None:
    if not evidence:
        return None
    prompt = PROMPT_TEMPLATE.format(
        source=source.name,
        target=target.name,
        evidence="\n".join(f"- {ln}" for ln in evidence),
    )
    raw = _gemini_call(prompt)
    data = json.loads(raw)
    edge = Edge(**data)
    # Post-validation: evidence_quote must literally appear in the evidence we sent.
    if edge.type != "none":
        haystack = " || ".join(evidence).lower()
        if edge.evidence_quote.strip().lower() not in haystack:
            print(
                f"  [hallucinated-quote rejected] {source.name}->{target.name}: "
                f"{edge.evidence_quote!r}",
                file=sys.stderr,
            )
            return None
    return edge


# ---- driver ----

def run(companies: list[Company]) -> list[dict]:
    edges: list[dict] = []
    OUTPUT_PATH.write_text("[]\n")  # start fresh
    for src in companies:
        if not src.index_id:
            continue
        for tgt in companies:
            if src.domain == tgt.domain:
                continue
            ev = gather_evidence(src, tgt)
            print(f"{src.name} -> {tgt.name}: {len(ev)} evidence line(s)")
            if not ev:
                continue
            for line in ev[:3]:
                print(f"    · {line[:110]}")
            t0 = time.time()
            try:
                edge = extract_edge(src, tgt, ev)
            except genai_errors.ClientError as e:
                print(f"    !! gemini error (code={e.code}): retry exhausted; skipping")
                continue
            dt = time.time() - t0
            if edge is None:
                print(f"    => skip ({dt:.1f}s)")
                continue
            print(f"    => {edge.type} [{edge.confidence}] ({dt:.1f}s)  {edge.evidence_quote!r}")
            if edge.type != "none":
                edges.append({
                    "source": src.name,
                    "target": tgt.name,
                    **edge.model_dump(),
                })
                OUTPUT_PATH.write_text(json.dumps(edges, indent=2) + "\n")
            time.sleep(INTER_CALL_SLEEP_S)
    return edges


def main() -> None:
    # Real indexes (have corpora we can grep):
    langchain = Company("LangChain", "langchain.com", "198c38ea-fe4d-4ec2-bf31-0055b4a2c827")
    mongodb   = Company("MongoDB",   "mongodb.com",   "e2f778a9-cdc6-49ef-8c8e-890ff366f38d")
    # Name-only targets (no index yet — we only need their name as a grep pattern):
    # Using empty index_id; we skip iterations where SRC would need to grep its own corpus.
    anthropic = Company("Anthropic", "anthropic.com", "")
    nvidia    = Company("NVIDIA",    "nvidia.com",    "")
    multion   = Company("MultiOn",   "multion.ai",    "")
    new_comp  = Company("New Computer", "newcomputer.ai", "")

    companies = [langchain, mongodb, anthropic, nvidia, multion, new_comp]
    edges = run(companies)
    print("\n=== FINAL EDGES ===")
    print(json.dumps(edges, indent=2))


if __name__ == "__main__":
    main()
