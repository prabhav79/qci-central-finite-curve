"""Division/board visibility — see the CFC visibility rule: strict per-division
silo, except apex (SG), admins, and seeded leadership flagged
`cross_division_read` (CTO, ASG), who read across all boards."""
from __future__ import annotations

import json
from functools import lru_cache

from .models import User
from .seed import SEED_JSON


@lru_cache(maxsize=1)
def _cross_division_ids() -> frozenset[str]:
    try:
        data = json.loads(SEED_JSON.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return frozenset()
    return frozenset(
        str(u.get("employee_id"))
        for u in data.get("users", [])
        if u.get("cross_division_read")
    )


def reads_all_boards(user: User | None) -> bool:
    if user is None:
        return False
    return user.cfc_role == "apex" or bool(user.is_admin) or user.employee_id in _cross_division_ids()
