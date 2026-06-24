"""IQVision endpoint + scan + sync API routes.

Mirrors the Niagara routes one-for-one; only the underlying driver + endpoint
table differ. The scan groups points by the BQL Device column instead of the
nav ORD folder twice removed. A site may own several IQVision endpoints; each
is addressed by its own id and scanned / synced independently.
"""

from __future__ import annotations

import logging
import threading
from typing import Optional
from uuid import UUID

import psycopg2
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from openfdd_stack.platform import jobs as job_store
from openfdd_stack.platform.api.schemas import JobCreateResponse
from openfdd_stack.platform.database import get_conn

router = APIRouter(prefix="/iqvision", tags=["IQVision"])
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class IQVisionEndpointCreate(BaseModel):
    name: str = Field(..., description="Label for this endpoint, unique within the site")
    base_url: str = Field(..., description="IQVision base URL, e.g. https://iqvision.local")
    username: str
    password: str
    ssl_verify: bool = Field(True, description="Set false for self-signed certs")
    enabled: bool = Field(True)


class IQVisionEndpointUpdate(BaseModel):
    """Partial update; omitted fields (and a blank password) keep the current value."""

    name: Optional[str] = None
    base_url: Optional[str] = None
    username: Optional[str] = None
    password: Optional[str] = None
    ssl_verify: Optional[bool] = None
    enabled: Optional[bool] = None


class IQVisionEndpointRead(BaseModel):
    id: UUID
    site_id: UUID
    name: str
    base_url: str
    username: str
    ssl_verify: bool
    enabled: bool
    last_scan_ts: Optional[str] = None
    last_sync_ts: Optional[str] = None

    @classmethod
    def from_row(cls, row: dict) -> "IQVisionEndpointRead":
        def _iso(v) -> Optional[str]:
            return v.isoformat() if hasattr(v, "isoformat") else (v or None)
        return cls(
            id=row["id"],
            site_id=row["site_id"],
            name=row["name"],
            base_url=row["base_url"],
            username=row["username"],
            ssl_verify=bool(row["ssl_verify"]),
            enabled=bool(row["enabled"]),
            last_scan_ts=_iso(row.get("last_scan_ts")),
            last_sync_ts=_iso(row.get("last_sync_ts")),
        )


class IQVisionSyncJobBody(BaseModel):
    time_window: str = Field(
        "lastweek",
        description="bqltime window (lastweek, last24hours, today, ...)",
    )


_READ_COLS = (
    "id, site_id, name, base_url, username, ssl_verify, enabled, "
    "last_scan_ts, last_sync_ts"
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _resolve_site_uuid(site_id: str) -> Optional[str]:
    """Resolve a site identifier (UUID or name) to its UUID."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT id FROM sites WHERE id::text = %s OR name = %s",
                (site_id, site_id),
            )
            row = cur.fetchone()
    return str(row["id"]) if row else None


def _get_endpoint_row(endpoint_id: str) -> Optional[dict]:
    """Load one IQVision endpoint row by id (incl. password for test)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_READ_COLS}, password FROM site_iqvision_endpoints WHERE id = %s",
                (endpoint_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def _endpoint_404() -> HTTPException:
    return HTTPException(
        status_code=404,
        detail={"code": "NOT_FOUND", "message": "IQVision endpoint not found"},
    )


# ---------------------------------------------------------------------------
# Endpoint CRUD
# ---------------------------------------------------------------------------

@router.get("/endpoints", summary="List IQVision endpoints across all sites")
def list_all_endpoints():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_READ_COLS} FROM site_iqvision_endpoints ORDER BY site_id, name"
            )
            rows = cur.fetchall()
    return [IQVisionEndpointRead.from_row(dict(r)).model_dump() for r in rows]


@router.get(
    "/sites/{site_id}/endpoints",
    summary="List the IQVision endpoints configured for one site",
)
def list_site_endpoints(site_id: str):
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_READ_COLS} FROM site_iqvision_endpoints WHERE site_id = %s ORDER BY name",
                (uuid_str,),
            )
            rows = cur.fetchall()
    return [IQVisionEndpointRead.from_row(dict(r)).model_dump() for r in rows]


@router.post(
    "/sites/{site_id}/endpoints",
    summary="Add an IQVision endpoint to a site",
    status_code=201,
)
def create_endpoint(site_id: str, body: IQVisionEndpointCreate):
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    f"""
                    INSERT INTO site_iqvision_endpoints
                        (site_id, name, base_url, username, password, ssl_verify, enabled)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    RETURNING {_READ_COLS}
                    """,
                    (
                        uuid_str,
                        body.name,
                        body.base_url,
                        body.username,
                        body.password,
                        body.ssl_verify,
                        body.enabled,
                    ),
                )
                row = cur.fetchone()
            except psycopg2.errors.UniqueViolation:
                conn.rollback()
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "DUPLICATE_NAME",
                        "message": f"An endpoint named '{body.name}' already exists for this site",
                    },
                )
        conn.commit()
    return IQVisionEndpointRead.from_row(dict(row)).model_dump()


@router.get("/endpoints/{endpoint_id}", summary="Get one IQVision endpoint")
def get_endpoint(endpoint_id: str):
    row = _get_endpoint_row(endpoint_id)
    if not row:
        raise _endpoint_404()
    return IQVisionEndpointRead.from_row(row).model_dump()


@router.put("/endpoints/{endpoint_id}", summary="Update one IQVision endpoint")
def update_endpoint(endpoint_id: str, body: IQVisionEndpointUpdate):
    # Blank password means "keep current"; COALESCE leaves omitted fields as-is.
    password = body.password or None
    with get_conn() as conn:
        with conn.cursor() as cur:
            try:
                cur.execute(
                    f"""
                    UPDATE site_iqvision_endpoints SET
                        name       = COALESCE(%s, name),
                        base_url   = COALESCE(%s, base_url),
                        username   = COALESCE(%s, username),
                        password   = COALESCE(%s, password),
                        ssl_verify = COALESCE(%s, ssl_verify),
                        enabled    = COALESCE(%s, enabled),
                        updated_at = now()
                    WHERE id = %s
                    RETURNING {_READ_COLS}
                    """,
                    (
                        body.name,
                        body.base_url,
                        body.username,
                        password,
                        body.ssl_verify,
                        body.enabled,
                        endpoint_id,
                    ),
                )
                row = cur.fetchone()
            except psycopg2.errors.UniqueViolation:
                conn.rollback()
                raise HTTPException(
                    status_code=409,
                    detail={
                        "code": "DUPLICATE_NAME",
                        "message": "Another endpoint on this site already uses that name",
                    },
                )
        conn.commit()
    if not row:
        raise _endpoint_404()
    return IQVisionEndpointRead.from_row(dict(row)).model_dump()


@router.delete(
    "/endpoints/{endpoint_id}",
    summary="Delete one IQVision endpoint (and the points it discovered)",
    status_code=204,
)
def delete_endpoint(endpoint_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM site_iqvision_endpoints WHERE id = %s",
                (endpoint_id,),
            )
            deleted = cur.rowcount
        conn.commit()
    if not deleted:
        raise _endpoint_404()
    return None


# ---------------------------------------------------------------------------
# Connection test
# ---------------------------------------------------------------------------

@router.post(
    "/endpoints/{endpoint_id}/test",
    summary="Test connectivity to an IQVision station",
)
def test_endpoint(endpoint_id: str):
    from openfdd_stack.platform.drivers.iqvision import test_iqvision_connection

    row = _get_endpoint_row(endpoint_id)
    if not row:
        raise _endpoint_404()

    result = test_iqvision_connection(
        base_url=row["base_url"],
        username=row["username"],
        password=row["password"],
        ssl_verify=bool(row["ssl_verify"]),
    )
    if not result["ok"]:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "IQVISION_UNREACHABLE",
                "message": result.get("error") or f"HTTP {result.get('status_code')}",
            },
        )
    return result


# ---------------------------------------------------------------------------
# Scan (discover points) and Sync (pull history)
# ---------------------------------------------------------------------------

@router.post(
    "/endpoints/{endpoint_id}/scan",
    response_model=JobCreateResponse,
    summary="Scan an IQVision station for control points",
)
def start_scan_job(endpoint_id: str):
    logger.info("[api.iqvision] POST /iqvision/endpoints/%s/scan received", endpoint_id)
    row = _get_endpoint_row(endpoint_id)
    if not row:
        logger.warning("[api.iqvision] scan rejected: endpoint not found id=%s", endpoint_id)
        raise _endpoint_404()
    site_uuid = str(row["site_id"])
    job_id = job_store.create_job(
        "iqvision.scan", {"endpoint_id": endpoint_id, "site_id": site_uuid}
    )
    logger.info(
        "[api.iqvision] scan job queued job_id=%s endpoint=%s site=%s",
        job_id, endpoint_id, site_uuid,
    )
    thread = threading.Thread(
        target=job_store.run_iqvision_scan_job,
        args=(job_id, endpoint_id, site_uuid),
        daemon=True,
    )
    thread.start()
    return JobCreateResponse(job_id=job_id, status=job_store.STATUS_QUEUED)


@router.post(
    "/endpoints/{endpoint_id}/sync",
    response_model=JobCreateResponse,
    summary="Sync IQVision history for one endpoint",
)
def start_sync_job(endpoint_id: str, body: Optional[IQVisionSyncJobBody] = None):
    logger.info(
        "[api.iqvision] POST /iqvision/endpoints/%s/sync received window=%s",
        endpoint_id, (body.time_window if body else "lastweek"),
    )
    row = _get_endpoint_row(endpoint_id)
    if not row:
        logger.warning("[api.iqvision] sync rejected: endpoint not found id=%s", endpoint_id)
        raise _endpoint_404()
    site_uuid = str(row["site_id"])
    body = body or IQVisionSyncJobBody()
    job_id = job_store.create_job(
        "iqvision.sync",
        {"endpoint_id": endpoint_id, "site_id": site_uuid, "time_window": body.time_window},
    )
    logger.info(
        "[api.iqvision] sync job queued job_id=%s endpoint=%s site=%s window=%s",
        job_id, endpoint_id, site_uuid, body.time_window,
    )
    thread = threading.Thread(
        target=job_store.run_iqvision_sync_job,
        args=(job_id, endpoint_id, site_uuid, body.time_window),
        daemon=True,
    )
    thread.start()
    return JobCreateResponse(job_id=job_id, status=job_store.STATUS_QUEUED)


# ---------------------------------------------------------------------------
# Read-only helpers
# ---------------------------------------------------------------------------

@router.get(
    "/endpoints/{endpoint_id}/points",
    summary="List points discovered by one IQVision endpoint",
)
def list_endpoint_points(endpoint_id: str):
    row = _get_endpoint_row(endpoint_id)
    if not row:
        raise _endpoint_404()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.external_id, p.equipment_id, e.name AS equipment_name,
                       p.niagara_nav_ord, p.niagara_tags, p.niagara_history_path
                FROM points p
                LEFT JOIN equipment e ON e.id = p.equipment_id
                WHERE p.iqvision_endpoint_id = %s
                ORDER BY e.name, p.external_id
                """,
                (endpoint_id,),
            )
            rows = cur.fetchall()
    return {
        "count": len(rows),
        "points": [
            {
                "id": str(r["id"]),
                "external_id": r["external_id"],
                "equipment_id": str(r["equipment_id"]) if r["equipment_id"] else None,
                "equipment_name": r["equipment_name"],
                "niagara_nav_ord": r["niagara_nav_ord"],
                "niagara_tags": r["niagara_tags"],
                "niagara_history_path": r["niagara_history_path"],
            }
            for r in rows
        ],
    }
