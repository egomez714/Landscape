"""Unit tests for the URL-path page classifier and aggregator detector.

These are the structural signals that replaced the old "count evidence lines
and pick the direction with more" heuristic. They're pure functions — no HD
or Gemini needed — so they can lock in the specific failure modes from the
Qdrant→Redis and DeepSeek→Replicate regressions.
"""

from app.clients.humandelta import (
    AGGREGATOR_DOMAINS,
    _is_aggregator_url,
    classify_page_type,
)
from app.clients.gemini import _canonicality_score, _is_usable_candidate
from app.models import CompanyCandidate


class TestClassifyPageType:
    def test_migrate_page(self) -> None:
        # The Qdrant→Redis regression: migrate page must not read as `uses`.
        assert classify_page_type(
            "/documentation/migrate-to-qdrant/from-redis/"
        ) == "migrate"
        assert classify_page_type("/migration/from-elasticsearch") == "migrate"
        assert classify_page_type("/switch-from-pinecone") == "migrate"

    def test_compare_page(self) -> None:
        assert classify_page_type("/compare/pinecone-vs-chroma") == "compare"
        assert classify_page_type("/comparisons/weaviate") == "compare"
        assert classify_page_type("/alternatives/redis") == "compare"

    def test_partner_and_integration(self) -> None:
        assert classify_page_type("/partners") == "partner"
        assert classify_page_type("/integrations/anthropic") == "integration"
        assert classify_page_type("/marketplace/plugin") == "integration"

    def test_customer(self) -> None:
        assert classify_page_type("/customers") == "customer"
        assert classify_page_type("/case-studies/notion") == "customer"
        assert classify_page_type("/success-stories") == "customer"

    def test_docs_blog_about_press(self) -> None:
        assert classify_page_type("/docs/api/auth") == "docs"
        assert classify_page_type("/reference/endpoints") == "docs"
        assert classify_page_type("/blog/launch-day") == "blog"
        assert classify_page_type("/news/hiring") == "blog"
        assert classify_page_type("/press/announcement-q2") == "press"
        assert classify_page_type("/about/team") == "about"

    def test_fallback(self) -> None:
        assert classify_page_type("/") == "other"
        assert classify_page_type("/pricing") == "other"
        assert classify_page_type("") == "other"

    def test_ordering_migrate_wins_over_about(self) -> None:
        # A path containing both "/about" and "/migrate" should classify as
        # migrate — the more specific signal wins, which matches the prompt's
        # prior ordering in _PAGE_TYPE_PATTERNS.
        assert classify_page_type("/migrate-from-legacy/about-why") == "migrate"


class TestAggregatorDetection:
    def test_flags_known_aggregators(self) -> None:
        for host in ("huggingface.co", "replicate.com", "github.com"):
            assert _is_aggregator_url(f"https://{host}/some/path")

    def test_flags_subdomains_of_aggregators(self) -> None:
        # DeepSeek's github URL was github.com/deepseek-ai — subdomain-level
        # must still flag, and so must `blog.github.com` style variants.
        assert _is_aggregator_url("https://blog.github.com/anything")
        assert _is_aggregator_url("https://someone.huggingface.co/models")

    def test_first_party_sites_not_flagged(self) -> None:
        assert not _is_aggregator_url("https://anthropic.com/customers/notion")
        assert not _is_aggregator_url("https://qdrant.tech/documentation")


class TestCanonicalCandidatePick:
    def test_aggregator_candidates_rejected(self) -> None:
        # The DeepSeek regression: parse_query returned DeepSeek at
        # github.com/deepseek-ai. That must not pass.
        gh = CompanyCandidate(name="DeepSeek", url="https://github.com/deepseek-ai")
        hf = CompanyCandidate(name="SomeModel", url="https://huggingface.co/a/b")
        assert not _is_usable_candidate(gh)
        assert not _is_usable_candidate(hf)

    def test_first_party_candidates_accepted(self) -> None:
        ok = CompanyCandidate(name="Anthropic", url="https://www.anthropic.com")
        assert _is_usable_candidate(ok)

    def test_canonical_name_beats_sub_product_name(self) -> None:
        # The AWS vs AWS AI Services regression: when both resolve to the
        # same domain, prefer the name whose first token matches a domain
        # label ("aws" ∈ {aws, amazon, com}) and ties broken by shorter name.
        aws = CompanyCandidate(name="AWS", url="https://aws.amazon.com")
        aws_ai = CompanyCandidate(
            name="AWS AI Services", url="https://aws.amazon.com",
        )
        # Lower is better — AWS must win.
        assert _canonicality_score(aws) < _canonicality_score(aws_ai)

    def test_aggregator_domain_constant_stable(self) -> None:
        # Load-bearing list: the prompt tells Gemini to reject these, so the
        # set must stay populated. Guard against someone accidentally emptying
        # it during a refactor.
        assert "huggingface.co" in AGGREGATOR_DOMAINS
        assert "replicate.com" in AGGREGATOR_DOMAINS
        assert "github.com" in AGGREGATOR_DOMAINS
