"""
Expand packages/qci-seed/hierarchy.seed.json from QCI Hierarchy/*.png org-chart
cards using Gemini vision (BYOK — set GEMINI_API_KEY).

Prompts Gemini to read each PNG and extract:
  { full_name, employee_id, email, designation, division, manager_full_name }

Ambiguous rows land under `_needs_review` in the output for you to confirm
before merging into the seed file. Existing seed entries are preserved.

Usage:
  pip install google-genai
  export GEMINI_API_KEY=...
  python scripts/ocr_hierarchy.py                       # emits _expanded next to the seed
  python scripts/ocr_hierarchy.py --merge               # merges into hierarchy.seed.json (asks per row)
  python scripts/ocr_hierarchy.py --only aashna_arora   # single-file dry run

The script never posts partial/ambiguous rows to the seed without --merge +
per-row confirmation, so you stay in control of every user that ends up in
the CFC users table.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CHARTS_DIR = ROOT / "QCI Hierarchy"
SEED_PATH = ROOT / "packages" / "qci-seed" / "hierarchy.seed.json"
OUT_PATH = ROOT / "packages" / "qci-seed" / "hierarchy.seed._expanded.json"

DEFAULT_MODEL = os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")

PROMPT = """You are reading a Quality Council of India employee information card (PNG screenshot).
Extract the following JSON object. Use exactly these keys; leave a value as null if the card
does not show it. Do NOT invent employee ids or manager names. Return ONLY JSON, no prose.

{
  "full_name": "string",
  "employee_id": "string like '1820' or null",
  "email": "string or null",
  "designation": "string (e.g. Senior Project Manager)",
  "division": "string (e.g. PPID, NABCB, NABL, NABH, NBQP, Corporate)",
  "manager_full_name": "string or null"
}
"""


def _load_seed() -> dict:
    return json.loads(SEED_PATH.read_text(encoding="utf-8"))


def _existing_ids(seed: dict) -> set[str]:
    return {u["employee_id"] for u in seed.get("users", [])}


def _existing_names(seed: dict) -> dict[str, str]:
    return {u["full_name"].lower(): u["employee_id"] for u in seed.get("users", [])}


def _slug_from_filename(name: str) -> str:
    # aashna_arora_220926045713.png -> aashna arora
    stem = Path(name).stem
    stem = re.sub(r"_\d{10,}$", "", stem)
    return stem.replace("_", " ")


def _cfc_role_from_designation(desg: str | None) -> str:
    if not desg:
        return "reader"
    d = desg.lower()
    if "secretary general" in d and "assistant" not in d and "deputy" not in d:
        return "apex"
    if any(k in d for k in ("assistant secretary general", "principal advisor", "director", "cto", "cfo", "ceo")):
        return "l2_approver"
    if "senior project manager" in d or "deputy director" in d or "assistant director" in d:
        return "l1_approver"
    if "project manager" in d:
        return "maker"
    return "reader"


def _process_one(image_bytes: bytes, mime: str, model_name: str) -> dict:
    from google import genai  # type: ignore
    from google.genai import types  # type: ignore

    client = genai.Client()
    resp = client.models.generate_content(
        model=model_name,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type=mime),
            PROMPT,
        ],
        config={"response_mime_type": "application/json", "temperature": 0.1},
    )
    text = (getattr(resp, "text", None) or "").strip()
    if not text:
        raise RuntimeError("empty response from Gemini")
    return json.loads(text)


def _iter_charts(only: str | None):
    if only:
        matches = list(CHARTS_DIR.glob(f"*{only}*.png"))
        if not matches:
            print(f"no chart matched {only!r}", file=sys.stderr)
            sys.exit(2)
        return matches
    return sorted(CHARTS_DIR.glob("*.png"))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default=None, help="Substring to filter PNG filenames")
    parser.add_argument("--merge", action="store_true", help="After OCR, ask per-row whether to merge into seed")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    args = parser.parse_args()

    if not os.environ.get("GEMINI_API_KEY"):
        print("GEMINI_API_KEY is required. `export GEMINI_API_KEY=...` first.", file=sys.stderr)
        sys.exit(1)

    seed = _load_seed()
    seen_ids = _existing_ids(seed)
    seen_names = _existing_names(seed)

    results: list[dict] = []
    needs_review: list[dict] = []

    for chart in _iter_charts(args.only):
        print(f"→ {chart.name}", flush=True)
        try:
            data = chart.read_bytes()
            parsed = _process_one(data, "image/png", args.model)
        except Exception as e:  # noqa: BLE001
            print(f"  ! failed: {e}", flush=True)
            needs_review.append({"file": chart.name, "error": str(e)})
            continue

        name_from_file = _slug_from_filename(chart.name)
        parsed.setdefault("full_name", name_from_file)
        parsed["source_png"] = chart.name

        # Skip if already seeded by id or name.
        eid = str(parsed.get("employee_id") or "").strip()
        if eid and eid in seen_ids:
            print(f"  = already in seed (id {eid})")
            continue
        if parsed["full_name"] and parsed["full_name"].lower() in seen_names:
            print(f"  = already in seed (name)")
            continue

        parsed["cfc_role"] = _cfc_role_from_designation(parsed.get("designation"))
        # Manager linkage is resolved post-hoc by name matching against seed + new rows.
        parsed["_manager_hint"] = parsed.pop("manager_full_name", None)
        if not eid or not parsed.get("designation") or not parsed.get("division"):
            needs_review.append(parsed)
        else:
            results.append(parsed)

    # Second pass: try to resolve manager_hint -> manager_employee_id.
    combined_names = {**seen_names}
    for r in results:
        combined_names[r["full_name"].lower()] = r.get("employee_id") or ""
    for r in results:
        hint = (r.get("_manager_hint") or "").lower()
        if hint and hint in combined_names:
            r["manager_employee_id"] = combined_names[hint]
        else:
            r["manager_employee_id"] = None
            if hint:
                r["_manager_unresolved"] = hint

    OUT_PATH.write_text(
        json.dumps(
            {
                "candidates": results,
                "needs_review": needs_review,
                "source_seed_ids": sorted(seen_ids),
            },
            indent=2,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    print(f"\nWrote {len(results)} candidates + {len(needs_review)} needs-review → {OUT_PATH.relative_to(ROOT)}")

    if args.merge:
        print("\nMerging into seed. Answer y/n per row:")
        merged = 0
        for r in results:
            print(f"\n{r['full_name']} · {r.get('designation')} · {r.get('division')} · id={r.get('employee_id')}")
            ans = input("merge? [y/N] ").strip().lower()
            if ans == "y":
                seed["users"].append(
                    {
                        "employee_id": r["employee_id"],
                        "full_name": r["full_name"],
                        "email": r.get("email") or f"{r['full_name'].lower().replace(' ', '.')}@qci.local",
                        "designation": r.get("designation"),
                        "cfc_role": r["cfc_role"],
                        "division_or_board": (r.get("division") or "QCI").upper(),
                        "manager_employee_id": r.get("manager_employee_id"),
                        "is_admin": False,
                    }
                )
                merged += 1
        SEED_PATH.write_text(json.dumps(seed, indent=2, ensure_ascii=False), encoding="utf-8")
        print(f"merged {merged} users into {SEED_PATH.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
