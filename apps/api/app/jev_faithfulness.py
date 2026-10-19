"""
Jev-based generation faithfulness check (plan item 9) — a soft QA signal
surfaced to the human reviewer, never an auto-block or auto-edit.

2a's fix for the "Special Campaign 2.0 & 3.0" hallucination was a prompt
instruction ("only state a fact if it appeared in a retrieved result").
2c's lesson, applied to a completely different failure mode (the
reviewer-mutation bypass), was that a prompt instruction alone is not
enforcement — the model can silently ignore it. This module is the
deterministic check for the SAME class of failure 2a targeted: after a
draft_generator section completes, does it read like it's making claims
(numbers, dates, proper nouns) that never appeared in what was actually
retrieved for that section?

Sentence-level, not word-level: extracting individual "facts" reliably
without an LLM call is unreliable, so this treats whole sentences that
LOOK fact-bearing (contain a digit, or a multi-word capitalized phrase)
as the unit to check — coarser than a real claim-extraction pass, but
deterministic, cheap (one batched Jev call per section), and directly
targets the observed failure shape.

Degrades to an empty list (never raises) if TYPESAFE_API_KEY is unset,
there's no evidence to check against, or the call fails — same posture
as jev_client/ingest.py's _jev_classify elsewhere in this codebase. An
empty list here means "nothing flagged", which includes "Jev didn't run"
— this is a soft QA signal, not a safety gate, so fail-open is correct.
"""
from __future__ import annotations

import logging
import re

from . import jev_client

log = logging.getLogger("cfc.jev.faithfulness")

# Lines are units too: a bold deliverable name on its own line is not the
# start of the description sentence below it.
_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+|\n+")

_MAX_CLAIMS_PER_SECTION = 8
_MAX_FLAGS_PER_SECTION = 3
_UNSUPPORTED_THRESHOLD = 0.4
_EVIDENCE_CHAR_LIMIT = 8000
_MIN_CLAIM_WORDS = 6
_HEADING_LINE_RE = re.compile(r"^\s*#{1,6}\s+[^\n]*\n?", re.M)
_LIST_MARKER_RE = re.compile(r"^\s*(?:[-*•]|\d{1,2}[.)])\s+", re.M)
# A short lead-in label ("District Coordinators:", "DATA ACCESS AND
# COOPERATION:") names a role or clause; the facts follow it.
_LEAD_LABEL_RE = re.compile(r"^([^:]{1,60}):\s+")
_LEAD_LABEL_MAX_WORDS = 6
_ROW_SERIAL_RE = re.compile(r"^\s*\|\s*\d{1,2}\s*\|", re.M)  # "| 2 | Draft report |" -> row no. 2
# Instructions to the maker are not claims about the world.
_MAKER_NOTE_RE = re.compile(r"^\W*(?:note for (?:the )?maker|maker to )", re.I)

# The fact tokens a hallucination would invent: numbers, acronyms, names.
_NUMBER_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
# Two or more capitals: PMMSY, KIIs, SDC&FPO, and mixed-case DoF / MoU.
_ACRONYM_RE = re.compile(r"\b[A-Z][A-Za-z&]*[A-Z][A-Za-z&]*\b")
# "and" is not a name connector: "Field Supervisors and Enumerators" is two
# names, checked separately. "&" is: formal names use it ("Department of
# Animal Husbandry & Dairying", which then expands DAHD).
_NAME_RE = re.compile(r"\b[A-Z][a-z]+\b(?:(?:\s+(?:of|for|the|&)\s+|\s+)[A-Z][a-z]+\b)*")
# Phrases an acronym can abbreviate: "Department of Fisheries" -> DoF / DF.
_EXPANSION_RE = re.compile(r"\b[A-Z][a-z]+\b(?:\s+(?:(?:of|for|the|and|&)\s+)?[A-Z][a-z]+\b)+")
_CONNECTORS = {"of", "for", "the", "and", "&"}
# QCI writes every proposal, so its own name never needs a source; nor do
# the names of the document types it drafts ("this Work Order shall…").
_AUTHOR = (
    "Quality Council of India (QCI). Document types: Proposal, Work Order, Terms of Reference, "
    "Memorandum of Understanding, Request for Proposal, Detailed Project Report."
)
_DETERMINERS = {"The", "This", "These", "That", "Those", "A", "An", "Each", "Our", "Its", "Their", "All", "Any"}


def _norm(text: str) -> str:
    """Lower-case, single-spaced, "6,000" -> "6000", British -ise -> -ize."""
    text = re.sub(r"(?<=\d),(?=\d)", "", " ".join(text.lower().split()))
    return re.sub(r"is(ations?|e|ed|es|ing)\b", r"iz\1", text)


_INDIAN_UNIT_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(lakhs?|lacs?|crores?|cr)\b", re.I)
_BIG_NUMBER_RE = re.compile(r"\b\d{6,}\b")


def _number_forms(evidence_norm: str) -> str:
    """Written-out forms of the evidence's amounts, so "Rs 18 lakh" supports
    "Rs 18,00,000" and "1,20,00,000" supports "Rs 1.2 crore"."""
    forms = []
    for value, unit in _INDIAN_UNIT_RE.findall(evidence_norm):
        forms.append(str(round(float(value) * (10**7 if unit.lower().startswith("cr") else 10**5))))
    for n in _BIG_NUMBER_RE.findall(evidence_norm):
        forms += [f"{int(n) / 10**5:g}", f"{int(n) / 10**7:g}"]
    return " ".join(forms)


def _fact_tokens(sentence: str) -> list[tuple[str, str]]:
    """(kind, token) for the numbers, acronyms and capitalised names in a
    sentence. A lone capitalised word that only starts the sentence (or
    follows a colon) is grammar, not a name, and is skipped."""
    tokens = [("num", n.replace(",", "")) for n in _NUMBER_RE.findall(sentence)]
    for a in _ACRONYM_RE.findall(sentence):
        for part in a.split("&"):
            part = re.sub(r"(?<=[A-Z])s$", "", part)  # KIIs -> KII
            if len(part) >= 2:
                tokens.append(("acr", part))
    for m in _NAME_RE.finditer(sentence):
        words = m.group(0).split()
        while words and words[0] in _DETERMINERS:
            words = words[1:]
        if not words:
            continue
        sentence_initial = m.start() == 0 or sentence[: m.start()].rstrip().endswith((":", "("))
        if len(words) == 1 and sentence_initial:
            continue
        tokens.append(("name", " ".join(words)))
    return tokens


def _initials(text: str) -> set[str]:
    """Lower-cased initials of every capitalised phrase (and its tails), with
    and without connector initials: "The Department of Fisheries" -> dof, df;
    "Ministry of Labour & Employment" -> mole (and/& dropped), mle."""
    out: set[str] = set()
    for m in _EXPANSION_RE.finditer(text):
        words = m.group(0).split()
        for i, w in enumerate(words):
            if w in _CONNECTORS or w in _DETERMINERS:
                continue
            tail = words[i:]
            out.add("".join(t[0] for t in tail).lower())
            out.add("".join(t[0] for t in tail if t not in _CONNECTORS).lower())
            out.add("".join(t[0] for t in tail if t not in {"and", "&"}).lower())
    return out


def _in_evidence(token: str, evidence_norm: str) -> bool:
    tok = _norm(token)
    variants = {tok, tok[:-1]} if tok.endswith("s") and len(tok) > 3 else {tok, tok + "s"}
    return any(re.search(rf"(?<![a-z0-9]){re.escape(v)}(?![a-z0-9])", evidence_norm) for v in variants)


def _supported(kind: str, token: str, evidence_norm: str, initials: set[str]) -> bool:
    if _in_evidence(token, evidence_norm):
        return True
    if kind == "acr":
        return token.lower() in initials  # abbreviation of a name used in the text
    if kind == "name" and " " in token:
        words = [w for w in token.split() if w not in _CONNECTORS]
        # The expansion of an acronym the evidence uses ("Project Management
        # Unit" when the brief says "PMU").
        if len(words) >= 3 and _in_evidence("".join(w[0] for w in words), evidence_norm):
            return True
        # Role and document titles ("State Coordinators", "Draft Report") are
        # ordinary words capitalised; invented programme names still carry a
        # number or acronym that fails above.
        return all(_in_evidence(w, evidence_norm) for w in words)
    return False


def _candidate_claims(section_text: str) -> list[str]:
    """Sentences worth checking: ones carrying a number, acronym or name —
    the exact failure shape 2a's fix targets ("Special Campaign 2.0 & 3.0").
    Headings, list-number fragments ("Objectives 1.", "2.") and notes to
    the maker aren't claims. A table row is checked as text, each cell
    starting like a sentence."""
    body = _LIST_MARKER_RE.sub("", _HEADING_LINE_RE.sub("", section_text)).replace("**", "")
    body = _ROW_SERIAL_RE.sub("|", body).replace("|", " : ")
    sentences = [" ".join(s.split()).strip("*_ ") for s in _SENTENCE_SPLIT_RE.split(body) if s.strip()]
    claims = []
    for s in sentences:
        if _MAKER_NOTE_RE.match(s):
            continue
        label = _LEAD_LABEL_RE.match(s)
        if label and len(label.group(1).split()) <= _LEAD_LABEL_MAX_WORDS:
            s = s[label.end():]
        if len(s.split()) >= _MIN_CLAIM_WORDS and not _is_title_line(s) and _fact_tokens(s):
            claims.append(s)
    return claims


def _is_title_line(line: str) -> bool:
    """"Field Survey and Mid-Term Progress Report" — a list heading, not a claim."""
    words = [w for w in line.split() if w[0].isalpha()]
    return bool(words) and line[-1] not in ".!?" and sum(w[0].isupper() for w in words) >= 0.6 * len(words)


def check_section(section_text: str, evidence: str) -> list[dict[str, object]]:
    """Returns only the claims that scored BELOW the support threshold —
    i.e. the flags actually worth surfacing, never the full claim list.
    Each item: {"claim": str, "score": float}.

    Two stages: a sentence whose every number, acronym and name is found in
    the evidence (brief, answers, retrieved sources) is supported outright —
    Jev scores proposal language ("QCI will deliver…") as unsupported even
    when every fact in it came from the brief. An acronym also counts when
    it abbreviates a name in the evidence or the section ("DoF"). Only
    sentences carrying a fact found nowhere go to Jev, which then forgives
    paraphrase ("eight months" for "8 months")."""
    if not evidence.strip() or not jev_client.is_configured():
        return []
    evidence_norm = _norm(f"{_AUTHOR}\n{evidence}")
    evidence_norm = f"{evidence_norm} {_number_forms(evidence_norm)}"
    initials =_initials(f"{evidence}\n{section_text}")
    claims: list[str] = []
    for c in _candidate_claims(section_text):
        missing = [t for k, t in _fact_tokens(c) if not _supported(k, t, evidence_norm, initials)]
        if missing:
            log.info("faithfulness: not in evidence %s — %.80s", missing, c)
            claims.append(c)
    claims = claims[:_MAX_CLAIMS_PER_SECTION]
    if not claims:
        return []

    questions = {
        f"claim::{i}": {
            "type": "noul",
            "instructions": (
                "Does the reference material given as state support or contain "
                f'evidence for this specific claim: "{claim}"? Answer low if the '
                "claim's specific numbers, dates, or proper nouns are not present "
                "in the reference material, even if the general topic matches. "
                "A statement of what QCI proposes or will do counts as supported "
                "when its numbers, dates and names appear in the reference material."
            ),
        }
        for i, claim in enumerate(claims)
    }
    try:
        answers = jev_client.evaluate(evidence[:_EVIDENCE_CHAR_LIMIT], questions)
    except Exception as e:  # noqa: BLE001
        log.warning("Jev faithfulness check failed: %s — skipping (fail-open)", e)
        return []

    flags: list[dict[str, object]] = []
    for i, claim in enumerate(claims):
        score = answers.get(f"claim::{i}", {}).get("noul")
        if isinstance(score, (int, float)) and score < _UNSUPPORTED_THRESHOLD:
            flags.append({"claim": claim, "score": round(float(score), 2)})
    # A reviewer acts on a short list; show only the least-supported few.
    flags.sort(key=lambda f: f["score"])
    return flags[:_MAX_FLAGS_PER_SECTION]
