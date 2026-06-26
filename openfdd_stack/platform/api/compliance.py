"""Compliance dashboard API.

Two endpoints back /compliance:

  GET /compliance/summary             -> dial counters per category='compliance'
                                         fault definition (count of distinct
                                         equipment currently in active state).

  GET /compliance/equipment-analytics -> per-equipment in-period averages of
                                         ΔT, supply T, flow (supply water) T,
                                         and the in-hours schedule compliance
                                         percentage.

In-hours windows come from `site_schedules`; if a site has no schedule rows
defined we treat all hours as in-hours so the analytics number is still
meaningful (just less interesting).
"""

from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    accessible_site_ids,
    get_current_user,
)

router = APIRouter(prefix="/compliance", tags=["compliance"])
logger = logging.getLogger(__name__)


SUPPLY_AIR_BRICK = "Supply_Air_Temperature_Sensor"
RETURN_AIR_BRICK = "Return_Air_Temperature_Sensor"
SUPPLY_WATER_BRICK = "Supply_Water_Temperature_Sensor"
RETURN_WATER_BRICK = "Return_Water_Temperature_Sensor"


class ComplianceDial(BaseModel):
    fault_id: str
    name: str
    description: str | None = None
    severity: str
    # Count of distinct equipment currently in active state for this fault.
    active_count: int
    # Capacity for the dial denominator - distinct equipment that have at
    # least one row in fault_state for this fault_id (i.e. ever evaluated).
    evaluated_count: int


class ComplianceSummaryResponse(BaseModel):
    site_id: str | None
    dials: list[ComplianceDial]


class ComplianceEquipmentRow(BaseModel):
    equipment_id: UUID
    site_id: str
    name: str
    equipment_type: str | None = None
    avg_delta_t: float | None = None
    avg_supply_air_t: float | None = None
    avg_supply_water_t: float | None = None
    avg_return_air_t: float | None = None
    avg_return_water_t: float | None = None
    in_hours_compliance_pct: float | None = None


class ComplianceEquipmentAnalyticsResponse(BaseModel):
    site_id: str | None
    period: dict[str, str]
    rows: list[ComplianceEquipmentRow]


def _resolve_period(start: str | None, end: str | None, fallback_days: int) -> tuple[datetime, datetime]:
    if start and end:
        s = datetime.fromisoformat(start)
        e = datetime.fromisoformat(end)
    else:
        e = datetime.now(timezone.utc)
        s = e - timedelta(days=fallback_days)
    if s.tzinfo is None:
        s = s.replace(tzinfo=timezone.utc)
    if e.tzinfo is None:
        e = e.replace(tzinfo=timezone.utc)
    return s, e


@router.get("/summary", response_model=ComplianceSummaryResponse)
def summary(
    site_id: str | None = None,
    user: AuthUser = Depends(get_current_user),
) -> ComplianceSummaryResponse:
    accessible = accessible_site_ids(user)
    if site_id and accessible is not None and site_id not in accessible:
        raise HTTPException(403, "No permission for this site")

    site_filter_sql = ""
    site_filter_args: list = []
    if site_id:
        site_filter_sql = " AND fs.site_id = %s"
        site_filter_args.append(site_id)
    elif accessible is not None:
        if not accessible:
            return ComplianceSummaryResponse(site_id=site_id, dials=[])
        site_filter_sql = " AND fs.site_id = ANY(%s)"
        site_filter_args.append(accessible)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT fault_id, name, description, severity FROM fault_definitions "
                "WHERE category = 'compliance' ORDER BY name"
            )
            defs = [dict(r) for r in cur.fetchall()]

            dials: list[ComplianceDial] = []
            for d in defs:
                cur.execute(
                    f"""
                    SELECT
                      COUNT(DISTINCT fs.equipment_id) FILTER (WHERE fs.active) AS active_count,
                      COUNT(DISTINCT fs.equipment_id)                            AS evaluated_count
                    FROM fault_state fs
                    WHERE fs.fault_id = %s
                      {site_filter_sql}
                    """,
                    (d["fault_id"], *site_filter_args),
                )
                row = cur.fetchone() or {"active_count": 0, "evaluated_count": 0}
                dials.append(
                    ComplianceDial(
                        fault_id=d["fault_id"],
                        name=d["name"],
                        description=d.get("description"),
                        severity=d["severity"],
                        active_count=int(row["active_count"] or 0),
                        evaluated_count=int(row["evaluated_count"] or 0),
                    )
                )
    return ComplianceSummaryResponse(site_id=site_id, dials=dials)


@router.get("/equipment-analytics", response_model=ComplianceEquipmentAnalyticsResponse)
def equipment_analytics(
    site_id: str | None = None,
    start: str | None = Query(default=None, description="ISO8601 start"),
    end: str | None = Query(default=None, description="ISO8601 end"),
    user: AuthUser = Depends(get_current_user),
) -> ComplianceEquipmentAnalyticsResponse:
    start_dt, end_dt = _resolve_period(start, end, fallback_days=7)
    accessible = accessible_site_ids(user)
    if site_id and accessible is not None and site_id not in accessible:
        raise HTTPException(403, "No permission for this site")

    sites_in_scope: list[str]
    with get_conn() as conn:
        with conn.cursor() as cur:
            if site_id:
                sites_in_scope = [site_id]
            elif accessible is None:
                cur.execute("SELECT id::text AS id FROM sites")
                sites_in_scope = [r["id"] for r in cur.fetchall()]
            else:
                sites_in_scope = list(accessible)

            if not sites_in_scope:
                return ComplianceEquipmentAnalyticsResponse(
                    site_id=site_id,
                    period={"start": start_dt.isoformat(), "end": end_dt.isoformat()},
                    rows=[],
                )

            cur.execute(
                """
                SELECT id, site_id::text AS site_id, name, equipment_type
                FROM equipment WHERE site_id::text = ANY(%s) ORDER BY site_id, name
                """,
                (sites_in_scope,),
            )
            equipment = [dict(r) for r in cur.fetchall()]
            if not equipment:
                return ComplianceEquipmentAnalyticsResponse(
                    site_id=site_id,
                    period={"start": start_dt.isoformat(), "end": end_dt.isoformat()},
                    rows=[],
                )

            equipment_ids = [str(e["id"]) for e in equipment]

            # Per-equipment temperature averages by brick class.
            cur.execute(
                """
                SELECT
                  p.equipment_id::text AS equipment_id,
                  p.brick_type,
                  AVG(tr.value)         AS avg_value
                FROM timeseries_readings tr
                JOIN points p ON p.id = tr.point_id
                WHERE p.equipment_id::text = ANY(%s)
                  AND p.brick_type = ANY(%s)
                  AND tr.ts >= %s AND tr.ts < %s
                  AND tr.value IS NOT NULL
                GROUP BY p.equipment_id, p.brick_type
                """,
                (
                    equipment_ids,
                    [SUPPLY_AIR_BRICK, RETURN_AIR_BRICK, SUPPLY_WATER_BRICK, RETURN_WATER_BRICK],
                    start_dt,
                    end_dt,
                ),
            )
            avg_by_eq: dict[str, dict[str, float]] = {}
            for row in cur.fetchall():
                avg_by_eq.setdefault(row["equipment_id"], {})[row["brick_type"]] = float(row["avg_value"])

            # In-hours compliance %: % of in-hours minutes during which no
            # category='compliance' fault was active for the equipment.
            # We compute via fault_events overlap with the schedule window.
            cur.execute(
                """
                SELECT fault_id FROM fault_definitions WHERE category = 'compliance'
                """
            )
            compliance_fault_ids = [r["fault_id"] for r in cur.fetchall()]

            cur.execute(
                "SELECT site_id, dow, start_local, end_local, tz FROM site_schedules WHERE site_id = ANY(%s)",
                (sites_in_scope,),
            )
            schedules_by_site: dict[str, list[dict]] = {}
            for r in cur.fetchall():
                schedules_by_site.setdefault(str(r["site_id"]), []).append(dict(r))

            # Fault windows in period per equipment.
            faulted_seconds_by_eq: dict[str, int] = {eid: 0 for eid in equipment_ids}
            if compliance_fault_ids:
                cur.execute(
                    """
                    SELECT
                      equipment_id::text AS equipment_id,
                      GREATEST(start_ts, %s) AS s,
                      LEAST(COALESCE(end_ts, %s), %s) AS e
                    FROM fault_events
                    WHERE equipment_id::text = ANY(%s)
                      AND fault_id = ANY(%s)
                      AND start_ts < %s
                      AND COALESCE(end_ts, now()) > %s
                    """,
                    (
                        start_dt,
                        end_dt,
                        end_dt,
                        equipment_ids,
                        compliance_fault_ids,
                        end_dt,
                        start_dt,
                    ),
                )
                # Intersect with site schedule below in Python for clarity.
                fault_windows = [
                    (r["equipment_id"], r["s"], r["e"]) for r in cur.fetchall() if r["s"] < r["e"]
                ]
            else:
                fault_windows = []

    # Build site -> equipment -> list helper
    site_for_eq: dict[str, str] = {str(e["id"]): str(e["site_id"]) for e in equipment}

    in_hours_seconds_by_eq = _in_hours_seconds_per_equipment(
        equipment_ids,
        site_for_eq,
        schedules_by_site,
        start_dt,
        end_dt,
    )

    fault_in_hours_by_eq: dict[str, int] = {eid: 0 for eid in equipment_ids}
    for eq_id, s, e in fault_windows:
        site = site_for_eq.get(eq_id)
        if not site:
            continue
        fault_in_hours_by_eq[eq_id] += _in_hours_seconds_for_interval(
            schedules_by_site.get(site, []),
            s,
            e,
        )

    rows: list[ComplianceEquipmentRow] = []
    for e in equipment:
        eid = str(e["id"])
        bricks = avg_by_eq.get(eid, {})
        supply_air = bricks.get(SUPPLY_AIR_BRICK)
        return_air = bricks.get(RETURN_AIR_BRICK)
        supply_water = bricks.get(SUPPLY_WATER_BRICK)
        return_water = bricks.get(RETURN_WATER_BRICK)

        delta_t = None
        if supply_air is not None and return_air is not None:
            delta_t = return_air - supply_air
        elif supply_water is not None and return_water is not None:
            delta_t = return_water - supply_water

        in_hours_s = in_hours_seconds_by_eq.get(eid, 0)
        fault_in_hours_s = fault_in_hours_by_eq.get(eid, 0)
        if in_hours_s > 0:
            compliance_pct = 100.0 * (1.0 - min(fault_in_hours_s, in_hours_s) / in_hours_s)
        else:
            compliance_pct = None

        rows.append(
            ComplianceEquipmentRow(
                equipment_id=e["id"],
                site_id=e["site_id"],
                name=e["name"],
                equipment_type=e.get("equipment_type"),
                avg_delta_t=delta_t,
                avg_supply_air_t=supply_air,
                avg_supply_water_t=supply_water,
                avg_return_air_t=return_air,
                avg_return_water_t=return_water,
                in_hours_compliance_pct=compliance_pct,
            )
        )

    return ComplianceEquipmentAnalyticsResponse(
        site_id=site_id,
        period={"start": start_dt.isoformat(), "end": end_dt.isoformat()},
        rows=rows,
    )


def _in_hours_seconds_for_interval(
    schedule_rows: list[dict],
    s: datetime,
    e: datetime,
) -> int:
    """Seconds of [s, e) that fall inside the site's weekly in-hours schedule.

    Iterates UTC-day boundaries. For each day we look up the schedule entry by
    ISO dow (Mon=0) and intersect with the schedule's local start/end times
    converted to UTC under the configured tz.
    """
    if e <= s:
        return 0
    if not schedule_rows:
        # No schedule defined: treat the full interval as in-hours so the
        # compliance % stays meaningful (= "never-faulted %") until the
        # operator configures one.
        return int((e - s).total_seconds())
    by_dow = {int(r["dow"]): r for r in schedule_rows}

    total = 0
    cursor = s
    # Walk forward one calendar day at a time; intervals span at most a few
    # days for v1 (period <= 30d) so the loop stays cheap.
    while cursor < e:
        day_start = cursor.replace(hour=0, minute=0, second=0, microsecond=0)
        day_end = day_start + timedelta(days=1)
        # ISO dow Mon=0..Sun=6
        dow = (day_start.weekday())
        sched = by_dow.get(dow)
        if sched is not None:
            try:
                from zoneinfo import ZoneInfo

                tz = ZoneInfo(sched["tz"])
            except Exception:
                tz = timezone.utc

            local_day = day_start.astimezone(tz)
            window_start = local_day.replace(
                hour=sched["start_local"].hour,
                minute=sched["start_local"].minute,
                second=sched["start_local"].second,
                microsecond=0,
            ).astimezone(timezone.utc)
            window_end = local_day.replace(
                hour=sched["end_local"].hour,
                minute=sched["end_local"].minute,
                second=sched["end_local"].second,
                microsecond=0,
            ).astimezone(timezone.utc)

            overlap_start = max(window_start, s, day_start)
            overlap_end = min(window_end, e, day_end)
            if overlap_end > overlap_start:
                total += int((overlap_end - overlap_start).total_seconds())

        cursor = day_end
    return total


def _in_hours_seconds_per_equipment(
    equipment_ids: list[str],
    site_for_eq: dict[str, str],
    schedules_by_site: dict[str, list[dict]],
    start_dt: datetime,
    end_dt: datetime,
) -> dict[str, int]:
    """Per-equipment count of in-hours seconds in the period."""
    out: dict[str, int] = {}
    cache: dict[str, int] = {}
    for eid in equipment_ids:
        site = site_for_eq.get(eid)
        if site is None:
            out[eid] = 0
            continue
        if site not in cache:
            cache[site] = _in_hours_seconds_for_interval(
                schedules_by_site.get(site, []),
                start_dt,
                end_dt,
            )
        out[eid] = cache[site]
    return out
