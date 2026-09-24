"""
Idempotent seeder for CFC divisions + users.

Reads packages/qci-seed/hierarchy.seed.json (7 demo users currently)
and ensures the corresponding division rows exist. Safe to run on every
API startup — inserts new users, updates existing rows in place.

Sprint 3 will expand the users table via Gemini vision OCR over
QCI Hierarchy/*.png; this seeder handles both the initial demo spine
and any additional users added to the JSON file later.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import ROOT, SessionLocal
from .models import Division, User

SEED_JSON = ROOT / "packages" / "qci-seed" / "hierarchy.seed.json"


# Static division bootstrap. QCI is the apex scope; SG lives here.
# Additional boards (NABCB, NABL, NABH, NBQP) get added in Sprint 3 once
# the org-chart OCR lands.
_BASE_DIVISIONS: list[dict[str, Any]] = [
    {"code": "QCI", "name": "Quality Council of India", "kind": "corporate", "is_apex_scope": True},
    {"code": "PPID", "name": "Project Planning and Implementation Division", "kind": "division", "is_apex_scope": False},
]


def _read_seed() -> list[dict[str, Any]]:
    if not SEED_JSON.exists():
        return []
    return list(json.loads(SEED_JSON.read_text(encoding="utf-8")).get("users") or [])


def _upsert_division(s: Session, row: dict[str, Any]) -> None:
    existing = s.get(Division, row["code"])
    if existing:
        existing.name = row["name"]
        existing.kind = row["kind"]
        existing.is_apex_scope = row["is_apex_scope"]
    else:
        s.add(Division(**row))


def _upsert_user(s: Session, row: dict[str, Any]) -> None:
    division_code = row.get("division_or_board") or "QCI"
    # Ensure the division exists (users may reference a division not in _BASE_DIVISIONS
    # once the OCR expansion lands — auto-provision as a plain division).
    if not s.get(Division, division_code):
        s.add(Division(code=division_code, name=division_code, kind="division", is_apex_scope=False))
        s.flush()

    payload = {
        "full_name": row["full_name"],
        "email": row["email"],
        "designation": row.get("designation"),
        "cfc_role": row["cfc_role"],
        "division_code": division_code,
        "manager_employee_id": row.get("manager_employee_id"),
        "is_admin": bool(row.get("is_admin", False)),
    }
    existing = s.get(User, row["employee_id"])
    if existing:
        for k, v in payload.items():
            setattr(existing, k, v)
    else:
        s.add(User(employee_id=row["employee_id"], **payload))


def seed_divisions_and_users(session: Session | None = None) -> dict[str, int]:
    """Run the seeder. Returns counts of divisions and users after upsert."""
    own_session = session is None
    s = session or SessionLocal()
    try:
        for div in _BASE_DIVISIONS:
            _upsert_division(s, div)
        s.flush()

        rows = _read_seed()
        # Two passes so manager FKs resolve regardless of JSON order.
        # Pass 1: insert without manager_employee_id.
        for row in rows:
            stripped = {**row, "manager_employee_id": None}
            _upsert_user(s, stripped)
        s.flush()
        # Pass 2: apply manager links.
        for row in rows:
            if row.get("manager_employee_id"):
                u = s.get(User, row["employee_id"])
                if u is not None:
                    u.manager_employee_id = row["manager_employee_id"]
        s.flush()

        div_count = s.scalar(select(Division).with_only_columns(Division.code).order_by(None).limit(1)) is not None and \
            len(s.execute(select(Division.code)).all())
        user_count = len(s.execute(select(User.employee_id)).all())

        if own_session:
            s.commit()
        return {"divisions": int(div_count or 0), "users": int(user_count)}
    except Exception:
        if own_session:
            s.rollback()
        raise
    finally:
        if own_session:
            s.close()


if __name__ == "__main__":  # python -m apps.api.app.seed
    counts = seed_divisions_and_users()
    print(f"seeded: {counts}")
