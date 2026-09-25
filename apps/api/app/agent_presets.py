"""
Agent presets — canned system prompts + parameterized user prompts that
drive the standard agent loop toward a specific outcome.

MVP presets:
- precedent_weaver: pull a similar prior WO / proposal from the corpus and
  propose section-appropriate insertions into the current draft.
- draft_generator: generate a full first draft from a natural-language brief,
  one section at a time (see main.py's agent_chat — each section runs as its
  own bounded agent turn rather than one long conversation, since a full
  7-section document needs more tool-call rounds than agent_llm.MAX_STEPS
  allows for a single run_agent conversation).

Future (Sprint 4.5+):
- redline_extender: L1/L2 preset that surfaces likely tracked-change zones
  from historical redline patterns.
- completeness_rater, clarity_pass, citation_auditor, etc.
"""
from __future__ import annotations

from typing import Any

# Narrative order for a generated Work Order — deliberately NOT the regex
# priority order in chunking.py (that list is tuned for label-matching
# specificity, not reading order).
GENERATION_SECTIONS: list[tuple[str, str]] = [
    ("background", "Background"),
    ("scope_of_work", "Scope of Work"),
    ("deliverables", "Deliverables"),
    ("duration", "Duration"),
    ("composition_manpower", "Composition & Manpower"),
    ("payment_milestones", "Payment Milestones"),
    ("general_terms", "General Terms"),
]

# Generic display title for a section label when it isn't otherwise named by
# the chosen template's own outline (e.g. when deriving an outline from an
# existing corpus document's chunk labels — see corpus_db.db_document_outline).
SECTION_TITLES: dict[str, str] = dict(GENERATION_SECTIONS)

# Selectable document structures for "New draft". Each is just an ordered
# list of (section_label, section_title) pairs that drives the draft_generator
# loop — there is no per-catalog-entry seed .docx; every catalog-driven draft
# starts from the same blank file (packages/doc-fixtures/templates/BLANK.docx)
# and the *structure* comes entirely from this outline, not from pre-existing
# document content. Structures below are standard/generic forms synthesized
# from public Indian government procurement and CSR guidance (GFR consultancy
# manual, NRIDA/SFURTI DPR templates, NBCFDC CSR proposal format) — section
# shapes only, no proposal text copied from any source.
TEMPLATE_CATALOG: dict[str, dict[str, Any]] = {
    "BLANK": {
        "label": "Blank canvas (standard Work Order structure)",
        "description": "No fixed government format — the standard QCI Work Order shape.",
        "outline": GENERATION_SECTIONS,
    },
    "GRIEVANCE_REDRESSAL_WO": {
        "label": "Grievance Redressal Work Order (CPGRAMS-style)",
        "description": "For engagements modeled on QCI's CPGRAMS-type grievance redressal work.",
        "outline": GENERATION_SECTIONS,
    },
    "DPR_STANDARD": {
        "label": "Detailed Project Report (DPR)",
        "description": "Standard Indian government scheme DPR shape (NRIDA/SFURTI-style).",
        "outline": [
            ("background", "Background & Rationale"),
            ("objectives", "Project Objectives"),
            ("stakeholder_analysis", "Stakeholder Analysis"),
            ("methodology", "Implementation Strategy & Methodology"),
            ("timeline", "Project Timeline"),
            ("cost_financials", "Project Cost & Financial Plan"),
            ("monitoring_evaluation", "Monitoring & Evaluation Framework"),
            ("sustainability", "Sustainability Plan"),
        ],
    },
    "QCBS_CONSULTANCY": {
        "label": "QCBS Technical Consultancy Proposal",
        "description": "GFR-style Quality & Cost Based Selection technical proposal shape.",
        "outline": [
            ("tor_understanding", "Understanding of Terms of Reference"),
            ("approach_methodology", "Approach & Methodology"),
            ("work_plan", "Work Plan & Schedule"),
            ("team_composition", "Team Composition & Key Personnel"),
            ("deliverables", "Deliverables"),
            ("past_experience", "Past Experience & Track Record"),
        ],
    },
    "CSR_PROJECT_PROPOSAL": {
        "label": "CSR Project Proposal",
        "description": "Standard corporate CSR project proposal shape (NBCFDC-style).",
        "outline": [
            ("executive_summary", "Executive Summary"),
            ("background_problem", "Background & Problem Statement"),
            ("objectives", "Project Objectives"),
            ("target_beneficiaries", "Target Beneficiaries"),
            ("implementation_plan", "Implementation Plan & Methodology"),
            ("expected_outcomes", "Expected Outcomes & Impact"),
            ("budget", "Budget"),
        ],
    },
}

PRECEDENT_WEAVER_SYSTEM = """You are the CFC Precedent Weaver — an assistant embedded inside a
SuperDoc editor at Quality Council of India (QCI). Your job is to help the
person editing this Work Order / Proposal draft borrow structure and
language from prior QCI documents in the institutional corpus.

Operating rules:
1. First call cfc_read_current_draft to see what's already in the draft.
2. Then call cfc_search_corpus with a query focused on the user's request
   (e.g. "CPGRAMS payment milestones", "NeSDA deliverables"). Prefer 3-5 hits.
3. Optionally call cfc_get_document on the single most relevant doc_id.
4. When you propose an insertion, use cfc_propose_insert with:
   - position: "end" unless the user names an anchor
   - text: SHORT (≤ 400 words), well-formatted markdown-ish plain text
   - citation: the source doc_id you cited
5. NEVER invent facts. If the corpus does not contain what the user asked for,
   say so and stop instead of inventing text.
6. Only propose ONE insertion per turn unless the user explicitly asks for more.
7. All results respect the caller's division silo — you cannot see other boards.

You are helpful, terse, and lean on real precedent. When done, briefly state
the version number that was created and which precedent you cited.
"""


PRECEDENT_WEAVER_USER_TEMPLATE = """Task: {task}

Precedent hints (optional, may be empty): {hints}
Focus areas (optional): {focus_areas}
"""


def precedent_weaver_system() -> str:
    return PRECEDENT_WEAVER_SYSTEM


def precedent_weaver_user(task: str, hints: str = "", focus_areas: str = "") -> str:
    return PRECEDENT_WEAVER_USER_TEMPLATE.format(
        task=task.strip() or "Weave precedent language into the appropriate sections of this draft.",
        hints=hints.strip() or "(none)",
        focus_areas=focus_areas.strip() or "(none)",
    )


REDLINE_EXTENDER_SYSTEM = """You are the CFC Redline Extender — a review assistant embedded
inside SuperDoc for QCI approvers (L1 / L2). Your job is NOT to edit the
document. Your job is to leave anchored review suggestions on the current
draft that the maker can accept or reject.

Operating rules:
1. Call cfc_read_current_draft first to see the maker's draft in full.
2. Optionally call cfc_search_corpus for prior QCI Work Orders / Proposals
   that let you compare typical wording, deliverables, or payment structure.
3. For EACH concrete suggestion, call cfc_propose_redline with:
   - passage: a short verbatim excerpt from the draft (≤ 400 chars)
   - suggestion: the exact replacement or the redline instruction
   - rationale: one crisp sentence, citing corpus doc_id when relevant
4. Propose no more than 5 redlines per turn. Prefer fewer, higher-signal ones.
5. Do NOT call cfc_propose_insert or cfc_propose_replace — those mutate the
   DOCX and would bypass the review workflow.
6. Focus on: missing standard clauses, weak payment milestones, unclear
   deliverables, dates that don't add up, or wording drift from precedent.
7. NEVER invent facts. If the corpus does not support a suggestion, drop it.

When done, briefly say how many redlines were posted and cite the strongest
precedent you used.
"""


REDLINE_EXTENDER_USER_TEMPLATE = """Task: {task}

Focus areas (optional): {focus_areas}
Precedent hints (optional): {hints}
"""


def redline_extender_system() -> str:
    return REDLINE_EXTENDER_SYSTEM


def redline_extender_user(task: str, focus_areas: str = "", hints: str = "") -> str:
    return REDLINE_EXTENDER_USER_TEMPLATE.format(
        task=task.strip() or "Review this draft against QCI precedent and propose redlines.",
        focus_areas=focus_areas.strip() or "(none — use your judgement)",
        hints=hints.strip() or "(none)",
    )


DRAFT_GENERATOR_SYSTEM_TEMPLATE = """You are the CFC Draft Generator — an assistant embedded inside a
SuperDoc editor at Quality Council of India (QCI). You are drafting ONE
section of a brand-new Work Order / Proposal, grounded in QCI's
institutional corpus of prior work orders and proposals.

Operating rules:
1. Call cfc_search_corpus with a query focused on THIS section and the
   user's brief (e.g. "deliverables digital governance ministry"). Ask for
   limit=3 — enough to ground the section without wasting context.
2. Write ONLY the "{section_title}" section — do not draft the whole
   document, do not repeat other sections, do not add a table of contents.
3. When ready, call cfc_propose_insert exactly once with:
   - position: "end" (sections are generated in order and appended)
   - text: start with a "## {section_title}" heading line, then
     well-formatted plain-text content for this section only (roughly
     150-350 words)
   - citation: the source doc_id you drew from, if any
4. NEVER invent facts, numbers, or dates. If the corpus has nothing relevant
   for this section, still call cfc_propose_insert with a short placeholder
   noting the maker needs to fill this section in manually — do not skip
   the tool call, every section must exist in the draft.
5. All results respect the caller's division silo — you cannot see other
   boards' documents.

Be terse. When done, state in one sentence which precedent (if any) you
drew from.
"""

DRAFT_GENERATOR_USER_TEMPLATE = """Overall brief: {task}

Section to draft now: {section_title} ({section_label})
Template: {template_code}
"""


def draft_generator_system(section_title: str) -> str:
    return DRAFT_GENERATOR_SYSTEM_TEMPLATE.format(section_title=section_title)


def draft_generator_user(
    task: str,
    section_label: str,
    section_title: str,
    template_code: str = "",
) -> str:
    return DRAFT_GENERATOR_USER_TEMPLATE.format(
        task=task.strip() or "Draft a Work Order based on the selected template.",
        section_label=section_label,
        section_title=section_title,
        template_code=template_code or "WO_EXTENSION",
    )
