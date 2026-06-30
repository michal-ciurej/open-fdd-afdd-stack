"""Trigger FDD run now - start the ACA job (Azure) or touch trigger file (local loop)."""

import logging
import os
from pathlib import Path

import requests
from fastapi import APIRouter, HTTPException

from openfdd_stack.platform.config import get_platform_settings
from openfdd_stack.platform.database import get_conn

router = APIRouter(tags=["run-fdd"])
_log = logging.getLogger(__name__)

# ARM audience for the managed-identity token. Trailing slash matches the token's aud claim.
_ARM_RESOURCE = "https://management.azure.com/"


@router.get("/run-fdd/status", summary="Last FDD run (for config UI)")
def run_fdd_status():
    """Return last FDD run from fdd_run_log for UI 'Last run' display."""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT run_ts, status, sites_processed, faults_written FROM fdd_run_log ORDER BY run_ts DESC LIMIT 1"
                )
                row = cur.fetchone()
        if not row:
            return {"last_run": None}
        return {
            "last_run": {
                "run_ts": (
                    row["run_ts"].isoformat()
                    if hasattr(row["run_ts"], "isoformat")
                    else str(row["run_ts"])
                ),
                "status": row["status"],
                "sites_processed": row["sites_processed"],
                "faults_written": row["faults_written"],
            }
        }
    except Exception:
        return {"last_run": None}


def _managed_identity_token(client_id: str | None) -> str:
    """
    Fetch an ARM access token from the Container Apps managed-identity endpoint.

    ACA injects IDENTITY_ENDPOINT + IDENTITY_HEADER once an identity is assigned to the
    app (the App Service-style MSI endpoint). For a user-assigned identity, ``client_id``
    selects which one (mi-predmain). No azure-identity dependency needed.
    """
    endpoint = os.environ.get("IDENTITY_ENDPOINT")
    header = os.environ.get("IDENTITY_HEADER")
    if not endpoint or not header:
        raise HTTPException(
            503,
            {
                "code": "NO_MANAGED_IDENTITY",
                "message": (
                    "Managed identity not available (IDENTITY_ENDPOINT unset). "
                    "Assign the user-assigned identity (mi-predmain) to predmain-api."
                ),
            },
        )
    params = {"api-version": "2019-08-01", "resource": _ARM_RESOURCE}
    if client_id:
        params["client_id"] = client_id
    try:
        r = requests.get(
            endpoint,
            params=params,
            headers={"X-IDENTITY-HEADER": header},
            timeout=10,
        )
    except requests.RequestException as e:
        raise HTTPException(502, {"code": "MI_TOKEN_ERROR", "message": str(e)})
    if r.status_code != 200:
        raise HTTPException(
            502,
            {
                "code": "MI_TOKEN_ERROR",
                "message": f"token endpoint returned {r.status_code}: {r.text[:300]}",
            },
        )
    token = (r.json() or {}).get("access_token")
    if not token:
        raise HTTPException(
            502, {"code": "MI_TOKEN_ERROR", "message": "no access_token in response"}
        )
    return token


def _start_aca_job(job_resource_id: str, api_version: str, client_id: str | None) -> dict:
    """Start one execution of the ACA Job via ARM, authenticated by managed identity."""
    token = _managed_identity_token(client_id)
    url = f"https://management.azure.com{job_resource_id}/start?api-version={api_version}"
    try:
        r = requests.post(
            url, headers={"Authorization": f"Bearer {token}"}, timeout=30
        )
    except requests.RequestException as e:
        raise HTTPException(502, {"code": "ACA_JOB_START_ERROR", "message": str(e)})
    if r.status_code not in (200, 202):
        # Surface ARM's body verbatim so RBAC problems (AuthorizationFailed: the MI
        # lacks Microsoft.App/jobs/start/action on the job) are visible to the operator.
        raise HTTPException(
            502,
            {
                "code": "ACA_JOB_START_ERROR",
                "message": f"ARM returned {r.status_code}: {r.text[:500]}",
            },
        )
    execution = None
    try:
        execution = (r.json() or {}).get("name")
    except ValueError:
        pass  # 202 with empty body is fine; execution name is best-effort
    job_name = job_resource_id.rsplit("/", 1)[-1]
    _log.info("Started ACA job %s (execution=%s)", job_name, execution)
    return {
        "status": "started",
        "mode": "aca-job",
        "job": job_name,
        "execution": execution,
    }


@router.post("/run-fdd", summary="Run FDD rules now")
def trigger_run_fdd():
    """
    Trigger an immediate FDD rule run.

    **Azure (``OFDD_FDD_JOB_RESOURCE_ID`` set):** starts one execution of the dedicated
    ACA Job (``predmain-fdd-loop``) via the app's managed identity. The job runs
    ``run_rule_loop`` in its own correctly-sized container and writes ``fdd_run_log`` on
    completion; the UI polls ``GET /run-fdd/status`` for the new row. This avoids running
    the memory-heavy pandas FDD pass in-process in the API container (which OOM-kills it).

    **Local loop (no job id):** touches the trigger file; a ``run_rule_loop --loop``
    process picks it up within 60s and resets its interval.
    """
    settings = get_platform_settings()
    job_resource_id = getattr(settings, "fdd_job_resource_id", None)
    if job_resource_id:
        return _start_aca_job(
            job_resource_id,
            getattr(settings, "fdd_job_api_version", "2024-03-01"),
            getattr(settings, "fdd_job_mi_client_id", None),
        )

    # Local/dev: touch the trigger file for the --loop poller.
    trigger_path = getattr(settings, "fdd_trigger_file", None) or "config/.run_fdd_now"
    p = Path(trigger_path)
    if not p.is_absolute():
        p = Path.cwd() / p
    p.parent.mkdir(parents=True, exist_ok=True)
    p.touch()
    return {"status": "triggered", "mode": "trigger-file", "path": str(p)}
