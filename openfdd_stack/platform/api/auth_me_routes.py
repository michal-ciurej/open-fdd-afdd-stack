"""Identity endpoints used by the SPA and SWA.

- GET  /auth/me      → current user (called by the SPA on boot)
- POST /auth/roles   → SWA rolesSource: pulls Entra App Roles out of the
                       claims SWA gives us, returns them so SWA can put
                       them in userRoles for route-level gating.
"""

from __future__ import annotations

import logging
from typing import Any

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    Role,
    accessible_site_ids,
    get_current_user,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])

# Whitelist — anything Entra returns outside this set is dropped.
_KNOWN_ROLES = {r.value for r in Role}


class MeResponse(BaseModel):
    oid: str
    email: str
    roles: list[str]
    sites: list[str] | None  # None = unrestricted (admin / machine)
    is_machine: bool


class RolesResponse(BaseModel):
    roles: list[str]


@router.get("/me", response_model=MeResponse)
def me(user: AuthUser = Depends(get_current_user)) -> MeResponse:
    """Return the authenticated user's identity, role tier, and accessible sites.

    The SPA calls this on mount to decide which menu items to render and
    which sites to show in the site selector.
    """
    return MeResponse(
        oid=user.oid,
        email=user.email,
        roles=sorted(r.value for r in user.roles),
        sites=accessible_site_ids(user),
        is_machine=user.is_machine,
    )


@router.post("/roles", response_model=RolesResponse)
async def roles_source(request: Request) -> RolesResponse:
    """SWA rolesSource callback.

    SWA POSTs the user's identity payload during login (before issuing the
    session cookie) and uses our response to populate the userRoles array.
    Without this hop, App Roles from Entra never make it into the principal
    that downstream route gates check.

    Expected request body:
        {
          "identityProvider": "aad",
          "userId": "<oid>",
          "userDetails": "<upn>",
          "claims": [{ "typ": "roles", "val": "admin" }, ...],
          "accessToken": "..."
        }
    """
    try:
        payload: dict[str, Any] = await request.json()
    except Exception:
        return RolesResponse(roles=[])

    if payload.get("identityProvider") != "aad":
        return RolesResponse(roles=[])

    found: set[str] = set()
    for claim in payload.get("claims") or ():
        if not isinstance(claim, dict):
            continue
        if claim.get("typ") != "roles":
            continue
        val = (claim.get("val") or "").strip().lower()
        if val in _KNOWN_ROLES:
            found.add(val)

    if not found:
        logger.info(
            "rolesSource: no app roles for oid=%s upn=%s",
            payload.get("userId"),
            payload.get("userDetails"),
        )

    return RolesResponse(roles=sorted(found))
