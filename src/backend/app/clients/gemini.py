"""Gemini client (Vertex AI Express mode).

Routes to aiplatform.googleapis.com and bills against GCP credits. The AI Studio key
(`AIza...`) is explicitly rejected by Vertex; the Vertex key (`AQ...`) is explicitly
rejected by AI Studio. We use the Vertex key — see docs/api-notes.md and memory.

Two call sites:
  1. parse_query(query) → candidate companies (Flash-Lite)
  2. extract_relationships(source, target, evidence) → structured Edge (Flash-Lite)

Free-tier AI Studio caps (20 RPD, 5-10 RPM) do not apply; Vertex defaults are ~60 RPM
and enough credits for thousands of calls.
"""

from __future__ import annotations

import asyncio
import json

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, Field

from app.config import settings
from app.models import CompanyCandidate, Edge

# Both tasks are cheap classification with strict structured output, so Flash-Lite is
# sufficient for both. Plan originally called for Pro (extraction) + Flash (parsing),
# but Pro is limit:0 on AI Studio and unnecessary on Vertex given the task difficulty.
MODEL_EXTRACTION = "gemini-2.5-flash-lite"
MODEL_QUERY_PARSER = "gemini-2.5-flash-lite"


class _CandidateList(BaseModel):
    """Private schema for parse_query's structured-output response."""
    companies: list[CompanyCandidate] = Field(
        description="8-12 well-known companies matching the query. "
                    "Include homepage URL (https://www.example.com).",
    )


EXTRACTION_PROMPT = """\
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

QUERY_PARSER_PROMPT = """\
You are helping build a knowledge graph of companies in an industry.

User query: "{query}"

Return 8-12 specific, well-known companies that match this query. For each, provide \
its display name and its homepage URL (starting with https://www.). Prefer companies \
with public blogs or docs that can be crawled. Skip vaporware and defunct companies.
"""


class GeminiClient:
    def __init__(self, api_key: str | None = None) -> None:
        self._client = genai.Client(
            vertexai=True,
            api_key=api_key or settings.gemini_api_key,
        )

    # ---- query parsing ----

    async def parse_query(self, query: str) -> list[CompanyCandidate]:
        """Return 8-12 candidate companies for the given industry query."""
        resp = await asyncio.to_thread(
            self._client.models.generate_content,
            model=MODEL_QUERY_PARSER,
            contents=QUERY_PARSER_PROMPT.format(query=query),
            config=types.GenerateContentConfig(
                temperature=0.2,
                response_mime_type="application/json",
                response_schema=_CandidateList,
                thinking_config=types.ThinkingConfig(thinking_budget=0),
            ),
        )
        parsed = _CandidateList(**json.loads(resp.text))
        # Deduplicate by domain in case the model returns near-duplicates.
        seen: set[str] = set()
        uniq: list[CompanyCandidate] = []
        for c in parsed.companies:
            if c.domain and c.domain not in seen:
                seen.add(c.domain)
                uniq.append(c)
        return uniq

    # ---- relationship extraction ----

    async def extract_relationship(
        self,
        *,
        source_name: str,
        target_name: str,
        evidence: list[str],
    ) -> Edge | None:
        """Run one extraction call. Returns None if the model hallucinated the quote."""
        if not evidence:
            return None

        prompt = EXTRACTION_PROMPT.format(
            source=source_name,
            target=target_name,
            evidence="\n".join(f"- {ln}" for ln in evidence),
        )
        try:
            resp = await asyncio.to_thread(
                self._client.models.generate_content,
                model=MODEL_EXTRACTION,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.0,
                    response_mime_type="application/json",
                    response_schema=Edge,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
        except genai_errors.ClientError:
            return None

        data = json.loads(resp.text)
        edge = Edge(**data)
        # Post-validate: evidence_quote must be a literal substring of the evidence.
        if edge.type != "none":
            haystack = " || ".join(evidence).lower()
            if edge.evidence_quote.lower() not in haystack:
                return None
        return edge
