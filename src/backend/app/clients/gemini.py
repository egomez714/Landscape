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
import logging
from collections import Counter
from typing import Literal
from urllib.parse import urlparse

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, Field

from app.clients.humandelta import AGGREGATOR_DOMAINS, EvidenceLine
from app.config import settings
from app.models import CompanyCandidate, Edge

log = logging.getLogger(__name__)

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
You are a business-intelligence analyst extracting relationships between two \
companies for a knowledge graph. You must be extremely literal: ONLY use the \
evidence text provided below; NEVER use your training knowledge.

Company A: {a_name}
Company B: {b_name}

Each evidence line is pre-tagged with the page it came from:
  - [<page_type> | <url_path>] "text"
Page types you will see: `compare`, `migrate`, `partner`, `integration`, \
`customer`, `docs`, `blog`, `press`, `about`, `other`. Lines from aggregator \
hosts (Hugging Face, Replicate, GitHub, npm, PyPI, Product Hunt, Wikipedia, \
etc.) are additionally marked `aggregator` — those are THIRD-PARTY uploads \
or listings, not statements from either company, and must not be the sole \
basis of any classification.

Evidence from {a_name}'s corpus (lines mentioning {b_name}):
<<<EVIDENCE_A_START
{evidence_a_to_b}
EVIDENCE_A_END>>>

Evidence from {b_name}'s corpus (lines mentioning {a_name}):
<<<EVIDENCE_B_START
{evidence_b_to_a}
EVIDENCE_B_END>>>

Task: classify the relationship AND pick its direction.

Relationship types:
- "competitor": they serve overlapping customers / compete for the same \
users. Examples: comparison pages (`compare`), migration pages (`migrate` — \
"move off Y to X"), alternatives pages, "X vs Y".
- "partner": formal partnership, integration, co-marketing, joint \
announcement. Usually symmetric.
- "uses": one company is built on the other as infrastructure or a technical \
dependency, IN PRESENT TENSE — "we use X", "built on X", "powered by X", \
"runs on X". Never pick this when the supporting evidence is a `compare` or \
`migrate` page.
- "customer": one side is a commercial customer of the other. Case studies, \
testimonials, "trusted by" lists that include context.
- "none": no real relationship visible — passing mentions, logo walls, \
lists, keyword matches.

Direction (pick exactly one):
- "a_to_b": {a_name} is the subject — {a_name} uses/is-customer-of/etc. {b_name}.
- "b_to_a": {b_name} is the subject.
- "symmetric": the relationship is mutual — partnerships and competitors \
almost always resolve here. Prefer "symmetric" for `partner`/`competitor` \
unless the evidence clearly gives one side agency.

PAGE-TYPE PRIORS (URL-path signal is stronger than sentence phrasing):
- `[compare]` or `[migrate]`   → `competitor`. Never `uses`.
- `[partner]` or `[integration]` → `partner` (or `uses` only if the sentence \
  explicitly says built-on / powered-by).
- `[customer]`                 → `customer`.
- `[docs]` / `[blog]` / `[about]` / `[press]` / `[other]` → decide from the \
  sentence; require explicit relationship language; default `none`.

Strict rules:
1. The `evidence_quote` MUST be an exact substring of the text of one of the \
evidence lines above, <=15 words. Copy verbatim; no paraphrasing.
2. If you pick "none", set `evidence_quote` to "" and `confidence` to "low".
3. A single name-drop in a logo wall, a list, or a ranking is NOT a \
relationship — require explicit relationship language.
4. Image filenames, URLs, src=, alt-text are NEVER evidence.
5. If uncertain, prefer "none".
6. AGGREGATOR RULE: if EVERY supporting evidence line is tagged \
`aggregator`, return "none". Aggregator lines corroborate only — they are \
never the primary basis for a `uses`/`partner`/`customer` claim.
7. The direction must match the evidence that supports the quote. If the \
quote is from A's corpus describing B as a dependency, pick `a_to_b` \
(A uses B). If it's from a migrate page on A's corpus about moving off B, \
that's `competitor` and `symmetric`.
"""

QUERY_PARSER_PROMPT = """\
You are helping build a knowledge graph of companies in an industry.

User query: "{query}"

Return 8-12 specific, well-known companies that match this query. For each, provide \
its display name and its homepage URL (starting with https://www.). Prefer companies \
with public blogs or docs that can be crawled. Skip vaporware and defunct companies.

Name rules:
- Use the canonical company name, not a sub-product or service line (e.g. "AWS", \
not "AWS AI Services"; "OpenAI", not "ChatGPT"). Sub-product names cause the graph \
to have two nodes that resolve to the same corpus.
- Prefer the name whose first token matches a label in the homepage domain \
(e.g. "Replicate" for replicate.com, "Anthropic" for anthropic.com).

URL rules:
- Homepage must be the company's own canonical domain, not an aggregator, \
marketplace, code host, or social platform. Never return GitHub org pages \
(github.com/<org>), Hugging Face profiles (huggingface.co/<org>), npm/PyPI \
pages, Product Hunt, Crunchbase, LinkedIn, Twitter/X, YouTube, Medium, or \
Wikipedia as a company's homepage — those are hosting/listing venues, not \
companies. If the company only publishes via such a venue, skip it.

If the query names a single person, product, or technology rather than an industry \
(e.g. "Sam Altman", "ChatGPT", "Kubernetes", "Rust"), infer the most likely industry \
from context and return the companies operating in THAT industry — never return the \
person as a company, and never return only the single product's maker. Examples: \
"Sam Altman" → AI labs (OpenAI, Anthropic, Google DeepMind, xAI, Mistral, …). \
"ChatGPT" → chatbot/assistant companies (OpenAI, Anthropic, Google, Perplexity, …). \
"Kubernetes" → cloud-native infra companies (Docker, Red Hat, Rancher, Platform9, …).
"""

SUMMARY_PROMPT = """\
Summarize what {company} does in ONE sentence, at most 20 words. Say what they \
build and who their customers are. Use only the text below; do not invent facts.

Text from their website:
<<<
{content}
>>>
"""

EXPANSION_PROMPT = """\
You are analyzing text from {company}'s website. List other *independent companies* \
mentioned in the text, and CLASSIFY each one.

For each candidate, return:
  - name: the company name as it appears in the text.
  - evidence_quote: an exact quote (<=20 words) from the text that mentions the \
company. MUST be a literal substring of the text below — no paraphrasing.
  - homepage_url: the company's own homepage URL (with scheme, e.g. \
"https://www.openai.com"). REQUIRED. If you don't know it or it doesn't appear in \
the text, omit the candidate entirely — do not guess, do not return null.
  - category: one of the labels below. Choose the BEST fit. If genuinely ambiguous, \
use "unclear" rather than forcing a category — we'll include it anyway.

Category rules (pick exactly one):
  - "peer": direct competitors or adjacent companies the reader would research \
together with {company}. Example: for Anthropic → OpenAI, Cohere, Mistral.
  - "integration_partner": companies with a named formal integration or joint \
product. Example: LangChain ↔ MongoDB partnership.
  - "customer": a company that USES {company}'s product. Example: Notion uses \
Anthropic's models.
  - "investor": a VC firm or strategic backer named as such. Example: Spark Capital.
  - "infrastructure": cloud/db/tooling that {company} BUILDS ON. Example: for \
Anthropic → AWS Bedrock, GCP. These are NOT peers.
  - "distribution_channel": social media, app stores, podcasts, content platforms, \
code hosting. Examples: YouTube, Twitter/X, LinkedIn, GitHub, Product Hunt, \
Hacker News, TikTok, Discord. These are venues where content is POSTED, not \
companies worth researching as peers. Always REJECTED by default downstream.
  - "event_venue": conferences, convention centers, event series. Examples: \
Excel London, Moscone Center, NeurIPS, Web Summit. Always REJECTED by default.
  - "unclear": genuinely ambiguous — the text mentions the name but you can't \
tell what the relationship is. Use sparingly; better than forcing a wrong label.

Hard rules:
1. Only INDEPENDENT companies. Reject sub-products, services, or sub-brands of \
{company} itself (e.g. if source is "Amazon", do NOT return "AWS", "AWS Lambda"; \
if source is "OpenAI", do NOT return "ChatGPT" or "GPT-4").
2. Ignore generic technology categories and common nouns (AI, API, ML, LLM, Cloud, \
Database, Vector Search, Platform, SaaS, Infrastructure, SDK, Framework, Open \
Source, etc.).
3. Prefer proper nouns — real company names, not product categories.
4. Return at most 12 candidates. Fewer is fine. Prefer peer and integration_partner \
candidates if you have to choose.
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


ExpansionCategory = Literal[
    "peer",
    "integration_partner",
    "customer",
    "investor",
    "infrastructure",
    "distribution_channel",
    "event_venue",
    "unclear",
]

# Two-pass filter for "find more like this". Strict pass keeps peers + integration
# partners (the common interpretation) plus `unclear` (safety net for the LLM's
# own uncertainty). If that returns zero, we relax to also include customers +
# investors + infrastructure — still grounded, just a wider net. The truly useless
# categories (distribution_channel, event_venue) are ALWAYS dropped.
_STRICT_ACCEPTED_CATEGORIES: frozenset[str] = frozenset({
    "peer", "integration_partner", "unclear",
})
_RELAXED_ACCEPTED_CATEGORIES: frozenset[str] = frozenset({
    "peer", "integration_partner", "unclear",
    "customer", "investor", "infrastructure",
})


class _ExpansionCandidate(BaseModel):
    name: str
    evidence_quote: str
    homepage_url: str | None = None
    category: ExpansionCategory = "unclear"


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
        # Two filters + a canonical-name pick:
        #   1. Drop aggregator / marketplace / social sites — they don't belong
        #      as authoritative corpus sources. A DeepSeek node at
        #      github.com/deepseek-ai produced wrong-direction edges because the
        #      crawled corpus was actually NVIDIA's + chenxwh's uploads, not
        #      DeepSeek's. Better to skip than to mislead.
        #   2. Group by full domain and pick the most canonical name. Gemini
        #      returned both "AWS" and "AWS AI Services" at aws.amazon.com; the
        #      second got added, then Find More proposed AWS, and the frontend
        #      silently dropped it as a duplicate-domain. Picking "AWS" (the
        #      canonical name matching the domain's root label) up-front
        #      prevents that UX dead end.
        filtered = [c for c in parsed.companies if _is_usable_candidate(c)]
        by_domain: dict[str, list[CompanyCandidate]] = {}
        for c in filtered:
            by_domain.setdefault(c.domain, []).append(c)
        return [
            min(group, key=_canonicality_score)
            for group in by_domain.values()
        ]

    # ---- relationship extraction ----

    async def extract_relationship(
        self,
        *,
        a_name: str,
        b_name: str,
        evidence_a_to_b: list[EvidenceLine],
        evidence_b_to_a: list[EvidenceLine],
    ) -> Edge | None:
        """Run one extraction call with BOTH directions' evidence. The LLM picks
        the direction itself from the structural signals on each line (page_type
        and url_path). Returns None if the model hallucinated the quote.
        """
        if not evidence_a_to_b and not evidence_b_to_a:
            return None

        prompt = EXTRACTION_PROMPT.format(
            a_name=a_name,
            b_name=b_name,
            evidence_a_to_b=_format_evidence_block(evidence_a_to_b),
            evidence_b_to_a=_format_evidence_block(evidence_b_to_a),
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
        # Post-validate: evidence_quote must be a literal substring of one of
        # the provided lines, across either direction. Substring check mirrors
        # the same correctness gate as before — it's the single cheapest
        # anti-hallucination control we have.
        if edge.type != "none":
            haystack = " || ".join(
                e.text for e in (*evidence_a_to_b, *evidence_b_to_a)
            ).lower()
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
        # In-prompt cap matches what the caller actually fetched (24 KB). Flash-Lite
        # handles ~6K tokens trivially, and cutting earlier wastes the extra HD
        # bytes we already paid for in expand_from_node's summarize_page call.
        prompt = EXPANSION_PROMPT.format(
            company=source_company,
            exclusions=exclusion_list_str,
            content=corpus_text[:24000],
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

        # Telemetry: log the pre-filter category distribution so we can tune
        # the accepted set from real data instead of guessing.
        raw_category_counts = Counter(
            (c.category or "unclear") for c in parsed.candidates
        )
        log.info(
            "expansion candidates for %s: %d raw, by category %s",
            source_company, len(parsed.candidates), dict(raw_category_counts),
        )

        # First pass: filter out everything except the safe/unambiguous core.
        # Every other non-category check is independent of category (substring
        # validation, generic excludes, homepage URL, same-root rejection) so we
        # compute a single pre-filtered pool then choose a category-accept set.
        prefiltered: list[_ExpansionCandidate] = []
        seen_names: set[str] = set()
        for c in parsed.candidates:
            name_l = c.name.lower().strip()
            if not name_l or name_l in seen_names:
                continue
            if c.evidence_quote.lower().strip() not in haystack:
                continue
            if name_l in exclusion_names or name_l in GENERIC_EXCLUDES:
                continue
            if (
                name_l.isalpha()
                and name_l == name_l.lower()
                and " " not in name_l
                and len(name_l) < 4
            ):
                continue
            normalized_url = _normalize_url(c.homepage_url)
            if not normalized_url:
                continue
            c = c.model_copy(update={"homepage_url": normalized_url})
            candidate_root = _root_domain(normalized_url)
            if candidate_root and source_root and candidate_root == source_root:
                continue
            # distribution_channel and event_venue are *always* dropped — these
            # are footers/logos/event names, never what the user wants.
            if c.category in {"distribution_channel", "event_venue"}:
                continue
            prefiltered.append(c)
            seen_names.add(name_l)

        # Strict pass: peer + integration_partner + unclear only.
        strict = [c for c in prefiltered if c.category in _STRICT_ACCEPTED_CATEGORIES]
        if strict:
            log.info(
                "expansion for %s: %d strict candidates (categories: %s)",
                source_company, len(strict),
                dict(Counter(c.category for c in strict)),
            )
            return strict

        # Fallback: relax to include customer + investor + infrastructure.
        # Same grounding, wider net — better than returning empty.
        relaxed = [c for c in prefiltered if c.category in _RELAXED_ACCEPTED_CATEGORIES]
        log.info(
            "expansion for %s: strict empty, relaxed returned %d (categories: %s)",
            source_company, len(relaxed),
            dict(Counter(c.category for c in relaxed)),
        )
        return relaxed

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


def _format_evidence_block(lines: list[EvidenceLine]) -> str:
    """Render EvidenceLines as the tagged list the extraction prompt consumes.

    Each line becomes:
      - [<page_type> | <url_path>] "<text>"
    with an `aggregator ` prefix on page_type if the line originates from a
    third-party-upload host. An empty list renders as "(no evidence)" so the
    LLM sees a deterministic placeholder rather than a blank.
    """
    if not lines:
        return "(no evidence)"
    out: list[str] = []
    for ln in lines:
        pt = ("aggregator " + ln.page_type) if ln.is_aggregator else ln.page_type
        path = ln.url_path or "/"
        out.append(f'- [{pt} | {path}] "{ln.text}"')
    return "\n".join(out)


def _is_usable_candidate(c: CompanyCandidate) -> bool:
    """Reject parse_query candidates that aren't really companies — aggregator
    sites, code hosts, marketplaces. These produce wrong-direction edges
    because their corpus is other people's content, not the platform's own.
    """
    dom = (c.domain or "").lower()
    if not dom:
        return False
    if dom in AGGREGATOR_DOMAINS:
        return False
    # Catch subdomains of aggregators too: `blog.github.com`, `chenxwh.huggingface.co`.
    root = _root_domain(f"https://{dom}")
    if root and root in AGGREGATOR_DOMAINS:
        return False
    return True


def _canonicality_score(c: CompanyCandidate) -> tuple[int, int]:
    """Lower is better. Used to pick the best name when Gemini returns multiple
    candidates at the same domain (e.g. "AWS" and "AWS AI Services" at
    aws.amazon.com). Prefer names whose first token matches a domain label,
    then the shorter name.
    """
    name_first = c.name.split()[0].lower() if c.name else ""
    labels = {lbl for lbl in (c.domain or "").split(".") if lbl}
    matches = 0 if name_first in labels else 1
    return (matches, len(c.name))


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
