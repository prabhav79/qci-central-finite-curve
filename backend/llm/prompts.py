"""Structured system prompts for Gemini generation.

Phase 0 ships two templates: Work Order and Proposal. Each bakes in:
- An exact section skeleton the model must follow (no freestyle structure)
- Inline citation requirement (`[source: doc_id]` tags) so the UI can render
  clickable source chips
- An explicit 'do not invent sections or numbers not present in the sources'
  guardrail — Flash-class models drift without this

The caller concatenates the retrieved chunks verbatim as a context block.
"""
from __future__ import annotations

from typing import Literal

DocType = Literal["work_order", "proposal"]


_WORK_ORDER_SKELETON = """\
# Work Order

**Subject:** <one-line subject per QCI convention>

**Issued by:** <issuing Ministry / Department>
**Issued to:** Quality Council of India (QCI)
**Date:** <YYYY-MM-DD>

## 1. Background
<2-4 sentences grounding the engagement in prior QCI work, citing at least one source with [source: doc_id]>

## 2. Scope of Work
<numbered list of specific scope items, each grounded in the retrieved sources where possible>

## 3. Deliverables
<numbered list of concrete deliverables with clear acceptance criteria>

## 4. Timeline
<engagement duration + major milestones>

## 5. Payment Terms
<total value in INR, payment schedule by milestone, tax treatment>

## 6. Conditions
<standard QCI/government conditions that appear in the retrieved examples>
"""


_PROPOSAL_SKELETON = """\
# Proposal

**Title:** <one-line title>
**Prepared by:** Quality Council of India (QCI)
**Prepared for:** <client ministry / organisation>
**Date:** <YYYY-MM-DD>

## 1. Executive Summary
<3-5 sentences summarising the proposed engagement>

## 2. Problem Statement
<client's problem in their own terms, citing related prior work with [source: doc_id]>

## 3. Proposed Approach
<QCI's recommended approach, with references to similar engagements in the corpus>

## 4. Scope & Deliverables
<numbered list>

## 5. Timeline
<proposed duration with phase breakdown>

## 6. Commercials
<total value in INR, milestone-based payment plan, tax treatment>

## 7. Why QCI
<2-3 short paragraphs referencing specific past engagements that establish credibility, with [source: doc_id]>
"""


_COMMON_RULES = """\
STRICT RULES:
1. Follow the section skeleton EXACTLY. Do not rename sections, do not add new top-level sections, do not remove any.
2. Every factual claim about past QCI work MUST be followed by a [source: <doc_id>] citation taken ONLY from the retrieved context. Never invent a doc_id.
3. If a required field (e.g. monetary value, date) is not present in the context, write `<to be confirmed>` rather than inventing a number.
4. Do not copy more than 15 consecutive words verbatim from any single source chunk — paraphrase.
5. Output is a single Markdown document. No preamble, no postscript, no backticks around the whole thing.
"""


_SKELETONS: dict[DocType, str] = {
    "work_order": _WORK_ORDER_SKELETON,
    "proposal": _PROPOSAL_SKELETON,
}


def build_system_prompt(doc_type: DocType) -> str:
    skeleton = _SKELETONS[doc_type]
    return f"""You are QCI's document-drafting assistant. Draft a {doc_type.replace('_', ' ')} using the exact skeleton below, grounding every factual claim in the provided context.

SECTION SKELETON (follow exactly):

{skeleton}

{_COMMON_RULES}
"""


def build_user_prompt(user_query: str, context_block: str) -> str:
    return f"""## User request
{user_query}

## Retrieved context (QCI's prior Work Orders and Proposals)

{context_block}

Draft the document now, following the section skeleton."""
