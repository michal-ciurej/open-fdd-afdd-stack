"""Entra ID auth via SWA-injected client principal.

Trust model
-----------
Azure Static Web Apps performs the OIDC handshake with Entra and forwards a
base64-encoded JSON principal to the linked ACA backend in `x-ms-client-principal`.
This middleware decodes that header into an `AuthUser` and stashes it on
`request.state.user`. Role tier comes from Entra App Roles (`admin`, `engineer`,
`user`); per-site access comes from the `user_site_permissions` table.

The principal header is forgeable on a public ACA URL, so deployment MUST do
ONE of:
  1. Restrict ACA ingress IPs to the SWA region's outbound IP set, or
  2. Set OFDD_SWA_INGRESS_SECRET on both sides — the middleware refuses the
     principal unless the matching header is present.

Machine callers (BACnet scraper, MCP) keep the legacy OFDD_API_KEY Bearer path.
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import secrets
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Iterable

from fastapi import Depends, HTTPException, Request, Response, status
from starlette.middleware.base import BaseHTTPMiddleware

from openfdd_stack.platform.config import get_platform_settings
from openfdd_stack.platform.database import get_conn

logger = logging.getLogger(__name__)

PRINCIPAL_HEADER = "x-ms-client-principal"
SWA_SECRET_HEADER = "x-openfdd-swa-secret"

_PATHS_NO_AUTH = frozenset(("/", "/health"))


class Role(str, Enum):
    ADMIN = "admin"
    ENGINEER = "engineer"
    USER = "user"


@dataclass(frozen=True)
class AuthUser:
    oid: str                          # Entra object ID — stable user key
    email: str                        # preferred_username / userDetails
    roles: frozenset[Role]            # tier(s) granted via App Roles
    is_machine: bool = False          # True for OFDD_API_KEY callers
    raw_roles: frozenset[str] = field(default_factory=frozenset)  # unfiltered userRoles

    def has_role(self, *roles: Role) -> bool:
        return any(r in self.roles for r in roles)


# --- principal decoding -----------------------------------------------------

def _parse_roles(user_roles: Iterable[str]) -> frozenset[Role]:
    out: set[Role] = set()
    for r in user_roles or ():
        try:
            out.add(Role(r.lower()))
        except ValueError:
            continue  # ignore SWA built-ins (anonymous, authenticated) and unknown roles
    return frozenset(out)


def principal_from_headers(headers: dict[str, str]) -> AuthUser | None:
    """Resolve an AuthUser from a header map (e.g., a WebSocket upgrade scope).

    Used by the WebSocket handler, which doesn't run through the HTTP middleware.
    Returns None when no SWA principal is present or the payload is malformed.
    """
    b64 = headers.get(PRINCIPAL_HEADER) or headers.get(PRINCIPAL_HEADER.lower())
    if not b64:
        return None
    return _decode_principal(b64)


def _decode_principal(b64: str) -> AuthUser | None:
    try:
        # SWA uses standard b64 with padding; tolerate either.
        padded = b64 + "=" * (-len(b64) % 4)
        raw = base64.b64decode(padded)
        data = json.loads(raw.decode("utf-8"))
    except (binascii.Error, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if data.get("identityProvider") != "aad":
        return None
    oid = (data.get("userId") or "").strip()
    email = (data.get("userDetails") or "").strip()
    if not oid:
        return None
    raw_roles = frozenset(data.get("userRoles") or ())
    return AuthUser(
        oid=oid,
        email=email,
        roles=_parse_roles(raw_roles),
        is_machine=False,
        raw_roles=raw_roles,
    )


# --- middleware -------------------------------------------------------------

def _path_exempt(path: str) -> bool:
    if path in _PATHS_NO_AUTH:
        return True
    if path.startswith("/app") or path.startswith("/.auth/"):
        return True
    # SWA invokes the rolesSource endpoint server-side during login,
    # before the user has a session — no principal header yet.
    # Path is hardened via the ACA ingress IP allowlist.
    if path == "/auth/roles":
        return True
    if path in ("/docs", "/redoc", "/openapi.json") or path.startswith("/docs/"):
        return getattr(get_platform_settings(), "enable_openapi_docs", False)
    return False


def _bearer_token(request: Request) -> str | None:
    auth = request.headers.get("Authorization", "")
    if not auth.startswith("Bearer "):
        return None
    return auth[7:].strip() or None


def _json_error(code: str, message: str, http_status: int) -> Response:
    body = json.dumps({"error": {"code": code, "message": message, "details": None}})
    return Response(content=body, status_code=http_status, media_type="application/json")


class EntraPrincipalMiddleware(BaseHTTPMiddleware):
    """Resolve the request's identity from the SWA principal or a machine API key.

    Order of checks (first match wins):
      1. Path exempt (health, static SPA assets, optional OpenAPI)
      2. OFDD_API_KEY Bearer  → AuthUser(is_machine=True, roles={admin})
      3. SWA principal header → AuthUser from Entra claims
      4. Otherwise → 401

    On success, sets `request.state.user`. Endpoints enforce role/site rules
    via the Depends helpers below — this middleware only attests identity.
    """

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        if _path_exempt(request.url.path):
            return await call_next(request)

        settings = get_platform_settings()

        # 1. Machine path — service integrations (scraper, MCP, automations).
        api_key = (getattr(settings, "api_key", None) or "").strip()
        token = _bearer_token(request)
        if api_key and token and secrets.compare_digest(token, api_key):
            request.state.user = AuthUser(
                oid="machine",
                email="machine@openfdd",
                roles=frozenset({Role.ADMIN}),
                is_machine=True,
            )
            return await call_next(request)

        # 2. Browser path — SWA-forwarded Entra principal.
        principal_b64 = request.headers.get(PRINCIPAL_HEADER)
        if principal_b64:
            ingress_secret = (getattr(settings, "swa_ingress_secret", None) or "").strip()
            if ingress_secret:
                supplied = request.headers.get(SWA_SECRET_HEADER, "")
                if not secrets.compare_digest(supplied, ingress_secret):
                    logger.warning(
                        "auth 403 missing/bad SWA ingress secret path=%s",
                        request.url.path,
                    )
                    return _json_error(
                        "FORBIDDEN", "Untrusted ingress", status.HTTP_403_FORBIDDEN
                    )
            user = _decode_principal(principal_b64)
            if not user:
                return _json_error(
                    "UNAUTHORIZED",
                    "Invalid client principal",
                    status.HTTP_401_UNAUTHORIZED,
                )
            if not user.roles:
                logger.info("auth 403 no app roles oid=%s", user.oid)
                return _json_error(
                    "FORBIDDEN",
                    "User has no assigned application role",
                    status.HTTP_403_FORBIDDEN,
                )
            request.state.user = user
            return await call_next(request)

        # 3. No identity.
        return _json_error(
            "UNAUTHORIZED",
            "Authentication required",
            status.HTTP_401_UNAUTHORIZED,
        )


# --- FastAPI Depends helpers -----------------------------------------------

def get_current_user(request: Request) -> AuthUser:
    user = getattr(request.state, "user", None)
    if not isinstance(user, AuthUser):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail={"code": "UNAUTHORIZED", "message": "Not authenticated"},
        )
    return user


def require_roles(*roles: Role) -> Callable[[AuthUser], AuthUser]:
    """Endpoint guard: require any of the given roles.

    Usage:
        @router.delete("/sites/{id}", dependencies=[Depends(require_roles(Role.ADMIN))])
    """
    allowed = frozenset(roles)

    def _check(user: AuthUser = Depends(get_current_user)) -> AuthUser:
        if user.is_machine or user.has_role(*allowed):
            return user
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "code": "FORBIDDEN",
                "message": f"Requires role: {', '.join(r.value for r in allowed)}",
            },
        )

    return _check


def _user_can_access_site(user: AuthUser, site_id: str) -> bool:
    """Admins (and machine callers) bypass; everyone else needs an explicit grant."""
    if user.is_machine or Role.ADMIN in user.roles:
        return True
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT 1 FROM user_site_permissions WHERE user_oid = %s AND site_id = %s LIMIT 1",
            (user.oid, site_id),
        )
        return cur.fetchone() is not None


def require_site_access(site_id_param: str = "site_id") -> Callable[..., AuthUser]:
    """Endpoint guard: require access to the site identified by a path/query param.

    Usage:
        @router.get("/sites/{site_id}/equipment",
                    dependencies=[Depends(require_site_access("site_id"))])
    """

    def _check(request: Request, user: AuthUser = Depends(get_current_user)) -> AuthUser:
        site_id = request.path_params.get(site_id_param) or request.query_params.get(
            site_id_param
        )
        if not site_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail={"code": "BAD_REQUEST", "message": f"Missing {site_id_param}"},
            )
        if not _user_can_access_site(user, str(site_id)):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail={
                    "code": "FORBIDDEN",
                    "message": "No permission for this site",
                },
            )
        return user

    return _check


def accessible_site_ids(user: AuthUser) -> list[str] | None:
    """Return the site_ids this user can see, or None for unrestricted (admin/machine).

    Use in list endpoints to scope query results:
        sites = accessible_site_ids(user)
        sql = "SELECT * FROM equipment" + ("" if sites is None else " WHERE site_id = ANY(%s)")
    """
    if user.is_machine or Role.ADMIN in user.roles:
        return None
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT site_id FROM user_site_permissions WHERE user_oid = %s",
            (user.oid,),
        )
        return [row[0] for row in cur.fetchall()]
