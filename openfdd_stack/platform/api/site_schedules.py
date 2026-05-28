"""Per-site weekly operating schedule (in-hours window for compliance).

7 rows per site keyed by ISO day-of-week (0=Mon..6=Sun). The Compliance
dashboard reads this to compute in-hours sample windows; analytics derives
"out-of-hours runtime" by inverting the same predicate.
"""

from __future__ import annotations

from datetime import time
from typing import List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, conint

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    accessible_site_ids,
    get_current_user,
)

router = APIRouter(prefix="/sites", tags=["sites"])


class ScheduleEntry(BaseModel):
    dow: int = Field(..., ge=0, le=6, description="0=Mon..6=Sun")
    start_local: time
    end_local: time
    tz: str = "Europe/London"


class SiteScheduleBody(BaseModel):
    entries: List[ScheduleEntry]


def _ensure_site_access(user: AuthUser, site_id: str) -> None:
    accessible = accessible_site_ids(user)
    if accessible is not None and site_id not in accessible:
        raise HTTPException(403, "No permission for this site")


@router.get("/{site_id}/schedule", response_model=SiteScheduleBody)
def get_schedule(site_id: str, user: AuthUser = Depends(get_current_user)) -> SiteScheduleBody:
    _ensure_site_access(user, site_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT dow, start_local, end_local, tz FROM site_schedules WHERE site_id = %s ORDER BY dow",
                (site_id,),
            )
            rows = cur.fetchall()
    return SiteScheduleBody(
        entries=[
            ScheduleEntry(
                dow=r["dow"],
                start_local=r["start_local"],
                end_local=r["end_local"],
                tz=r["tz"],
            )
            for r in rows
        ]
    )


@router.put("/{site_id}/schedule", response_model=SiteScheduleBody)
def put_schedule(
    site_id: str,
    body: SiteScheduleBody,
    user: AuthUser = Depends(get_current_user),
) -> SiteScheduleBody:
    """Replace the site's weekly schedule. Missing days clear that day's row."""
    _ensure_site_access(user, site_id)
    seen: set[int] = set()
    for e in body.entries:
        if e.dow in seen:
            raise HTTPException(422, f"Duplicate dow={e.dow}")
        seen.add(e.dow)
        if e.end_local <= e.start_local:
            raise HTTPException(422, f"end_local must be after start_local (dow={e.dow})")

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("DELETE FROM site_schedules WHERE site_id = %s", (site_id,))
            for e in body.entries:
                cur.execute(
                    """
                    INSERT INTO site_schedules (site_id, dow, start_local, end_local, tz)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (site_id, e.dow, e.start_local, e.end_local, e.tz),
                )
        conn.commit()
    return get_schedule(site_id, user)
