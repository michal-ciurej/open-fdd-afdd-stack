"""Admin user-access management.

Lists the login-derived user roster (``app_users``) and lets admins grant or
revoke per-site access (``user_site_permissions``). These are the controls
behind the Config → User access page.

Admin-only: the whole router is gated by ``require_roles(Role.ADMIN)``.

Scope note: the role tier (admin/engineer/user) is managed in Entra App Roles,
not here. This router only manages the per-site grants that scope what an
engineer/user can see. Admins are unrestricted and bypass these grants.
"""

from __future__ import annotations

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel

from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    Role,
    get_current_user,
    require_roles,
)
from openfdd_stack.platform.database import get_conn

router = APIRouter(
    prefix="/admin",
    tags=["admin"],
    dependencies=[Depends(require_roles(Role.ADMIN))],
)


class AdminUserRead(BaseModel):
    oid: str
    email: str | None
    roles: list[str]
    first_seen: datetime
    last_seen: datetime
    site_ids: list[str]


@router.get("/users", response_model=list[AdminUserRead])
def list_users() -> list[AdminUserRead]:
    """All users that have signed in at least once, with their granted site ids.

    Users appear here after their first ``/auth/me``. Admins show up with whatever
    grants they happen to have, but those grants are inert — admins are
    unrestricted and bypass ``user_site_permissions`` entirely.
    """
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "SELECT oid, email, roles, first_seen, last_seen FROM app_users "
            "ORDER BY COALESCE(email, oid)"
        )
        users = cur.fetchall()
        cur.execute("SELECT user_oid, site_id FROM user_site_permissions")
        grants = cur.fetchall()

    by_user: dict[str, list[str]] = {}
    for g in grants:
        by_user.setdefault(g["user_oid"], []).append(g["site_id"])

    return [
        AdminUserRead(
            oid=u["oid"],
            email=u["email"],
            roles=list(u["roles"] or []),
            first_seen=u["first_seen"],
            last_seen=u["last_seen"],
            site_ids=sorted(by_user.get(u["oid"], [])),
        )
        for u in users
    ]


def _require_known_user(cur, oid: str) -> None:
    cur.execute("SELECT 1 FROM app_users WHERE oid = %s", (oid,))
    if cur.fetchone() is None:
        raise HTTPException(
            status.HTTP_404_NOT_FOUND,
            "Unknown user — they must sign in once before sites can be assigned",
        )


def _require_site(cur, site_id: str) -> None:
    cur.execute("SELECT 1 FROM sites WHERE id::text = %s", (site_id,))
    if cur.fetchone() is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Site not found")


@router.put("/users/{oid}/sites/{site_id}", status_code=status.HTTP_204_NO_CONTENT)
def grant_site(
    oid: str,
    site_id: str,
    admin: AuthUser = Depends(get_current_user),
) -> None:
    """Grant a user access to a site. Idempotent; records the granting admin."""
    with get_conn() as conn, conn.cursor() as cur:
        _require_known_user(cur, oid)
        _require_site(cur, site_id)
        cur.execute(
            "INSERT INTO user_site_permissions (user_oid, site_id, granted_by) "
            "VALUES (%s, %s, %s) ON CONFLICT (user_oid, site_id) DO NOTHING",
            (oid, site_id, admin.oid),
        )
        conn.commit()


@router.delete("/users/{oid}/sites/{site_id}", status_code=status.HTTP_204_NO_CONTENT)
def revoke_site(oid: str, site_id: str) -> None:
    """Revoke a user's access to a site. Idempotent."""
    with get_conn() as conn, conn.cursor() as cur:
        cur.execute(
            "DELETE FROM user_site_permissions WHERE user_oid = %s AND site_id = %s",
            (oid, site_id),
        )
        conn.commit()
