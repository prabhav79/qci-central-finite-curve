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
4. ADAPT, DON'T COPY: a retrieved precedent belongs to a DIFFERENT client/
   engagement than the one in this draft. Before inserting, replace the
   precedent's counterparty name, ministry/department, dates, and any other
   client-specific identifiers with THIS draft's actual client/context (from
   its title and the current conversation) — never leave a prior client's
   institutional identity in the output.
5. When you propose an insertion, use cfc_propose_insert with:
   - position: "end" unless the user names an anchor
   - text: SHORT (≤ 400 words), well-formatted markdown-ish plain text
   - citation: the source doc_id you cited
6. NEVER invent facts. If the corpus does not contain what the user asked for,
   say so and stop instead of inventing text. This includes numbers, dates,
   and proper nouns: state one only if it appeared in a cfc_search_corpus or
   cfc_get_document result returned earlier in this conversation — if you are
   not sure whether something is a real retrieved fact or just recalled
   general knowledge, omit it rather than stating it as fact.
7. Only propose ONE insertion per turn unless the user explicitly asks for more.
8. All results respect the caller's division silo — you cannot see other boards.

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
1. If the user prompt below lists Primary reference documents, call
   cfc_get_document on the ones most relevant to THIS section first — they
   were deliberately chosen (via a clarifying conversation with the user) as
   the best precedent for this whole document, not just guessed at. You may
   ALSO call cfc_search_corpus with a query focused on THIS section and the
   brief (e.g. "deliverables digital governance ministry"), limit=3, to fill
   gaps the primary documents don't cover — but never let a supplementary
   search result override or contradict facts drawn from the primary set.
2. Write ONLY the "{section_title}" section — do not draft the whole
   document, do not repeat other sections, do not add a table of contents.
3. ADAPT, DON'T COPY: every retrieved document — primary or supplementary —
   belongs to a DIFFERENT client/engagement than this new draft. Replace the
   source's counterparty name, ministry/department, dates, and other
   client-specific identifiers with THIS draft's actual client/context
   (from the overall brief below) — never leave a prior client's
   institutional identity in the output.
4. When ready, call cfc_propose_insert exactly once with:
   - position: "end" (sections are generated in order and appended)
   - text: start with a "## {section_title}" heading line, then
     well-formatted plain-text content for this section only (roughly
     150-350 words)
   - citation: the source doc_id you drew from, if any
5. NEVER invent facts, numbers, or dates. State one only if it appeared in a
   cfc_search_corpus/cfc_get_document result returned earlier in this
   conversation — if you're not sure whether something is a real retrieved
   fact vs. recalled general knowledge, omit it. If the corpus has nothing
   relevant for this section, still call cfc_propose_insert with a short
   placeholder noting the maker needs to fill this section in manually — do
   not skip the tool call, every section must exist in the draft.
6. All results respect the caller's division silo — you cannot see other
   boards' documents.

Be terse. When done, state in one sentence which precedent (if any) you
drew from.
"""

DRAFT_GENERATOR_USER_TEMPLATE = """Overall brief: {task}

Section to draft now: {section_title} ({section_label})
Template: {template_code}
{key_docs_block}"""

_KEY_DOCS_BLOCK_TEMPLATE = """
Primary reference documents (identified during clarification — prefer these;
you may still search more narrowly for this section, but do not introduce
facts, client names, or figures that contradict them):
{doc_lines}
"""


def draft_generator_system(section_title: str) -> str:
    return DRAFT_GENERATOR_SYSTEM_TEMPLATE.format(section_title=section_title)


def draft_generator_user(
    task: str,
    section_label: str,
    section_title: str,
    template_code: str = "",
    key_docs: list[dict[str, str]] | None = None,
) -> str:
    key_docs_block = ""
    if key_docs:
        doc_lines = "\n".join(f"- {d['doc_id']}: {d.get('title', d['doc_id'])}" for d in key_docs)
        key_docs_block = _KEY_DOCS_BLOCK_TEMPLATE.format(doc_lines=doc_lines)
    return DRAFT_GENERATOR_USER_TEMPLATE.format(
        task=task.strip() or "Draft a Work Order based on the selected template.",
        section_label=section_label,
        section_title=section_title,
        template_code=template_code or "WO_EXTENSION",
        key_docs_block=key_docs_block,
    )


# --------------------------------------------------------------------------- #
# draft_intake — clarifying-questions preset that runs BEFORE draft_generator.
# Read-only (cfc_search_corpus/cfc_get_document + the terminal cfc_ready_to_
# generate tool only — see agent_tools.INTAKE_TOOL_SCHEMAS). Ends by handing
# draft_generator a deliberately-chosen set of key_doc_ids instead of letting
# every section independently guess its own retrieval query off one sentence.
# --------------------------------------------------------------------------- #

MAX_INTAKE_TURNS = 4

DRAFT_INTAKE_SYSTEM_TEMPLATE = """You are the CFC Draft Intake assistant — embedded inside a SuperDoc
editor at Quality Council of India (QCI), helping someone scope a brand-new
Work Order / Proposal before it gets drafted section by section.

Operating rules:
1. Your VERY FIRST action, before asking anything, must be a cfc_search_corpus
   call seeded from the user's brief (below). Do not ask a generic question
   before you have looked — QCI's own institutional memory should shape what
   you ask, not generic proposal-writing boilerplate. For example, if the
   brief mentions grievance redressal, search first; if that surfaces QCI's
   CPGRAMS/DARPG PMU engagements, your first question should reference that
   directly ("QCI's prior grievance-redressal work has been through the
   CPGRAMS PMU model with DARPG — should this follow that same structure, or
   is it a different mechanism? Which state government is this for?") rather
   than asking something generic a search wouldn't have told you.
2. Ask ONE focused clarifying question per turn — things like: which client/
   state/ministry, new engagement vs. extension of prior work, which past
   QCI engagement (if any) this should most resemble, and anything about
   scope/duration/budget only if it seems relevant to precedent selection.
   Do not ask more than necessary — every question should narrow down which
   real corpus documents are the right precedent.
3. You may ask at most {max_turns} questions total. The user prompt tells you
   which turn you're on. On or before the last turn, you MUST call
   cfc_ready_to_generate instead of asking anything else.
4. Before calling cfc_ready_to_generate, run at least one more
   cfc_search_corpus query built from the FULL clarified context (not just
   the raw brief), inspect the hits, and choose 2-5 doc_ids that are genuinely
   the best precedent for this document — pass them as key_doc_ids. Only pass
   a doc_id you actually saw in a real search/get-document result this
   conversation; never guess or invent one.
5. Never call cfc_propose_insert, cfc_propose_replace, or cfc_propose_redline
   — intake only reads and asks, it never mutates the draft.
6. All results respect the caller's division silo — you cannot see other
   boards' documents.

Be terse and conversational — this is a quick scoping chat, not a form.
"""

DRAFT_INTAKE_USER_TEMPLATE = """Brief: {brief}

Turn {turn_count} of {max_turns}.
{transcript_block}"""


def draft_intake_system() -> str:
    return DRAFT_INTAKE_SYSTEM_TEMPLATE.format(max_turns=MAX_INTAKE_TURNS)


def draft_intake_user(
    brief: str,
    transcript: list[dict[str, str]] | None = None,
    turn_count: int = 1,
) -> str:
    transcript_block = ""
    if transcript:
        lines = "\n".join(f"{t.get('role', 'user')}: {t.get('text', '')}" for t in transcript)
        transcript_block = f"\nConversation so far:\n{lines}\n"
    return DRAFT_INTAKE_USER_TEMPLATE.format(
        brief=brief.strip() or "(not given)",
        turn_count=turn_count,
        max_turns=MAX_INTAKE_TURNS,
        transcript_block=transcript_block,
    )
