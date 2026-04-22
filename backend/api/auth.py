"""Phase 0 demo authentication.

Single shared password -> short-lived HS256 JWT. Good enough to gate the
leadership demo; replaced by Google Workspace OAuth / OIDC in Phase 3.
"""
from __future__ import annotations

import hmac
import logging
from datetime import datetime, timedelta, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException
from jose import JWTError, jwt
from pydantic import BaseModel, Field

from backend.config import get_settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

_ALGORITHM = "HS256"
_SUBJECT = "qci-demo"  # Phase 0 everyone is the same "user"


class DemoLoginRequest(BaseModel):
    password: str = Field(..., min_length=1, max_length=256)


class DemoLoginResponse(BaseModel):
    token: str
    expires_at: str  # ISO-8601 UTC
    subject: str


def _issue_token() -> tuple[str, datetime]:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(minutes=settings.jwt_ttl_minutes)
    payload = {
        "sub": _SUBJECT,
        "iat": int(now.timestamp()),
        "exp": int(expires_at.timestamp()),
    }
    token = jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM)
    return token, expires_at


@router.post("/demo-login", response_model=DemoLoginResponse)
def demo_login(body: DemoLoginRequest) -> DemoLoginResponse:
    settings = get_settings()
    # Constant-time compare to avoid timing attacks on the shared password.
    if not hmac.compare_digest(body.password.encode("utf-8"), settings.demo_password.encode("utf-8")):
        raise HTTPException(status_code=401, detail="incorrect password")

    token, expires_at = _issue_token()
    log.info("demo login succeeded; session expires %s", expires_at.isoformat())
    return DemoLoginResponse(token=token, expires_at=expires_at.isoformat(), subject=_SUBJECT)


def get_current_session(
    authorization: Annotated[str | None, Header()] = None,
) -> dict:
    """FastAPI dependency: validates the Bearer token and returns the JWT claims."""
    if not authorization or not authorization.lower().startswith("bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")

    token = authorization.split(" ", 1)[1].strip()
    try:
        claims = jwt.decode(
            token,
            get_settings().jwt_secret,
            algorithms=[_ALGORITHM],
            options={"require": ["exp", "iat", "sub"]},
        )
    except JWTError as exc:
        raise HTTPException(status_code=401, detail=f"invalid token: {exc}") from exc

    if claims.get("sub") != _SUBJECT:
        raise HTTPException(status_code=401, detail="unexpected subject")
    return claims
