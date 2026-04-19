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

from urllib.parse import urlparse

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
4. Image filenames, URLs, and logo references (e.g. "logo.svg", "elastic-search.png", \
"src=...", alt-text on images) are NEVER evidence of a relationship. If the only \
evidence is a file URL or image reference, classify as "none".
5. If uncertain, prefer "none" over guessing.
"""

QUERY_PARSER_PROMPT = """\
You are helping build a knowledge graph of companies in an industry.

User query: "{query}"

Return 8-12 specific, well-known companies that match this query. For each, provide \
its display name and its homepage URL (starting with https://www.). Prefer companies \
with public blogs or docs that can be crawled. Skip vaporware and defunct companies.
"""

SUMMARY_PROMPT = """\
Summarize what {company} does in ONE sentence, at most 20 words. Write it for a job \
seeker researching this company — say what they build and who their customers are. \
Use only the text below; do not invent facts.

Text from their website:
<<<
{content}
>>>
"""

EXPANSION_PROMPT = """\
You are analyzing text from {company}'s website. List other *independent companies* \
mentioned in the text that the reader could click through to research separately.

For each one, return:
  - name: the company name as it appears in the text
  - evidence_quote: an exact quote from the text (<=20 words) that mentions this \
company. MUST be a literal substring of the text below — no paraphrasing.
  - homepage_url: the company's own homepage URL (with scheme, e.g. \
"https://www.openai.com"). REQUIRED. If you don't know it or it doesn't appear in \
the text, omit the candidate entirely — do not guess, do not return null.

Hard rules:
1. Only INDEPENDENT companies. Reject sub-products, services, or sub-brands of \
{company} itself (e.g. if the source is "Amazon", do NOT return "AWS", "AWS Lambda", \
"Prime Video"; if the source is "OpenAI", do NOT return "ChatGPT" or "GPT-4").
2. Ignore generic technology categories and common nouns (AI, API, ML, LLM, Cloud, \
Database, Vector Search, Vector Database, Platform, SaaS, Infrastructure, SDK, \
Framework, Open Source, etc.).
3. Prefer proper nouns — real company names, not product categories.
4. Return at most 10 candidates. Fewer is fine if you can't find 10 good ones.
5. Skip anything in this exclusion list (case-insensitive): {exclusions}

Text from {company}'s website:
<<<
{content}
>>>
"""

# Additional rejection list applied after the LLM returns — covers common generic
# terms that still sneak through the prompt. Case-insensitive match.
GENERIC_EXCLUDES: frozenset[str] = frozenset({
    "ai", "api", "ml", "llm", "llms", "aiml", "cloud", "vector", "vectors",
    "vector search", "vector database", "vector databases", "database", "databases",
    "platform", "platforms", "data", "infrastructure", "sdk", "tool", "tools",
    "service", "services", "search", "inference", "embedding", "embeddings",
    "neural", "model", "models", "framework", "frameworks", "open source", "oss",
    "saas", "startup", "startups", "company", "companies", "product", "products",
    "software", "app", "apps", "enterprise", "customer", "customers", "user", "users",
})


class _ExpansionCandidate(BaseModel):
    name: str
    evidence_quote: str
    homepage_url: str | None = None


class _ExpansionCandidateList(BaseModel):
    candidates: list[_ExpansionCandidate] = Field(default_factory=list)


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

    # ---- expansion (Feature 2) ----

    async def suggest_expansion_candidates(
        self,
        *,
        source_company: str,
        exclusions: list[str],
        corpus_text: str,
    ) -> list[_ExpansionCandidate]:
        """Given text from one company's corpus, return OTHER company/product names
        mentioned in it (not already in the graph).

        Substring validation: each returned evidence_quote MUST be a literal
        substring of corpus_text. Same rule we use for edge extraction — the only
        defence against hallucinated names.
        """
        if not corpus_text.strip():
            return []

        exclusion_list_str = ", ".join(sorted({e for e in exclusions if e})) or "(none)"
        prompt = EXPANSION_PROMPT.format(
            company=source_company,
            exclusions=exclusion_list_str,
            content=corpus_text[:12000],  # cap prompt size
        )
        try:
            resp = await asyncio.to_thread(
                self._client.models.generate_content,
                model=MODEL_QUERY_PARSER,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.2,
                    response_mime_type="application/json",
                    response_schema=_ExpansionCandidateList,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
        except genai_errors.ClientError:
            return []

        parsed = _ExpansionCandidateList(**json.loads(resp.text))
        haystack = corpus_text.lower()
        exclusion_names = {e.lower().strip() for e in exclusions if e.strip()}
        # Reject candidates whose homepage shares a root domain with the source —
        # those are sub-products of the source company, not independent entities.
        source_root = _root_domain_from_name(source_company, exclusions)

        kept: list[_ExpansionCandidate] = []
        seen_names: set[str] = set()
        for c in parsed.candidates:
            name_l = c.name.lower().strip()
            if not name_l or name_l in seen_names:
                continue
            # Substring validation — same rule as edge extraction.
            if c.evidence_quote.lower().strip() not in haystack:
                continue
            # Reject exclusions + generic terms.
            if name_l in exclusion_names or name_l in GENERIC_EXCLUDES:
                continue
            # Reject short lowercase common words slipping through as proper nouns.
            if (
                name_l.isalpha()
                and name_l == name_l.lower()
                and " " not in name_l
                and len(name_l) < 4
            ):
                continue
            # Must have a usable, parseable homepage URL.
            normalized_url = _normalize_url(c.homepage_url)
            if not normalized_url:
                continue
            c = c.model_copy(update={"homepage_url": normalized_url})
            # Reject sub-products: same root domain as the source.
            candidate_root = _root_domain(normalized_url)
            if candidate_root and source_root and candidate_root == source_root:
                continue
            kept.append(c)
            seen_names.add(name_l)
        return kept

    # ---- company summary ----

    async def summarize_company(self, *, company_name: str, content: str) -> str:
        """One-sentence company summary for the SidePanel."""
        if not content.strip():
            return ""
        prompt = SUMMARY_PROMPT.format(company=company_name, content=content[:4000])
        try:
            resp = await asyncio.to_thread(
                self._client.models.generate_content,
                model=MODEL_QUERY_PARSER,
                contents=prompt,
                config=types.GenerateContentConfig(
                    temperature=0.1,
                    thinking_config=types.ThinkingConfig(thinking_budget=0),
                ),
            )
        except genai_errors.ClientError:
            return ""
        return (resp.text or "").strip()


def _normalize_url(url: str | None) -> str | None:
    """Normalize a homepage URL: ensure scheme, strip whitespace, reject garbage."""
    if not url:
        return None
    u = url.strip()
    if not u:
        return None
    if not u.startswith(("http://", "https://")):
        u = f"https://{u}"
    try:
        parsed = urlparse(u)
    except ValueError:
        return None
    if not parsed.hostname or "." not in parsed.hostname:
        return None
    return u


def _root_domain(url: str) -> str | None:
    """Return the registrable-ish root of a URL: last 2 labels of the hostname.
    Not a real public-suffix parse, but good enough to tell openai.com from
    smith.openai.com or aws.amazon.com from amazon.com.
    """
    try:
        host = urlparse(url).hostname
    except ValueError:
        return None
    if not host:
        return None
    parts = host.split(".")
    if len(parts) < 2:
        return host
    return ".".join(parts[-2:])


def _root_domain_from_name(source_company: str, exclusions: list[str]) -> str | None:
    """We only have the source_company name (e.g. "Langchain") here. Use the
    exclusion list, which usually contains the source's domain, to find a root.
    Fallback: derive from the company name alone (guess X.com).
    """
    for ex in exclusions:
        if "." in ex:
            # Looks like a domain.
            root = _root_domain(f"https://{ex}")
            if root:
                return root
    return None
