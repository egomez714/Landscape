"""Shared pydantic models used across services and the SSE contract."""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

RelationshipType = Literal[
    "competitor", "partner", "uses", "customer", "none",
]
Confidence = Literal["high", "medium", "low"]

# Direction of the extracted edge relative to the (A, B) pair passed into the
# LLM. Asymmetric types (`uses`, `customer`) force the model to pick a_to_b or
# b_to_a; symmetric types (`partner`, `competitor`) usually resolve to
# `symmetric`. Used to map back onto source/target when building a GraphEdge.
Direction = Literal["a_to_b", "b_to_a", "symmetric"]


class CompanyCandidate(BaseModel):
    """One company returned from the query parser."""
    name: str = Field(description="Display name for grep patterns and graph nodes.")
    url: str = Field(description="Root URL to crawl via Human Delta, e.g. https://www.example.com")

    @property
    def domain(self) -> str:
        host = urlparse(self.url).hostname or self.url
        return host[4:] if host.startswith("www.") else host


class IndexedCompany(BaseModel):
    """A CompanyCandidate that has been successfully indexed by Human Delta."""
    name: str
    url: str
    domain: str
    index_id: str
    page_count: int


class Edge(BaseModel):
    """Output of the relationship extractor for one (A, B) pair.

    The LLM sees evidence from *both* corpora and picks a `direction` along
    with the `type`. Callers map this back to source/target on the emitted
    GraphEdge. Earlier versions had the extractor pick direction by evidence
    line count alone, which collapsed to the wrong direction whenever one
    corpus was larger — that heuristic is now the model's job, informed by
    per-line page-type tags."""
    type: RelationshipType
    direction: Direction = Field(
        default="a_to_b",
        description="Direction of the relationship relative to the (A, B) pair "
                    "passed in. Use 'symmetric' for partnerships/competitors "
                    "unless the evidence clearly points one way.",
    )
    evidence_quote: str = Field(
        description="Verbatim substring of one of the provided evidence lines, "
                    "<=15 words. Empty string only when type='none'.",
    )
    confidence: Confidence

    @field_validator("evidence_quote")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class EvidenceSnippet(BaseModel):
    """One passage backing an edge, with a link to the page it came from."""
    text: str
    source_url: str


class GraphEdge(BaseModel):
    """An Edge attached to its source/target pair, as streamed to the frontend.

    `evidence` is a list of 1-3 snippets. The first is the LLM-chosen quote; the rest
    are additional grep-matched passages from the same pair for context.
    """
    source: str
    target: str
    type: RelationshipType
    confidence: Confidence
    evidence: list[EvidenceSnippet]
