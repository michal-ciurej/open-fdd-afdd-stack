"""Niagara endpoint + scan + sync API routes (per site)."""

from __future__ import annotations

import logging
import threading
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from openfdd_stack.platform import jobs as job_store
from openfdd_stack.platform.api.schemas import JobCreateResponse
from openfdd_stack.platform.database import get_conn

router = APIRouter(prefix="/niagara", tags=["Niagara"])
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

class NiagaraEndpointUpsert(BaseModel):
    base_url: str = Field(..., description="Niagara base URL, e.g. https://station.local")
    username: str
    password: str
    ssl_verify: bool = Field(True, description="Set false for self-signed certs")
    enabled: bool = Field(True)


class NiagaraEndpointRead(BaseModel):
    site_id: UUID
    base_url: str
    username: str
    ssl_verify: bool
    enabled: bool
    last_scan_ts: Optional[str] = None
    last_sync_ts: Optional[str] = None

    @classmethod
    def from_row(cls, row: dict) -> "NiagaraEndpointRead":
        def _iso(v) -> Optional[str]:
            return v.isoformat() if hasattr(v, "isoformat") else (v or None)
        return cls(
            site_id=row["site_id"],
            base_url=row["base_url"],
            username=row["username"],
            ssl_verify=bool(row["ssl_verify"]),
            enabled=bool(row["enabled"]),
            last_scan_ts=_iso(row.get("last_scan_ts")),
            last_sync_ts=_iso(row.get("last_sync_ts")),
        )


class NiagaraSyncJobBody(BaseModel):
    time_window: str = Field(
        "lastweek",
        description="Niagara bqltime window (lastweek, last24hours, today, ...)",
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


# ---------------------------------------------------------------------------
# Endpoint CRUD
# ---------------------------------------------------------------------------

@router.get(
    "/endpoints",
    summary="List Niagara endpoints for all sites",
)
def list_endpoints():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT site_id, base_url, username, ssl_verify, enabled,
                       last_scan_ts, last_sync_ts
                FROM site_niagara_endpoints
                ORDER BY base_url
                """
            )
            rows = cur.fetchall()
    return [NiagaraEndpointRead.from_row(dict(r)).model_dump() for r in rows]


@router.get(
    "/endpoints/{site_id}",
    summary="Get the Niagara endpoint for one site",
)
def get_endpoint(site_id: str):
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT site_id, base_url, username, ssl_verify, enabled,
                       last_scan_ts, last_sync_ts
                FROM site_niagara_endpoints
                WHERE site_id = %s
                """,
                (uuid_str,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "NOT_CONFIGURED", "message": "No Niagara endpoint for this site"})
    return NiagaraEndpointRead.from_row(dict(row)).model_dump()


@router.put(
    "/endpoints/{site_id}",
    summary="Create or update the Niagara endpoint for a site",
)
def upsert_endpoint(site_id: str, body: NiagaraEndpointUpsert):
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO site_niagara_endpoints
                    (site_id, base_url, username, password, ssl_verify, enabled)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (site_id) DO UPDATE SET
                    base_url   = EXCLUDED.base_url,
                    username   = EXCLUDED.username,
                    password   = EXCLUDED.password,
                    ssl_verify = EXCLUDED.ssl_verify,
                    enabled    = EXCLUDED.enabled,
                    updated_at = now()
                RETURNING site_id, base_url, username, ssl_verify, enabled,
                          last_scan_ts, last_sync_ts
                """,
                (
                    uuid_str,
                    body.base_url,
                    body.username,
                    body.password,
                    body.ssl_verify,
                    body.enabled,
                ),
            )
            row = cur.fetchone()
        conn.commit()
    return NiagaraEndpointRead.from_row(dict(row)).model_dump()


@router.delete(
    "/endpoints/{site_id}",
    summary="Delete the Niagara endpoint for a site",
    status_code=204,
)
def delete_endpoint(site_id: str):
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "DELETE FROM site_niagara_endpoints WHERE site_id = %s",
                (uuid_str,),
            )
        conn.commit()
    return None


# ---------------------------------------------------------------------------
# Connection test
# ---------------------------------------------------------------------------

@router.post(
    "/endpoints/{site_id}/test",
    summary="Test connectivity to the site's Niagara station",
)
def test_endpoint(site_id: str):
    from openfdd_stack.platform.drivers.niagara import test_niagara_connection

    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT base_url, username, password, ssl_verify
                FROM site_niagara_endpoints
                WHERE site_id = %s
                """,
                (uuid_str,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail={"code": "NOT_CONFIGURED", "message": "No Niagara endpoint for this site"})

    result = test_niagara_connection(
        base_url=row["base_url"],
        username=row["username"],
        password=row["password"],
        ssl_verify=bool(row["ssl_verify"]),
    )
    if not result["ok"]:
        raise HTTPException(
            status_code=502,
            detail={
                "code": "NIAGARA_UNREACHABLE",
                "message": result.get("error") or f"HTTP {result.get('status_code')}",
            },
        )
    return result


# ---------------------------------------------------------------------------
# Scan (discover points) and Sync (pull history)
# ---------------------------------------------------------------------------

@router.post(
    "/endpoints/{site_id}/scan",
    response_model=JobCreateResponse,
    summary="Scan the site's Niagara station for control points",
)
def start_scan_job(site_id: str):
    logger.info("[api.niagara] POST /niagara/endpoints/%s/scan received", site_id)
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        logger.warning("[api.niagara] scan rejected: site not found site=%s", site_id)
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    job_id = job_store.create_job("niagara.scan", {"site_id": uuid_str})
    logger.info(
        "[api.niagara] scan job queued job_id=%s site_uuid=%s", job_id, uuid_str,
    )
    thread = threading.Thread(
        target=job_store.run_niagara_scan_job,
        args=(job_id, uuid_str),
        daemon=True,
    )
    thread.start()
    return JobCreateResponse(job_id=job_id, status=job_store.STATUS_QUEUED)


@router.post(
    "/endpoints/{site_id}/sync",
    response_model=JobCreateResponse,
    summary="Sync Niagara history for one site",
)
def start_sync_job(site_id: str, body: Optional[NiagaraSyncJobBody] = None):
    logger.info(
        "[api.niagara] POST /niagara/endpoints/%s/sync received window=%s",
        site_id, (body.time_window if body else "lastweek"),
    )
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        logger.warning("[api.niagara] sync rejected: site not found site=%s", site_id)
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    body = body or NiagaraSyncJobBody()
    job_id = job_store.create_job(
        "niagara.sync", {"site_id": uuid_str, "time_window": body.time_window}
    )
    logger.info(
        "[api.niagara] sync job queued job_id=%s site_uuid=%s window=%s",
        job_id, uuid_str, body.time_window,
    )
    thread = threading.Thread(
        target=job_store.run_niagara_sync_job,
        args=(job_id, uuid_str, body.time_window),
        daemon=True,
    )
    thread.start()
    return JobCreateResponse(job_id=job_id, status=job_store.STATUS_QUEUED)


# ---------------------------------------------------------------------------
# Read-only helpers
# ---------------------------------------------------------------------------

@router.get(
    "/endpoints/{site_id}/points",
    summary="List points discovered on the site's Niagara station",
)
def list_site_niagara_points(site_id: str):
    uuid_str = _resolve_site_uuid(site_id)
    if not uuid_str:
        raise HTTPException(status_code=404, detail={"code": "SITE_NOT_FOUND", "message": "Site not found"})
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.external_id, p.equipment_id, e.name AS equipment_name,
                       p.niagara_nav_ord, p.niagara_tags, p.niagara_history_path
                FROM points p
                LEFT JOIN equipment e ON e.id = p.equipment_id
                WHERE p.site_id = %s
                  AND p.niagara_nav_ord IS NOT NULL
                ORDER BY e.name, p.external_id
                """,
                (uuid_str,),
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
