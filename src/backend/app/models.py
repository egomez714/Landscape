"""Shared pydantic models used across services and the SSE contract."""

from __future__ import annotations

from typing import Literal
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator

RelationshipType = Literal[
    "competitor", "partner", "investor", "downstream", "talent", "none",
]
Confidence = Literal["high", "medium", "low"]


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
    """Output of the relationship extractor for one (source, target) pair."""
    type: RelationshipType
    evidence_quote: str = Field(
        description="Verbatim substring of the provided evidence, <=15 words. "
                    "Empty string only when type='none'.",
    )
    confidence: Confidence

    @field_validator("evidence_quote")
    @classmethod
    def _strip(cls, v: str) -> str:
        return v.strip()


class GraphEdge(BaseModel):
    """An Edge attached to its source/target pair, as streamed to the frontend."""
    source: str
    target: str
    type: RelationshipType
    evidence_quote: str
    confidence: Confidence
    source_url: str | None = None
