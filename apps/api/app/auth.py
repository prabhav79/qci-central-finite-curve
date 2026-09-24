"""
CFC auth — magic-link email + JWT session.

Two modes, controlled by CFC_AUTH_MODE:
- personas   (default) — the demo dropdown; X-CFC-User header identifies the user
- magic-link — real user flow: send signed URL to @qcin.org email, verify, mint JWT

Why both:
- The leadership demo is best experienced by clicking through personas
  (Aashna, Subroto, SG, Admin) in the dropdown — no login latency
- Once leadership approves the project, flip CFC_AUTH_MODE=magic-link and
  real staff log in with their own email addresses

The JWT is HS256-signed with CFC_JWT_SECRET. Delivered as an httpOnly cookie
'cfc_session'. `resolve_current_user()` in main.py picks the mode: header for
personas, cookie for magic-link.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any

import httpx
import jwt

log = logging.getLogger("cfc.auth")

ALLOWED_EMAIL_DOMAIN = os.environ.get("CFC_ALLOWED_EMAIL_DOMAIN", "qcin.org")
JWT_SECRET = os.environ.get("CFC_JWT_SECRET", "cfc-dev-secret-do-not-use-in-prod")
JWT_ISSUER = os.environ.get("CFC_JWT_ISSUER", "cfc")
JWT_TTL_HOURS = int(os.environ.get("CFC_JWT_TTL_HOURS", "12"))
MAGIC_LINK_TTL_MIN = int(os.environ.get("CFC_MAGIC_LINK_TTL_MIN", "15"))
MAGIC_LINK_BASE_URL = os.environ.get("CFC_WEB_URL", "http://localhost:3000")

RESEND_API_KEY = os.environ.get("RESEND_API_KEY", "")
RESEND_FROM = os.environ.get("RESEND_FROM", "CFC <onboarding@resend.dev>")


def auth_mode() -> str:
    return os.environ.get("CFC_AUTH_MODE", "personas").lower().strip()


def email_domain_ok(email: str) -> bool:
    return email.lower().endswith("@" + ALLOWED_EMAIL_DOMAIN.lower())


def _sign(payload: str, ttl_min: int) -> str:
    """Return a URL-safe HMAC token that includes the payload + expiry."""
    exp = int(time.time()) + ttl_min * 60
    body = f"{payload}|{exp}"
    sig = hmac.new(JWT_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}|{sig}"


def _verify_signed_token(token: str) -> str | None:
    """Verify and return the payload (email) if the token is valid + unexpired."""
    try:
        body_a, body_b, sig = token.rsplit("|", 2)
        body = f"{body_a}|{body_b}"
        expected = hmac.new(JWT_SECRET.encode(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, sig):
            return None
        exp = int(body_b)
        if time.time() > exp:
            return None
        return body_a
    except Exception:  # noqa: BLE001
        return None


def build_magic_link(email: str) -> str:
    token = _sign(email.lower(), MAGIC_LINK_TTL_MIN)
    return f"{MAGIC_LINK_BASE_URL.rstrip('/')}/auth/verify?token={token}"


def send_magic_link(email: str, link: str) -> dict[str, Any]:
    """Send via Resend if configured; else return the link so the caller can log/console it (dev)."""
    if not RESEND_API_KEY:
        log.warning("CFC magic link (no RESEND_API_KEY set): %s -> %s", email, link)
        return {"delivery": "console", "link": link}
    try:
        resp = httpx.post(
            "https://api.resend.com/emails",
            headers={
                "Authorization": f"Bearer {RESEND_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "from": RESEND_FROM,
                "to": [email],
                "subject": "Sign in to CFC",
                "html": (
                    f'<p>Click the link below to sign in to CFC. It expires in {MAGIC_LINK_TTL_MIN} minutes.</p>'
                    f'<p><a href="{link}">Sign in</a></p>'
                    f'<p style="color:#666;font-size:12px">If you didn\'t request this, ignore this email.</p>'
                ),
            },
            timeout=15,
        )
        if resp.status_code >= 400:
            log.error("resend delivery HTTP %s: %s", resp.status_code, resp.text[:300])
            return {"delivery": "error", "status": resp.status_code, "body": resp.text[:300]}
        return {"delivery": "resend", "id": resp.json().get("id")}
    except Exception as e:  # noqa: BLE001
        log.exception("resend send failed")
        return {"delivery": "error", "error": str(e)}


def issue_jwt(email: str, employee_id: str | None = None) -> str:
    now = datetime.now(timezone.utc)
    payload = {
        "iss": JWT_ISSUER,
        "sub": email.lower(),
        "employee_id": employee_id,
        "iat": now,
        "exp": now + timedelta(hours=JWT_TTL_HOURS),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")


def decode_jwt(token: str) -> dict[str, Any] | None:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"], issuer=JWT_ISSUER)
    except jwt.PyJWTError:
        return None


def verify_magic_token(token: str) -> str | None:
    """Verify a magic-link token, returning the email if valid."""
    email = _verify_signed_token(token)
    if not email or not email_domain_ok(email):
        return None
    return email
