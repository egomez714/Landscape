"""Gemini client (Google AI Studio).

Runtime LLM for Landscape. Two call sites:
  1. Query → candidate company list   (Gemini 2.5 Flash, cheap/fast)
  2. Indexed content → structured relationships   (Gemini 2.5 Pro, stricter)

Vertex AI on Google Cloud (MLH credits) is the rate-limit fallback.
Fill in methods during Hours 2-5 (extraction) and Hours 5-9 (query parser).
"""

from __future__ import annotations

from google import genai

from app.config import settings

# 2.5 Pro is limit:0 on AI Studio free tier; 2.5 Flash is 5 RPM; Flash-Lite is 15 RPM and handles
# this task (classification with strict structured output) at the same quality. See memory.
MODEL_EXTRACTION = "gemini-2.5-flash-lite"
MODEL_QUERY_PARSER = "gemini-2.5-flash-lite"


class GeminiClient:
    def __init__(self, api_key: str | None = None) -> None:
        # Vertex AI Express mode: API-key auth on Vertex endpoint (aiplatform.googleapis.com).
        # Bills against GCP credits; avoids AI Studio's 20 RPD free-tier cap.
        self._client = genai.Client(
            vertexai=True,
            api_key=api_key or settings.gemini_api_key,
        )

    async def parse_query(self, query: str) -> list[str]:
        """Return 8-12 candidate company names for the given industry query.

        TODO(hours 5-9): implement with Flash.
        """
        raise NotImplementedError

    async def extract_relationships(
        self,
        *,
        company_a: str,
        company_list: list[str],
        indexed_passages: list[str],
    ) -> list[dict]:
        """Return structured relationships with evidence quotes.

        Schema per CLAUDE.md:
          { source, target, type, evidence_quote, confidence }

        TODO(hours 2-5): iterate prompt in CLI until clean JSON for 3 test queries.
        Must post-validate that evidence_quote actually appears in indexed_passages —
        Gemini is more likely than Claude to slip in training-knowledge inferences.
        """
        raise NotImplementedError
