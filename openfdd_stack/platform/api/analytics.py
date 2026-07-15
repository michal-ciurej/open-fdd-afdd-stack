"""Fault analytics API - data-model driven, motor runtime, fault summary.

If the data model has no fan/VFD point for motor runtime, returns NO DATA.
For MSI/cloud integrators and Grafana (via JSON datasource or downstream ETL).
"""

import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Any, Iterator, Optional
from uuid import UUID

import pandas as pd
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response, StreamingResponse

from openfdd_stack.platform import fault_scoring
from openfdd_stack.platform.config import get_platform_settings
from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.site_resolver import resolve_site_uuid

router = APIRouter(prefix="/analytics", tags=["analytics"])

_log = logging.getLogger("open_fdd.analytics.docker_logs")

# Docker name / id: no slashes or control chars (path segment safe)
_CONTAINER_REF_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,253}$")


def _validate_container_ref(ref: str) -> str:
    ref = (ref or "").strip()
    if not _CONTAINER_REF_RE.match(ref):
        raise HTTPException(
            status_code=400,
            detail="Invalid container name or id",
        )
    return ref


def _docker_client():
    """Return docker.Docker client or None if unavailable."""
    try:
        import docker
    except ImportError:
        return None
    try:
        return docker.from_env()
    except Exception as e:
        _log.warning("Docker client init failed: %s", e)
        return None


def _container_logs_text_chunks(
    container_ref: str, *, tail: int, follow: bool
) -> Iterator[str]:
    client = _docker_client()
    if client is None:
        yield "[open-fdd] Docker is not available (install docker package and mount /var/run/docker.sock on the API container).\n"
        return
    try:
        import docker as docker_mod
    except ImportError:
        yield "[open-fdd] docker Python package is not installed on the API image.\n"
        return
    try:
        c = client.containers.get(container_ref)
    except docker_mod.errors.NotFound:
        yield f"[open-fdd] Container not found: {container_ref}\n"
        return
    except docker_mod.errors.APIError as e:
        yield f"[open-fdd] Docker API error: {e}\n"
        return
    except Exception as e:
        yield f"[open-fdd] Error resolving container: {e}\n"
        return
    try:
        stream = c.logs(
            stream=True,
            follow=follow,
            tail=tail,
            timestamps=True,
        )
        for chunk in stream:
            if isinstance(chunk, bytes):
                yield chunk.decode("utf-8", errors="replace")
            else:
                yield str(chunk)
    except Exception as e:
        yield f"\n[open-fdd] Log stream ended: {e}\n"

# Brick types that indicate fan/VFD for motor runtime (data-model driven)
MOTOR_BRICK_PATTERNS = (
    "%Fan%Status%",
    "%Fan%Speed%",
    "%Fan%Command%",
    "%VFD%",
    "%Variable_Frequency_Drive%",
)


def _motor_point_for_site(site_uuid: str) -> Optional[dict]:
    """Find first fan/VFD point for site from data model. Returns None if none."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            conditions = " OR ".join(
                ["p.brick_type ILIKE %s"] * len(MOTOR_BRICK_PATTERNS)
            )
            cur.execute(
                f"""
                SELECT p.id, p.external_id, p.brick_type
                FROM points p
                WHERE p.site_id = %s AND ({conditions})
                LIMIT 1
                """,
                (str(site_uuid),) + MOTOR_BRICK_PATTERNS,
            )
            row = cur.fetchone()
    return dict(row) if row else None


def _motor_runtime_hours(point_id: str, start_ts: datetime, end_ts: datetime) -> float:
    """Compute motor runtime (hours) from timeseries where value > 0.01."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ts, value FROM timeseries_readings
                WHERE point_id = %s AND ts >= %s AND ts <= %s
                ORDER BY ts
                """,
                (point_id, start_ts, end_ts),
            )
            rows = cur.fetchall()
    if not rows or len(rows) < 2:
        return 0.0
    df = pd.DataFrame(rows)
    df["ts"] = pd.to_datetime(df["ts"])
    df = df.set_index("ts").sort_index()
    delta = df.index.to_series().diff()
    motor_on = df["value"].gt(0.01).astype(int)
    hours = (delta * motor_on).sum() / pd.Timedelta(hours=1)
    return round(float(hours), 2)


@router.get("/motor-runtime", summary="Motor runtime (data-model driven)")
def get_motor_runtime(
    site_id: str = Query(..., description="Site name or UUID"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
):
    """
    **Data-model driven:** If no fan/VFD point in the data model, returns NO DATA.
    Otherwise returns motor runtime hours (sum of intervals when fan speed/status > 0.01).
    For MSI/cloud: poll this for runtime analytics. Grafana: use JSON datasource or ETL.
    """
    site_uuid = resolve_site_uuid(site_id, create_if_empty=False)
    if site_uuid is None:
        raise HTTPException(404, f"No site found for: {site_id!r}")

    point = _motor_point_for_site(str(site_uuid))
    if not point:
        return {
            "site_id": site_id,
            "motor_runtime_hours": None,
            "status": "NO DATA",
            "reason": "No fan/VFD point in data model (brick_type: Supply_Fan_Status, Supply_Fan_Speed_Command, etc.)",
        }

    start_ts = datetime.combine(start_date, datetime.min.time())
    end_ts = datetime.combine(end_date, datetime.max.time())

    hours = _motor_runtime_hours(str(point["id"]), start_ts, end_ts)

    # Cache for Grafana (queries analytics_motor_runtime table)
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO analytics_motor_runtime
                      (site_id, period_start, period_end, runtime_hours, point_external_id, point_brick_type, updated_at)
                    VALUES (%s, %s, %s, %s, %s, %s, now())
                    ON CONFLICT (site_id, period_start, period_end) DO UPDATE SET
                      runtime_hours = EXCLUDED.runtime_hours,
                      point_external_id = EXCLUDED.point_external_id,
                      point_brick_type = EXCLUDED.point_brick_type,
                      updated_at = now()
                    """,
                    (
                        site_id,
                        start_date,
                        end_date,
                        hours,
                        point["external_id"],
                        point["brick_type"],
                    ),
                )
                conn.commit()
    except Exception:
        pass  # Table may not exist yet; API still returns correct JSON

    return {
        "site_id": site_id,
        "motor_runtime_hours": hours,
        "point": {
            "external_id": point["external_id"],
            "brick_type": point["brick_type"],
        },
        "period": {"start": str(start_date), "end": str(end_date)},
    }


@router.get("/fault-summary", summary="Fault summary by fault_id")
def get_fault_summary(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
):
    """
    Fault counts by fault_id. For MSI/cloud and Grafana JSON datasource.
    active_in_period = count of distinct (site, equipment, fault) that were active (flag_value=1)
    in the range; not summed. total_faults kept for chart compatibility (sum of flag_value).
    """
    conditions = ["ts::date >= %s", "ts::date <= %s"]
    params: list = [start_date, end_date]
    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            raise HTTPException(404, f"No site found for: {site_id!r}")
        conditions.append(
            "(site_id = %s OR site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT fault_id, COUNT(*) AS count, SUM(flag_value) AS flag_sum
                FROM fault_results
                WHERE {" AND ".join(conditions)}
                GROUP BY fault_id
                ORDER BY flag_sum DESC
                """,
                params,
            )
            rows = cur.fetchall()
            # Active-in-period: distinct (site_id, equipment_id, fault_id) with at least one flag_value=1 in range
            active_conditions = [
                "ts::date >= %s",
                "ts::date <= %s",
                "flag_value = 1",
            ]
            active_params: list = [start_date, end_date]
            if site_id:
                active_conditions.append(
                    "(site_id = %s OR site_id IN (SELECT name FROM sites WHERE id::text = %s))"
                )
                active_params.extend([site_id, site_id])
            cur.execute(
                f"""
                SELECT COUNT(*) AS n FROM (
                    SELECT 1 FROM fault_results
                    WHERE {" AND ".join(active_conditions)}
                    GROUP BY site_id, equipment_id, fault_id
                ) sub
                """,
                active_params,
            )
            active_row = cur.fetchone()
    active_in_period = int(active_row["n"]) if active_row else 0

    by_fault = [
        {"fault_id": r["fault_id"], "count": r["count"], "flag_sum": r["flag_sum"]}
        for r in rows
    ]
    return {
        "site_id": site_id,
        "period": {"start": str(start_date), "end": str(end_date)},
        "by_fault_id": by_fault,
        "total_faults": sum(r["flag_sum"] for r in rows),
        "active_in_period": active_in_period,
    }


@router.get(
    "/fault-summary-by-site",
    summary="Active-in-period fault count per site (overview cards)",
)
def get_fault_summary_by_site(
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
):
    """
    Per-site version of the Faults page 'active_in_period' counter.

    active_in_period = count of distinct (site, equipment, fault) that have at least one
    flag_value=1 row in the range. Returned per site so the Overview page can render
    all site cards without N requests.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT
                  s.id::text AS site_id,
                  s.name AS site_name,
                  COUNT(*)::int AS active_in_period
                FROM (
                  SELECT
                    fr.site_id,
                    fr.equipment_id,
                    fr.fault_id
                  FROM fault_results fr
                  WHERE fr.ts::date >= %s
                    AND fr.ts::date <= %s
                    AND fr.flag_value = 1
                  GROUP BY fr.site_id, fr.equipment_id, fr.fault_id
                ) active
                JOIN sites s
                  ON (s.id::text = active.site_id OR s.name = active.site_id)
                GROUP BY s.id, s.name
                ORDER BY s.name
                """,
                (start_date, end_date),
            )
            rows = cur.fetchall()

    return {
        "period": {"start": str(start_date), "end": str(end_date)},
        "by_site": [
            {
                "site_id": r["site_id"],
                "site_name": r["site_name"],
                "active_in_period": int(r["active_in_period"]),
            }
            for r in rows
        ],
    }


def _ts_iso_utc(dt: Optional[datetime]) -> Optional[str]:
    """Format datetime as ISO UTC with Z so frontend parses as UTC."""
    if dt is None:
        return None
    if getattr(dt, "tzinfo", None) is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def fetch_fault_timeseries_data(
    site_id: Optional[str],
    start_date: date,
    end_date: date,
    bucket: str = "day",
    equipment_ids: Optional[list[str]] = None,
) -> dict[str, Any]:
    """Return fault-timeseries payload for charts (GET /analytics/fault-timeseries).

    When ``equipment_ids`` is set, aggregates are limited to those equipment rows
    (Plots page device scope). Otherwise behavior is site-wide (dashboard chart).
    """
    if bucket not in ("hour", "day", "raw"):
        bucket = "hour"  # API default for invalid bucket; AI agent passes "day" explicitly
    conditions = ["fr.ts::date >= %s", "fr.ts::date <= %s"]
    params: list = [start_date, end_date]
    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            return {"site_id": site_id, "period": {"start": str(start_date), "end": str(end_date)}, "bucket": bucket, "series": []}
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])
    if equipment_ids:
        # fr.equipment_id may be stored as the equipment UUID (current FDD runs) or
        # its NAME (legacy runs), so match either: the passed UUIDs directly, or the
        # names those UUIDs resolve to. Mirrors the name-or-uuid tolerance elsewhere.
        placeholders = ",".join(["%s"] * len(equipment_ids))
        conditions.append(
            f"(fr.equipment_id IN ({placeholders}) "
            "OR fr.equipment_id IN (SELECT name FROM equipment WHERE id::text = ANY(%s)))"
        )
        params.extend(equipment_ids)
        params.append(list(equipment_ids))

    with get_conn() as conn:
        with conn.cursor() as cur:
            if bucket == "raw":
                # Native FDD-run resolution: one point per evaluated timestamp,
                # not date-truncated. fault_results is append-only and each run
                # re-evaluates an overlapping lookback window, so the same
                # (ts, equipment, fault) is written by several runs. COUNT(DISTINCT
                # equipment_id) over flagged rows dedupes that overlap and yields
                # the number of equipment flagged for each issue at that timestamp.
                cur.execute(
                    f"""
                    SELECT fr.ts AS time, fr.fault_id AS metric,
                           COUNT(DISTINCT fr.equipment_id)::float AS value
                    FROM fault_results fr
                    WHERE {" AND ".join(conditions)} AND fr.flag_value > 0
                    GROUP BY fr.ts, fr.fault_id
                    ORDER BY fr.ts, fr.fault_id
                    """,
                    params,
                )
            else:
                cur.execute(
                    f"""
                    SELECT date_trunc(%s, fr.ts) AS time, fr.fault_id AS metric, SUM(fr.flag_value)::float AS value
                    FROM fault_results fr
                    WHERE {" AND ".join(conditions)}
                    GROUP BY 1, fr.fault_id
                    ORDER BY 1, fr.fault_id
                    """,
                    [bucket, *params],
                )
            rows = cur.fetchall()

    out: dict[str, Any] = {
        "site_id": site_id,
        "period": {"start": str(start_date), "end": str(end_date)},
        "bucket": bucket,
        "series": [
            {"time": _ts_iso_utc(r["time"]), "metric": r["metric"], "value": float(r["value"])}
            for r in rows
        ],
    }
    if equipment_ids is not None:
        out["equipment_ids"] = equipment_ids
    return out


@router.get("/fault-timeseries", summary="Fault flags over time (for charts)")
def get_fault_timeseries(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
    bucket: str = Query(
        "hour",
        description="Time bucket: hour, day, or raw (per-FDD-run native resolution)",
        pattern="^(hour|day|raw)$",
    ),
    equipment_ids: list[UUID] | None = Query(
        None,
        description=(
            "Repeatable. When set, restrict series to fault_results rows for these equipment IDs "
            "(e.g. BACnet device scope on Plots)."
        ),
    ),
):
    """
    Time-series of fault flag values (for React/Grafana-style charts).
    Returns one row per (time_bucket, fault_id) with SUM(flag_value).
    Without equipment_ids, aggregates are site-wide; with equipment_ids, only those rows contribute.
    """
    if site_id and resolve_site_uuid(site_id, create_if_empty=False) is None:
        raise HTTPException(404, f"No site found for: {site_id!r}")
    eq_strs = [str(u) for u in equipment_ids] if equipment_ids else None
    return fetch_fault_timeseries_data(site_id, start_date, end_date, bucket, eq_strs)


def fetch_faults_by_equipment_data(
    site_id: Optional[str],
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """Return faults-by-equipment payload for tables/charts (GET /analytics/faults-by-equipment)."""
    conditions = [
        "fr.ts::date >= %s",
        "fr.ts::date <= %s",
        "fr.flag_value = 1",
    ]
    params: list = [start_date, end_date]
    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            return {"site_id": site_id, "period": {"start": str(start_date), "end": str(end_date)}, "by_equipment": []}
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                WITH active AS (
                    SELECT fr.site_id, fr.equipment_id,
                           COUNT(DISTINCT fr.fault_id) AS active_fault_count
                    FROM fault_results fr
                    WHERE {" AND ".join(conditions)}
                    GROUP BY fr.site_id, fr.equipment_id
                )
                SELECT a.site_id, a.equipment_id AS equipment_id_text, a.active_fault_count,
                       e.id AS equipment_uuid, e.name AS equipment_name,
                       (SELECT p.bacnet_device_id FROM points p
                        WHERE p.equipment_id = e.id AND p.bacnet_device_id IS NOT NULL
                        LIMIT 1) AS bacnet_device_id
                FROM active a
                LEFT JOIN sites s ON (s.name = a.site_id OR s.id::text = a.site_id)
                LEFT JOIN equipment e ON e.site_id = s.id
                    AND (e.name = a.equipment_id OR e.id::text = a.equipment_id)
                ORDER BY a.active_fault_count DESC, a.equipment_id
                """,
                params,
            )
            rows = cur.fetchall()

    out = []
    for r in rows:
        out.append(
            {
                "site_id": r["site_id"],
                "equipment_id": r["equipment_uuid"] if r["equipment_uuid"] else r["equipment_id_text"],
                "equipment_name": r["equipment_name"] or r["equipment_id_text"] or "-",
                "bacnet_device_id": r["bacnet_device_id"],
                "active_fault_count": int(r["active_fault_count"]),
            }
        )
    return {
        "site_id": site_id,
        "period": {"start": str(start_date), "end": str(end_date)},
        "by_equipment": out,
    }


@router.get("/faults-by-equipment", summary="Fault count per device (for bar chart)")
def get_faults_by_equipment(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
):
    """
    Per-equipment count of distinct faults active in the period (flag_value=1).
    For bar chart: which device had how many active faults in the range.
    """
    if site_id and resolve_site_uuid(site_id, create_if_empty=False) is None:
        raise HTTPException(404, f"No site found for: {site_id!r}")
    return fetch_faults_by_equipment_data(site_id, start_date, end_date)


@router.get(
    "/fault-counts-by-equipment",
    summary="Counts per equipment × fault_id (for equipment fault table)",
)
def get_fault_counts_by_equipment(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
):
    """
    Return per-equipment per-fault counts in a date range (flag_value=1 rows).

    Intended for a table: one row per equipment, columns = faults (or grouped list).
    """
    conditions = ["fr.ts::date >= %s", "fr.ts::date <= %s", "fr.flag_value = 1"]
    params: list = [start_date, end_date]
    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            raise HTTPException(404, f"No site found for: {site_id!r}")
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                  fr.site_id,
                  fr.equipment_id,
                  e.name AS equipment_name,
                  e.equipment_type,
                  fr.fault_id,
                  fd.name AS fault_name,
                  fd.severity AS fault_severity,
                  fd.category AS fault_category,
                  COUNT(*)::int AS fault_count,
                  MIN(fr.ts) AS first_ts,
                  MAX(fr.ts) AS last_ts
                FROM fault_results fr
                LEFT JOIN sites s
                  ON (s.id::text = fr.site_id OR s.name = fr.site_id)
                LEFT JOIN equipment e
                  ON e.site_id = s.id AND e.id::text = fr.equipment_id
                LEFT JOIN fault_definitions fd
                  ON fd.fault_id = fr.fault_id
                WHERE {" AND ".join(conditions)}
                GROUP BY
                  fr.site_id, fr.equipment_id, e.name, e.equipment_type,
                  fr.fault_id, fd.name, fd.severity, fd.category
                ORDER BY e.name NULLS LAST, fr.fault_id
                """,
                params,
            )
            rows = cur.fetchall()
    out = []
    for r in rows:
        out.append(
            {
                "site_id": r["site_id"],
                "equipment_id": r["equipment_id"],
                "equipment_name": r.get("equipment_name") or r["equipment_id"] or "-",
                "equipment_type": r.get("equipment_type"),
                "fault_id": r["fault_id"],
                "fault_name": r.get("fault_name") or r["fault_id"],
                "fault_severity": r.get("fault_severity") or "warning",
                "fault_category": r.get("fault_category") or "general",
                "count": int(r["fault_count"]),
                "first_ts": _ts_iso_utc_str(r.get("first_ts")),
                "last_ts": _ts_iso_utc_str(r.get("last_ts")),
            }
        )
    return {
        "site_id": site_id,
        "period": {"start": str(start_date), "end": str(end_date)},
        "rows": out,
    }


# --- Equipment attention score (Issues page ranking) -----------------------


def _attention_bucket_unit(start_date: date, end_date: date) -> str:
    """Day buckets normally; hour buckets for windows <= 2 days so the per-day
    slope trend still has enough points on the 24h preset."""
    return "hour" if (end_date - start_date).days <= 2 else "day"


def _days_active(first_ts: Optional[datetime], last_ts: Optional[datetime]) -> Optional[int]:
    if first_ts is None or last_ts is None:
        return None
    return max(1, (last_ts.date() - first_ts.date()).days + 1)


def _humanize_type(t: Optional[str]) -> str:
    return t.replace("_", " ") if t else "Untyped equipment"


def _aggregate_attention(
    site_id: Optional[str],
    start_date: date,
    end_date: date,
    bucket_unit: str,
) -> dict[str, dict]:
    """Per-(equipment, fault, time-bucket) aggregation of fault_results.

    Returns a dict keyed by equipment id/name. Persistence uses COUNT(DISTINCT ts)
    for both flagged and total so the append-only overlap between FDD runs (the
    same ts re-written each run) is deduped, mirroring the raw-bucket logic.
    """
    conditions = ["fr.ts::date >= %s", "fr.ts::date <= %s"]
    cond_params: list = [start_date, end_date]
    if site_id:
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        cond_params.extend([site_id, site_id])

    # %s order in the SQL: SELECT date_trunc, WHERE bounds (+site), GROUP BY date_trunc.
    params = [bucket_unit, *cond_params, bucket_unit]

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT
                  fr.site_id,
                  fr.equipment_id,
                  e.id::text AS equipment_uuid,
                  e.name AS equipment_name,
                  e.equipment_type,
                  fr.fault_id,
                  fd.name AS fault_name,
                  fd.severity AS fault_severity,
                  fd.category AS fault_category,
                  date_trunc(%s, fr.ts) AS bucket,
                  COUNT(DISTINCT fr.ts) AS total_ts,
                  COUNT(DISTINCT fr.ts) FILTER (WHERE fr.flag_value = 1) AS flagged_ts,
                  MIN(fr.ts) AS first_ts,
                  MAX(fr.ts) AS last_ts,
                  bool_or(fs.active) AS is_active
                FROM fault_results fr
                LEFT JOIN sites s
                  ON (s.id::text = fr.site_id OR s.name = fr.site_id)
                LEFT JOIN equipment e
                  ON e.site_id = s.id
                  AND (e.id::text = fr.equipment_id OR e.name = fr.equipment_id)
                LEFT JOIN fault_definitions fd
                  ON fd.fault_id = fr.fault_id
                LEFT JOIN fault_state fs
                  ON fs.site_id = fr.site_id
                  AND fs.equipment_id = fr.equipment_id
                  AND fs.fault_id = fr.fault_id
                WHERE {" AND ".join(conditions)}
                GROUP BY
                  fr.site_id, fr.equipment_id, e.id, e.name, e.equipment_type,
                  fr.fault_id, fd.name, fd.severity, fd.category, date_trunc(%s, fr.ts)
                ORDER BY fr.equipment_id, fr.fault_id, bucket
                """,
                params,
            )
            rows = cur.fetchall()

    equip: dict[str, dict] = {}
    for r in rows:
        ekey = r["equipment_uuid"] or r["equipment_id"]
        e = equip.get(ekey)
        if e is None:
            e = {
                "equipment_id": r["equipment_uuid"] or r["equipment_id"],
                "site_id": r["site_id"],
                "name": r["equipment_name"] or r["equipment_id"] or "-",
                "type": r.get("equipment_type"),
                "faults": {},
            }
            equip[ekey] = e
        f = e["faults"].get(r["fault_id"])
        if f is None:
            f = {
                "fault_id": r["fault_id"],
                "name": r.get("fault_name") or r["fault_id"],
                "severity": (r.get("fault_severity") or "warning"),
                "category": r.get("fault_category") or "general",
                "flagged_ts": 0,
                "total_ts": 0,
                "first_ts": None,
                "last_ts": None,
                "is_active": False,
                "buckets": [],  # (bucket_ts, persistence)
            }
            e["faults"][r["fault_id"]] = f
        flagged = int(r["flagged_ts"] or 0)
        total = int(r["total_ts"] or 0)
        f["flagged_ts"] += flagged
        f["total_ts"] += total
        if r["first_ts"] is not None and (f["first_ts"] is None or r["first_ts"] < f["first_ts"]):
            f["first_ts"] = r["first_ts"]
        if r["last_ts"] is not None and (f["last_ts"] is None or r["last_ts"] > f["last_ts"]):
            f["last_ts"] = r["last_ts"]
        f["is_active"] = f["is_active"] or bool(r.get("is_active"))
        f["buckets"].append((r["bucket"], (flagged / total) if total else 0.0))
    return equip


def _score_units(equip: dict[str, dict]) -> list[dict]:
    """Roll aggregated equipment into scored, banded rows (units with >=1 fault
    that fired in the period), ranked worst-first."""
    out: list[dict] = []
    for e in equip.values():
        fired = [f for f in e["faults"].values() if f["flagged_ts"] > 0]
        if not fired:
            continue
        faults = []
        for f in fired:
            persistence = f["flagged_ts"] / f["total_ts"] if f["total_ts"] else 0.0
            faults.append(
                {
                    "fault_id": f["fault_id"],
                    "name": f["name"],
                    "severity": f["severity"],
                    "persistence": round(persistence, 3),
                    "count": f["flagged_ts"],
                    "is_active": f["is_active"],
                }
            )
        faults.sort(
            key=lambda x: fault_scoring.contribution(x["severity"], x["persistence"]),
            reverse=True,
        )
        score = fault_scoring.equipment_score(faults)
        band = fault_scoring.band(score, faults)
        dom = fault_scoring.dominant_fault(faults)
        dom_raw = e["faults"][dom["fault_id"]]
        series = [p for (_, p) in sorted(dom_raw["buckets"], key=lambda bp: bp[0])]
        out.append(
            {
                "id": e["equipment_id"],
                "site_id": e["site_id"],
                "name": e["name"],
                "type": e["type"],
                "score": score,
                "band": band,
                "trend": fault_scoring.trend(series),
                "dominant": {
                    "fault_id": dom["fault_id"],
                    "name": dom["name"],
                    "severity": dom["severity"],
                    "persistence": dom["persistence"],
                    "days_active": _days_active(dom_raw["first_ts"], dom_raw["last_ts"]),
                },
                "faults": faults,
            }
        )
    _BAND_RANK = {"attention": 0, "degraded": 1, "healthy": 2}
    out.sort(key=lambda u: (_BAND_RANK.get(u["band"], 3), -u["score"]))
    return out


def fetch_equipment_attention_data(
    site_id: Optional[str],
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """Build the /analytics/equipment-attention payload (ranked, banded units)."""
    bucket_unit = _attention_bucket_unit(start_date, end_date)
    equip = _aggregate_attention(site_id, start_date, end_date, bucket_unit)
    scored = _score_units(equip)

    attention = [u for u in scored if u["band"] == "attention"]
    degraded = [u for u in scored if u["band"] == "degraded"]
    evaluated = len(equip)
    scored_ids = {u["id"] for u in attention + degraded}

    # critical faults currently active, across all evaluated equipment
    critical_active = 0
    for e in equip.values():
        for f in e["faults"].values():
            if (
                (f["severity"] or "").strip().lower() == "critical"
                and f["flagged_ts"] > 0
                and f["is_active"]
            ):
                critical_active += 1

    # worst-affected equipment type (among units needing attention / degraded)
    flagged_by_type: dict[str, int] = {}
    total_by_type: dict[str, int] = {}
    for e in equip.values():
        total_by_type[_humanize_type(e["type"])] = (
            total_by_type.get(_humanize_type(e["type"]), 0) + 1
        )
    for u in attention + degraded:
        label = _humanize_type(u["type"])
        flagged_by_type[label] = flagged_by_type.get(label, 0) + 1
    worst_system = None
    if flagged_by_type:
        label = max(flagged_by_type, key=lambda k: flagged_by_type[k])
        worst_system = {
            "label": label,
            "detail": f"{flagged_by_type[label]} of {total_by_type.get(label, flagged_by_type[label])} flagged",
        }

    healthy_names = [
        e["name"] for e in equip.values() if e["equipment_id"] not in scored_ids
    ]

    # week-over-week: attention count in the immediately preceding equal window
    vs_last_period = None
    try:
        span = end_date - start_date
        prev_end = start_date - timedelta(days=1)
        prev_start = prev_end - span
        prev_bucket = _attention_bucket_unit(prev_start, prev_end)
        prev_scored = _score_units(
            _aggregate_attention(site_id, prev_start, prev_end, prev_bucket)
        )
        prev_attention = sum(1 for u in prev_scored if u["band"] == "attention")
        vs_last_period = {
            "attention_delta": len(attention) - prev_attention,
            "prev": prev_attention,
        }
    except Exception:  # noqa: BLE001 - KPI is best-effort, never break the page
        vs_last_period = None

    return {
        "site_id": site_id,
        "period": {"start": str(start_date), "end": str(end_date)},
        "bands": {
            "attention": len(attention),
            "degraded": len(degraded),
            "healthy": max(0, evaluated - len(attention) - len(degraded)),
            "evaluated": evaluated,
        },
        "critical_active": critical_active,
        "worst_system": worst_system,
        "vs_last_period": vs_last_period,
        "equipment": attention + degraded,
        "healthy_sample": healthy_names[:6],
    }


@router.get(
    "/equipment-attention",
    summary="Equipment ranked by derived attention score (Issues page)",
)
def get_equipment_attention(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
):
    """
    Rank equipment by a derived **attention score** = sum over active faults of
    severity-weight x persistence (share of FDD checks failed). Units are bucketed
    into attention / degraded / healthy bands with a per-bucket-slope trend, so
    facilities managers see which units to visit first rather than raw fault counts.

    See ``fault_scoring`` for the weights and band thresholds (tunable constants).
    """
    if site_id and resolve_site_uuid(site_id, create_if_empty=False) is None:
        raise HTTPException(404, f"No site found for: {site_id!r}")
    return fetch_equipment_attention_data(site_id, start_date, end_date)


@router.get(
    "/equipment-fault-counts",
    summary="Paged equipment list with fault counts (Equipment view)",
)
def get_equipment_fault_counts(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: date = Query(..., description="Start of range"),
    end_date: date = Query(..., description="End of range"),
    equipment_type: Optional[str] = Query(None, description="Filter by equipment.equipment_type"),
    active_faults_only: bool = Query(False, description="Only equipment with active faults (fault_state.active=true)"),
    q: Optional[str] = Query(None, description="Search equipment name (case-insensitive contains)"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    Return paged equipment rows with:
      - fault_count_in_period: distinct fault_id count with flag_value=1 in the date range
      - active_fault_count: distinct active fault_id count from fault_state (current)

    Used by the frontend Equipment view for lazy loading + filters.
    """
    conditions: list[str] = ["1=1"]
    params: list = []

    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            raise HTTPException(404, f"No site found for: {site_id!r}")
        conditions.append(
            "(s.id::text = %s OR s.name = %s)"
        )
        params.extend([site_id, site_id])

    if equipment_type:
        conditions.append("e.equipment_type = %s")
        params.append(equipment_type)

    if q:
        conditions.append("e.name ILIKE %s")
        params.append(f"%{q}%")

    # Fault counts in selected date range.
    period_start = start_date
    period_end = end_date

    active_join = ""
    if active_faults_only:
        # Only include equipment that currently has at least one active fault.
        # Use DISTINCT equipment IDs to avoid duplicating one equipment row per active fault.
        active_join = """
        JOIN (
          SELECT DISTINCT equipment_id::text AS equipment_id
          FROM fault_state
          WHERE active = true
        ) fs_active ON fs_active.equipment_id = e.id::text
        """

    with get_conn() as conn:
        with conn.cursor() as cur:
            # Total count for pagination.
            cur.execute(
                f"""
                SELECT COUNT(*)::int AS n
                FROM equipment e
                JOIN sites s ON s.id = e.site_id
                {active_join}
                WHERE {" AND ".join(conditions)}
                """,
                params,
            )
            total = int(cur.fetchone()["n"])

            # Page rows with fault counts.
            cur.execute(
                f"""
                WITH faults_in_period AS (
                  SELECT fr.equipment_id, COUNT(DISTINCT fr.fault_id)::int AS fault_count_in_period
                  FROM fault_results fr
                  WHERE fr.ts::date >= %s
                    AND fr.ts::date <= %s
                    AND fr.flag_value = 1
                  GROUP BY fr.equipment_id
                ),
                active_faults AS (
                  SELECT fs.equipment_id::text AS equipment_id, COUNT(DISTINCT fs.fault_id)::int AS active_fault_count
                  FROM fault_state fs
                  WHERE fs.active = true
                  GROUP BY fs.equipment_id
                )
                SELECT
                  e.id::text AS id,
                  e.site_id::text AS site_id,
                  s.name AS site_name,
                  e.name,
                  e.equipment_type,
                  COALESCE(fip.fault_count_in_period, 0) AS fault_count_in_period,
                  COALESCE(af.active_fault_count, 0) AS active_fault_count
                FROM equipment e
                JOIN sites s ON s.id = e.site_id
                {active_join}
                LEFT JOIN faults_in_period fip ON fip.equipment_id = e.id::text
                LEFT JOIN active_faults af ON af.equipment_id = e.id::text
                WHERE {" AND ".join(conditions)}
                ORDER BY e.name
                LIMIT %s OFFSET %s
                """,
                [period_start, period_end, *params, limit, offset],
            )
            rows = cur.fetchall()

    return {
        "site_id": site_id,
        "period": {"start": str(start_date), "end": str(end_date)},
        "paging": {"limit": limit, "offset": offset, "total": total},
        "rows": [
            {
                "id": r["id"],
                "site_id": r["site_id"],
                "site_name": r["site_name"],
                "name": r["name"],
                "equipment_type": r.get("equipment_type"),
                "fault_count_in_period": int(r["fault_count_in_period"]),
                "active_fault_count": int(r["active_fault_count"]),
            }
            for r in rows
        ],
    }


@router.get(
    "/fault-results-series",
    summary="Distinct fault × site × equipment (for data preview selector)",
)
def get_fault_results_series(
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    start_date: Optional[date] = Query(
        None, description="Start of range; omit for last 30 days"
    ),
    end_date: Optional[date] = Query(None, description="End of range; omit for today"),
):
    """
    Returns distinct (fault_id, site_id, equipment_id) that have fault_results in the range.
    Used by the frontend to build the "which dataframe to view" selector (tabs/dropdown).
    """
    end = end_date or date.today()
    start = start_date or (end - timedelta(days=30))
    conditions = ["fr.ts::date >= %s", "fr.ts::date <= %s"]
    params: list = [start, end]
    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            raise HTTPException(404, f"No site found for: {site_id!r}")
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT DISTINCT fr.fault_id, fr.site_id, fr.equipment_id
                FROM fault_results fr
                WHERE {" AND ".join(conditions)}
                ORDER BY fr.fault_id, fr.site_id, fr.equipment_id
                """,
                params,
            )
            rows = cur.fetchall()
            # Resolve equipment names for labels
            out = []
            for r in rows:
                cur.execute(
                    """
                    SELECT e.name AS equipment_name
                    FROM sites s
                    LEFT JOIN equipment e ON e.site_id = s.id
                        AND (e.name = %s OR e.id::text = %s)
                    WHERE s.name = %s OR s.id::text = %s
                    LIMIT 1
                    """,
                    (r["equipment_id"], r["equipment_id"], r["site_id"], r["site_id"]),
                )
                eq = cur.fetchone()
                equipment_name = (
                    (eq and eq["equipment_name"]) or r["equipment_id"] or "-"
                )
                out.append(
                    {
                        "fault_id": r["fault_id"],
                        "site_id": r["site_id"],
                        "equipment_id": r["equipment_id"],
                        "label": f"{r['fault_id']} - {equipment_name}",
                    }
                )
    return {"series": out, "period": {"start": str(start), "end": str(end)}}


def _ts_iso_utc_str(dt) -> str:
    """Format for fault-results-raw response (returns str)."""
    if hasattr(dt, "isoformat"):
        if getattr(dt, "tzinfo", None) is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.isoformat().replace("+00:00", "Z")
    return str(dt)


def get_point_ids_for_agent(site_id: Optional[str], limit: int = 20) -> list[str]:
    """Return up to limit point UUIDs for Overview AI (all points or for site). Used to auto-include point plots."""
    site_uuid = resolve_site_uuid(site_id, create_if_empty=False) if site_id else None
    with get_conn() as conn:
        with conn.cursor() as cur:
            if site_uuid is not None:
                cur.execute(
                    "SELECT id FROM points WHERE site_id = %s ORDER BY external_id LIMIT %s",
                    (str(site_uuid), limit),
                )
            else:
                cur.execute(
                    "SELECT id FROM points ORDER BY external_id LIMIT %s",
                    (limit,),
                )
            rows = cur.fetchall()
    return [str(r["id"]) for r in rows]


def fetch_point_timeseries_data(
    point_ids: list[str],
    start_date: date,
    end_date: date,
) -> dict[str, Any]:
    """Return point timeseries for charts (plots UI / analytics)."""
    if not point_ids:
        return {"period": {"start": str(start_date), "end": str(end_date)}, "series": [], "point_labels": {}}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT tr.ts, p.id AS point_id, p.external_id, tr.value
                FROM timeseries_readings tr
                JOIN points p ON tr.point_id = p.id
                WHERE p.id::text = ANY(%s)
                  AND tr.ts::date >= %s AND tr.ts::date <= %s
                ORDER BY tr.ts, p.id
                """,
                (point_ids, start_date, end_date),
            )
            rows = cur.fetchall()
    point_labels: dict[str, str] = {}
    series = []
    for r in rows:
        pid = str(r["point_id"])
        external_id = r["external_id"] or pid
        point_labels[pid] = external_id
        series.append({
            "time": _ts_iso_utc(r["ts"]),
            "metric": external_id,
            "value": float(r["value"]),
        })
    return {
        "period": {"start": str(start_date), "end": str(end_date)},
        "series": series,
        "point_labels": point_labels,
    }


def fetch_fault_results_sample(
    site_id: Optional[str],
    limit: int = 10,
) -> dict[str, Any]:
    """Return last N fault_results rows (any fault) for tabular display."""
    conditions = []
    params: list = []
    if site_id:
        if resolve_site_uuid(site_id, create_if_empty=False) is None:
            return {"rows": [], "count": 0}
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])
    params.append(limit)
    where = " AND ".join(conditions) if conditions else "1=1"
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT ts, site_id, equipment_id, fault_id, flag_value, evidence
                FROM fault_results fr
                WHERE {where}
                ORDER BY ts DESC
                LIMIT %s
                """,
                params,
            )
            rows = cur.fetchall()
    rows = list(reversed(rows))  # chronological for display
    return {
        "rows": [
            {
                "ts": _ts_iso_utc_str(r["ts"]),
                "site_id": r["site_id"],
                "equipment_id": r["equipment_id"],
                "fault_id": r["fault_id"],
                "flag_value": int(r["flag_value"]),
                "evidence": r["evidence"],
            }
            for r in rows
        ],
        "count": len(rows),
    }


@router.get(
    "/fault-results-raw", summary="Last N rows of fault_results (for data preview grid)"
)
def get_fault_results_raw(
    fault_id: str = Query(..., description="Fault ID (e.g. from YAML)"),
    site_id: Optional[str] = Query(None, description="Site name or UUID; omit for all"),
    equipment_id: Optional[str] = Query(
        None, description="Equipment id/name; omit for all"
    ),
    limit: int = Query(50, ge=1, le=500, description="Number of rows (most recent)"),
):
    """
    Returns the last N rows from fault_results for the given fault_id (and optional site/equipment).
    For Excel-style data preview: timestamp, site_id, equipment_id, fault_id, flag_value, evidence.
    """
    conditions = ["fr.fault_id = %s"]
    params: list = [fault_id]
    if site_id:
        conditions.append(
            "(fr.site_id = %s OR fr.site_id IN (SELECT name FROM sites WHERE id::text = %s))"
        )
        params.extend([site_id, site_id])
    if equipment_id:
        conditions.append("fr.equipment_id = %s")
        params.append(equipment_id)
    params.append(limit)

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT ts, site_id, equipment_id, fault_id, flag_value, evidence
                FROM fault_results fr
                WHERE {" AND ".join(conditions)}
                ORDER BY ts DESC
                LIMIT %s
                """,
                params,
            )
            rows = cur.fetchall()

    # Most recent first in DB; for spreadsheet show chronological (oldest first)
    rows = list(reversed(rows))
    return {
        "rows": [
            {
                "ts": _ts_iso_utc_str(r["ts"]),
                "site_id": r["site_id"],
                "equipment_id": r["equipment_id"],
                "fault_id": r["fault_id"],
                "flag_value": int(r["flag_value"]),
                "evidence": r["evidence"],
            }
            for r in rows
        ],
        "count": len(rows),
    }


# --- System resources (host_metrics, container_metrics, disk_metrics from stack-host-stats) ---


def _table_exists(table: str) -> bool:
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = %s",
                    (table,),
                )
                return cur.fetchone() is not None
    except Exception:
        return False


@router.get("/system/host", summary="Latest host metrics (memory, load, swap)")
def get_system_host():
    """Latest row per host from host_metrics. Empty if table missing or host-stats not running."""
    if not _table_exists("host_metrics"):
        return {"hosts": []}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (hostname) hostname, ts,
                  mem_total_bytes, mem_used_bytes, mem_available_bytes,
                  swap_total_bytes, swap_used_bytes, load_1, load_5, load_15
                FROM host_metrics ORDER BY hostname, ts DESC
                """)
            rows = cur.fetchall()
    return {
        "hosts": [
            {
                "hostname": r["hostname"],
                "ts": (
                    r["ts"].isoformat()
                    if hasattr(r["ts"], "isoformat")
                    else str(r["ts"])
                ),
                "mem_used_gb": round(r["mem_used_bytes"] / (1024**3), 2),
                "mem_available_gb": round(r["mem_available_bytes"] / (1024**3), 2),
                "mem_total_gb": round(r["mem_total_bytes"] / (1024**3), 2),
                "swap_used_gb": round(r["swap_used_bytes"] / (1024**3), 2),
                "load_1": round(r["load_1"], 2),
                "load_5": round(r["load_5"], 2),
                "load_15": round(r["load_15"], 2),
            }
            for r in rows
        ]
    }


@router.get("/system/host/series", summary="Host metrics time series for charts")
def get_system_host_series(
    from_ts: str = Query(..., description="ISO datetime"),
    to_ts: str = Query(..., description="ISO datetime"),
):
    """Time series of host memory (used/available) and load. For React system resources charts."""
    if not _table_exists("host_metrics"):
        return {"series": []}
    try:
        from_dt = datetime.fromisoformat(from_ts.replace("Z", "+00:00"))
        to_dt = datetime.fromisoformat(to_ts.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid from_ts or to_ts")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ts, hostname,
                  (mem_used_bytes / 1024.0 / 1024 / 1024) AS mem_used_gb,
                  (mem_available_bytes / 1024.0 / 1024 / 1024) AS mem_available_gb,
                  load_1, load_5, load_15,
                  (swap_used_bytes / 1024.0 / 1024 / 1024) AS swap_used_gb
                FROM host_metrics
                WHERE ts >= %s AND ts <= %s
                ORDER BY ts
                """,
                (from_dt, to_dt),
            )
            rows = cur.fetchall()
    # Pivot to series format: [{ time, metric, value }, ...]
    series = []
    for r in rows:
        t = r["ts"].isoformat() if hasattr(r["ts"], "isoformat") else str(r["ts"])
        host = r["hostname"] or "host"
        series.append(
            {
                "time": t,
                "metric": "mem_used_gb",
                "value": float(r["mem_used_gb"]),
                "hostname": host,
            }
        )
        series.append(
            {
                "time": t,
                "metric": "mem_available_gb",
                "value": float(r["mem_available_gb"]),
                "hostname": host,
            }
        )
        series.append(
            {
                "time": t,
                "metric": "load_1",
                "value": float(r["load_1"]),
                "hostname": host,
            }
        )
        series.append(
            {
                "time": t,
                "metric": "load_5",
                "value": float(r["load_5"]),
                "hostname": host,
            }
        )
        series.append(
            {
                "time": t,
                "metric": "load_15",
                "value": float(r["load_15"]),
                "hostname": host,
            }
        )
        series.append(
            {
                "time": t,
                "metric": "swap_used_gb",
                "value": float(r["swap_used_gb"]),
                "hostname": host,
            }
        )
    return {"series": series}


@router.get("/system/containers", summary="Latest container metrics (table)")
def get_system_containers():
    """Latest row per container from the most recent host-stats scrape only.

    Host-stats writes all running containers in one batch with the same ``ts``.
    Older names (containers since removed) keep their last row in the hypertable
    for retention/Grafana; this query matches ``docker ps`` by restricting to
    rows at ``MAX(ts)`` so removed containers disappear from the UI table.
    """
    if not _table_exists("container_metrics"):
        return {"containers": []}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                WITH latest AS (SELECT MAX(ts) AS ts FROM container_metrics)
                SELECT DISTINCT ON (c.container_name) c.container_name, c.ts,
                  c.cpu_pct, c.mem_usage_bytes, c.mem_limit_bytes, c.mem_pct, c.pids
                FROM container_metrics c
                INNER JOIN latest l ON c.ts = l.ts
                ORDER BY c.container_name, c.ts DESC
                """)
            rows = cur.fetchall()
    return {
        "containers": [
            {
                "container_name": r["container_name"],
                "ts": (
                    r["ts"].isoformat()
                    if hasattr(r["ts"], "isoformat")
                    else str(r["ts"])
                ),
                "cpu_pct": round(r["cpu_pct"], 1),
                "mem_mb": round(r["mem_usage_bytes"] / (1024 * 1024), 1),
                "mem_pct": (
                    round(r["mem_pct"], 1) if r.get("mem_pct") is not None else None
                ),
                "pids": r["pids"],
            }
            for r in rows
        ]
    }


@router.get(
    "/system/containers/series", summary="Container metrics time series for charts"
)
def get_system_containers_series(
    from_ts: str = Query(..., description="ISO datetime"),
    to_ts: str = Query(..., description="ISO datetime"),
):
    """Time series of container memory (MB) and CPU %. For React charts."""
    if not _table_exists("container_metrics"):
        return {"series": []}
    try:
        from_dt = datetime.fromisoformat(from_ts.replace("Z", "+00:00"))
        to_dt = datetime.fromisoformat(to_ts.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        raise HTTPException(400, "Invalid from_ts or to_ts")
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT ts, container_name,
                  (mem_usage_bytes / 1024.0 / 1024) AS mem_mb,
                  cpu_pct
                FROM container_metrics
                WHERE ts >= %s AND ts <= %s
                ORDER BY ts, container_name
                """,
                (from_dt, to_dt),
            )
            rows = cur.fetchall()
    series = []
    for r in rows:
        t = r["ts"].isoformat() if hasattr(r["ts"], "isoformat") else str(r["ts"])
        series.append(
            {
                "time": t,
                "metric": r["container_name"],
                "value": float(r["mem_mb"]),
                "type": "mem_mb",
            }
        )
        series.append(
            {
                "time": t,
                "metric": r["container_name"],
                "value": float(r["cpu_pct"]),
                "type": "cpu_pct",
            }
        )
    return {"series": series}


@router.get("/system/disk", summary="Latest disk usage per mount")
def get_system_disk():
    """Latest disk_metrics per host/mount. For React system resources (hard drive space)."""
    if not _table_exists("disk_metrics"):
        return {"disks": []}
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("""
                SELECT DISTINCT ON (hostname, mount_path) hostname, mount_path, ts,
                  total_bytes, used_bytes, free_bytes
                FROM disk_metrics ORDER BY hostname, mount_path, ts DESC
                """)
            rows = cur.fetchall()
    return {
        "disks": [
            {
                "hostname": r["hostname"],
                "mount_path": r["mount_path"],
                "ts": (
                    r["ts"].isoformat()
                    if hasattr(r["ts"], "isoformat")
                    else str(r["ts"])
                ),
                "used_gb": round(r["used_bytes"] / (1024**3), 2),
                "free_gb": round(r["free_bytes"] / (1024**3), 2),
                "total_gb": round(r["total_bytes"] / (1024**3), 2),
                "used_pct": (
                    round(100.0 * r["used_bytes"] / r["total_bytes"], 1)
                    if r["total_bytes"]
                    else 0
                ),
            }
            for r in rows
        ]
    }


@router.get(
    "/system/containers/{container_ref}/logs",
    summary="Docker container logs (plain text; follow=1 streams until disconnect)",
    response_class=Response,
)
def get_container_logs(
    container_ref: str,
    tail: int = Query(
        300,
        ge=1,
        le=50_000,
        description="Number of log lines to include before streaming (Docker tail)",
    ),
    follow: bool = Query(
        True,
        description="Stream new lines; if false, returns a single text/plain snapshot",
    ),
):
    """
    Requires the Docker socket on the API process (see stack docker-compose api service).
    `container_ref` is a container name (e.g. openfdd_api) or id; must match metrics names from host-stats.
    """
    ref = _validate_container_ref(container_ref)
    if not follow:
        client = _docker_client()
        if client is None:
            raise HTTPException(
                status_code=503,
                detail="Docker not available (socket not mounted or docker package missing)",
            )

        try:
            c = client.containers.get(ref)
            data = c.logs(stream=False, tail=tail, timestamps=True)
        except Exception as e:
            mod = getattr(e.__class__, "__module__", "")
            if "docker" in mod and e.__class__.__name__ == "NotFound":
                raise HTTPException(status_code=404, detail=f"Container not found: {ref}")
            if "docker" in mod and e.__class__.__name__ == "APIError":
                raise HTTPException(status_code=502, detail=str(e))
            raise HTTPException(status_code=502, detail=str(e))
        body = data if isinstance(data, bytes) else bytes(data or b"")
        return Response(content=body, media_type="text/plain; charset=utf-8")

    def gen() -> Iterator[str]:
        yield from _container_logs_text_chunks(ref, tail=tail, follow=True)

    return StreamingResponse(
        gen(),
        media_type="text/plain; charset=utf-8",
    )
