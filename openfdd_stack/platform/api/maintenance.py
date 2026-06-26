"""Maintenance dashboard API.

Backs the /maintenance frontend page: lists equipment under observation, returns
recent fault counts so the row sparkline can render, and accepts append-only
event-log writes (scheduled / maintained / cancelled).

Current state ("currently scheduled?", "last maintained") is derived from the
latest row per (equipment_id, event_type) - the table itself is append-only so
the dashboard can plot maintenance cutoffs over the fault timeline.
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from typing import Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    accessible_site_ids,
    get_current_user,
)

router = APIRouter(prefix="/maintenance", tags=["maintenance"])
logger = logging.getLogger(__name__)


EventType = Literal["scheduled", "maintained", "cancelled"]


class MaintenanceEventRead(BaseModel):
    id: UUID
    equipment_id: UUID
    event_type: EventType
    ts: datetime
    actor_email: str | None = None
    notes: str | None = None


class MaintenanceEventCreate(BaseModel):
    equipment_id: UUID
    event_type: EventType
    notes: str | None = Field(default=None, max_length=2000)


class MaintenanceEquipmentRow(BaseModel):
    """One row for the Maintenance dashboard table."""
    equipment_id: UUID
    site_id: str
    name: str
    equipment_type: str | None = None
    scheduled: bool
    last_scheduled_ts: datetime | None = None
    last_maintained_ts: datetime | None = None
    last_cancelled_ts: datetime | None = None
    # Daily fault counts over the requested window (oldest -> newest). Lined up
    # with `histogram_days` so the client can render a sparkline + reference
    # lines without a second round-trip.
    fault_histogram: list[int]
    histogram_days: list[str]   # ISO date per bucket


class MaintenanceOverviewResponse(BaseModel):
    period_days: int
    rows: list[MaintenanceEquipmentRow]


def _is_observed(metadata: dict | None) -> bool:
    if not isinstance(metadata, dict):
        return False
    return metadata.get("observed") is True


@router.get("/equipment", response_model=MaintenanceOverviewResponse)
def list_observed(
    period_days: int = 30,
    user: AuthUser = Depends(get_current_user),
) -> MaintenanceOverviewResponse:
    """Equipment under observation, with maintenance state + daily fault histogram.

    period_days controls the histogram window (default 30). The fault histogram
    counts distinct fault firings per UTC day from fault_results.
    """
    period_days = max(1, min(period_days, 180))
    accessible = accessible_site_ids(user)

    end = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0) + timedelta(days=1)
    start = end - timedelta(days=period_days)
    day_keys = [(start + timedelta(days=i)).date().isoformat() for i in range(period_days)]

    with get_conn() as conn:
        with conn.cursor() as cur:
            if accessible is None:
                cur.execute(
                    "SELECT id, site_id, name, equipment_type, metadata FROM equipment "
                    "ORDER BY site_id, name"
                )
            elif not accessible:
                return MaintenanceOverviewResponse(period_days=period_days, rows=[])
            else:
                cur.execute(
                    "SELECT id, site_id, name, equipment_type, metadata FROM equipment "
                    "WHERE site_id::text = ANY(%s) ORDER BY site_id, name",
                    (accessible,),
                )
            eq_rows = [dict(r) for r in cur.fetchall()]

            observed = [r for r in eq_rows if _is_observed(r.get("metadata"))]
            if not observed:
                return MaintenanceOverviewResponse(period_days=period_days, rows=[])

            equipment_ids = [str(r["id"]) for r in observed]

            cur.execute(
                """
                SELECT equipment_id, event_type, MAX(ts) AS last_ts
                FROM maintenance_events
                WHERE equipment_id = ANY(%s::uuid[])
                GROUP BY equipment_id, event_type
                """,
                (equipment_ids,),
            )
            latest: dict[tuple[str, str], datetime] = {}
            for row in cur.fetchall():
                latest[(str(row["equipment_id"]), row["event_type"])] = row["last_ts"]

            cur.execute(
                """
                SELECT
                  equipment_id,
                  (ts AT TIME ZONE 'UTC')::date AS day,
                  COUNT(*) AS n
                FROM fault_results
                WHERE equipment_id = ANY(%s)
                  AND ts >= %s AND ts < %s
                  AND flag_value > 0
                GROUP BY 1, 2
                """,
                (equipment_ids, start, end),
            )
            hist: dict[str, dict[str, int]] = {}
            for row in cur.fetchall():
                eq = str(row["equipment_id"])
                hist.setdefault(eq, {})[row["day"].isoformat()] = int(row["n"])

    out: list[MaintenanceEquipmentRow] = []
    for r in observed:
        eq_id_s = str(r["id"])
        scheduled_ts = latest.get((eq_id_s, "scheduled"))
        maintained_ts = latest.get((eq_id_s, "maintained"))
        cancelled_ts = latest.get((eq_id_s, "cancelled"))

        # "Currently scheduled" = scheduled is the latest of the three event types.
        candidates = [t for t in (scheduled_ts, maintained_ts, cancelled_ts) if t is not None]
        is_scheduled = (
            scheduled_ts is not None
            and scheduled_ts == max(candidates)
        )

        eq_hist = hist.get(eq_id_s, {})
        histogram = [eq_hist.get(d, 0) for d in day_keys]

        out.append(
            MaintenanceEquipmentRow(
                equipment_id=r["id"],
                site_id=str(r["site_id"]),
                name=r["name"],
                equipment_type=r.get("equipment_type"),
                scheduled=is_scheduled,
                last_scheduled_ts=scheduled_ts,
                last_maintained_ts=maintained_ts,
                last_cancelled_ts=cancelled_ts,
                fault_histogram=histogram,
                histogram_days=day_keys,
            )
        )
    return MaintenanceOverviewResponse(period_days=period_days, rows=out)


@router.get("/events", response_model=list[MaintenanceEventRead])
def list_events(
    equipment_id: UUID,
    user: AuthUser = Depends(get_current_user),
) -> list[MaintenanceEventRead]:
    """Full event history for one equipment (newest first)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT site_id FROM equipment WHERE id = %s", (str(equipment_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Equipment not found")
            accessible = accessible_site_ids(user)
            if accessible is not None and str(row["site_id"]) not in accessible:
                raise HTTPException(403, "No permission for this site")
            cur.execute(
                "SELECT id, equipment_id, event_type, ts, actor_email, notes "
                "FROM maintenance_events WHERE equipment_id = %s ORDER BY ts DESC",
                (str(equipment_id),),
            )
            return [MaintenanceEventRead.model_validate(dict(r)) for r in cur.fetchall()]


@router.post("/events", response_model=MaintenanceEventRead)
def create_event(
    body: MaintenanceEventCreate,
    user: AuthUser = Depends(get_current_user),
) -> MaintenanceEventRead:
    """Append a maintenance event. Caller's Entra email is recorded as actor."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT site_id FROM equipment WHERE id = %s", (str(body.equipment_id),))
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Equipment not found")
            accessible = accessible_site_ids(user)
            if accessible is not None and str(row["site_id"]) not in accessible:
                raise HTTPException(403, "No permission for this site")
            cur.execute(
                """
                INSERT INTO maintenance_events (equipment_id, event_type, actor_email, notes)
                VALUES (%s::uuid, %s, %s, %s)
                RETURNING id, equipment_id, event_type, ts, actor_email, notes
                """,
                (str(body.equipment_id), body.event_type, user.email, body.notes),
            )
            saved = cur.fetchone()
        conn.commit()
    return MaintenanceEventRead.model_validate(dict(saved))
