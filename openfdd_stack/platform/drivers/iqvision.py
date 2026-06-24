"""
IQVision driver: almost identical to the Niagara driver — same ORD-embedded BQL
scan + history shapes, same HTTP + HTML parsing. The one material difference:

  Equipment grouping:
    - Niagara: folder twice removed in the nav ORD (parent of the `points` folder).
    - IQVision: the `proxyExt.device.displayName` column (the BQL `Device` column),
      used verbatim as the equipment name.

Everything else is reused from `openfdd_stack.platform.drivers.niagara` so a
change to URL encoding, HTML parsing, or history fetching stays in one place.

Per-site credentials live in `site_iqvision_endpoints`.
"""

from __future__ import annotations

import logging
from typing import Optional
from uuid import UUID

import requests

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.drivers.niagara import (
    _build_scan_url,
    _http_get,
    _parse_bql_html_scan,
    _parse_tags,
    _store_readings,
    _upsert_equipment,
    _upsert_niagara_point,
    fetch_niagara_history,
)

logger = logging.getLogger("open_fdd.iqvision")


# ---------------------------------------------------------------------------
# DB: endpoint lookup
# ---------------------------------------------------------------------------

def _get_endpoint(endpoint_id: str) -> Optional[dict]:
    """Load one IQVision endpoint row by its id."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, site_id, name, base_url, username, password,
                       ssl_verify, enabled
                FROM site_iqvision_endpoints
                WHERE id = %s
                """,
                (endpoint_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def _list_endpoints_for_site(site_id: str, enabled_only: bool = False) -> list[dict]:
    """List IQVision endpoints for a site (UUID or name).

    Used by the API and the nightly runner to fan out across every endpoint a
    site owns. Pass enabled_only=True to skip disabled endpoints.
    """
    enabled_clause = "AND e.enabled = true" if enabled_only else ""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT e.id, e.site_id, e.name, e.base_url, e.username,
                       e.password, e.ssl_verify, e.enabled
                FROM site_iqvision_endpoints e
                JOIN sites s ON s.id = e.site_id
                WHERE (s.id::text = %s OR s.name = %s) {enabled_clause}
                ORDER BY e.name
                """,
                (site_id, site_id),
            )
            return [dict(r) for r in cur.fetchall()]


def _get_iqvision_points_for_endpoint(cur, endpoint_id: str) -> list[dict]:
    """
    Points discovered by this IQVision endpoint that have a niagara_history_path.

    Reuses the `niagara_history_path` column because the BQL history identifier
    is the same across Niagara and IQVision stations. Points scanned by either
    driver end up in the same column; ownership is distinguished by the
    iqvision_endpoint_id / niagara_endpoint_id columns.
    """
    # Diagnostic counters so we can tell "no endpoint" from "no points" from
    # "points exist but none scanned a history tag".
    cur.execute(
        "SELECT count(*) AS n FROM points WHERE iqvision_endpoint_id = %s",
        (endpoint_id,),
    )
    total = cur.fetchone()["n"]
    cur.execute(
        """
        SELECT count(*) AS n
        FROM points
        WHERE iqvision_endpoint_id = %s
          AND niagara_history_path IS NOT NULL
          AND niagara_history_path <> ''
        """,
        (endpoint_id,),
    )
    with_hist = cur.fetchone()["n"]
    logger.info(
        "[iqvision.select] endpoint=%s points_total=%d points_with_history_path=%d",
        endpoint_id, total, with_hist,
    )
    cur.execute(
        """
        SELECT id, site_id, external_id, niagara_history_path
        FROM points
        WHERE iqvision_endpoint_id = %s
          AND niagara_history_path IS NOT NULL
          AND niagara_history_path <> ''
        ORDER BY niagara_history_path
        """,
        (endpoint_id,),
    )
    return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Connection test
# ---------------------------------------------------------------------------

def test_iqvision_connection(
    base_url: str,
    username: str,
    password: str,
    ssl_verify: bool = True,
    timeout: int = 10,
) -> dict:
    """Ping the station scan URL and report whether auth + routing are OK."""
    url = _build_scan_url(base_url)
    try:
        resp = _http_get(url, username, password, ssl_verify, timeout)
        ok = resp.status_code not in (401, 403, 500, 502, 503, 504)
        return {"ok": ok, "status_code": resp.status_code, "error": None}
    except requests.exceptions.SSLError as exc:
        return {"ok": False, "status_code": None, "error": f"SSL error: {exc}"}
    except requests.exceptions.ConnectionError as exc:
        return {"ok": False, "status_code": None, "error": f"Connection error: {exc}"}
    except requests.exceptions.Timeout:
        return {"ok": False, "status_code": None, "error": f"Timeout after {timeout}s"}
    except Exception as exc:
        return {"ok": False, "status_code": None, "error": str(exc)}


# ---------------------------------------------------------------------------
# Station scan — equipment grouping differs from Niagara
# ---------------------------------------------------------------------------

def scan_iqvision_station(endpoint_id: str) -> dict:
    """
    Run the ControlPoint BQL query against one IQVision endpoint, parse the HTML
    response, and upsert the equipment + points owned by that endpoint.

    Grouping:
      equipment = the BQL `Device` column (proxyExt.device.displayName) as-is.
      Points that scan with an empty Device column are skipped — without that
      tag we have no unique equipment key.

    Returns a summary dict for UI / job results.
    """
    endpoint = _get_endpoint(endpoint_id)
    if not endpoint:
        return {
            "ok": False,
            "error": f"No IQVision endpoint {endpoint_id}",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }
    if not endpoint.get("enabled", True):
        return {
            "ok": False,
            "error": "IQVision endpoint is disabled",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }

    site_id = str(endpoint["site_id"])
    url = _build_scan_url(endpoint["base_url"])
    try:
        resp = _http_get(
            url,
            endpoint["username"],
            endpoint["password"],
            bool(endpoint["ssl_verify"]),
            timeout=60,
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as exc:
        logger.exception(
            "IQVision scan HTTP error for endpoint %s (site %s)", endpoint_id, site_id
        )
        return {
            "ok": False,
            "error": f"HTTP error: {exc}",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }

    rows = _parse_bql_html_scan(resp.text)
    logger.info(
        "IQVision scan: endpoint=%s site=%s parsed_rows=%d",
        endpoint_id, site_id, len(rows),
    )

    equipment_ids: dict[str, str] = {}
    points_upserted = 0
    skipped_no_device = 0

    with get_conn() as conn:
        with conn.cursor() as cur:
            for r in rows:
                nav_ord = r["point_location"]
                point_name = r["point"]
                # IQVision-specific grouping: the Device column is the equipment key.
                equip_name = (r["device"] or "").strip()
                if not equip_name:
                    skipped_no_device += 1
                    continue

                tags = _parse_tags(r["tags"])
                history_tag = tags.get("n:history")
                history_path = history_tag if isinstance(history_tag, str) else None

                external_id = nav_ord or f"{equip_name}/{point_name}"

                equip_id = equipment_ids.get(equip_name)
                if not equip_id:
                    equip_id = _upsert_equipment(cur, site_id, equip_name)
                    equipment_ids[equip_name] = equip_id

                _upsert_niagara_point(
                    cur,
                    site_id=site_id,
                    equipment_id=equip_id,
                    external_id=external_id,
                    niagara_nav_ord=nav_ord,
                    niagara_tags=tags,
                    niagara_history_path=history_path,
                    description=point_name or None,
                    object_name=point_name or None,
                    iqvision_endpoint_id=endpoint["id"],
                )
                points_upserted += 1

            cur.execute(
                """
                UPDATE site_iqvision_endpoints
                SET last_scan_ts = now(), updated_at = now()
                WHERE id = %s
                """,
                (endpoint_id,),
            )
        conn.commit()

    if skipped_no_device:
        logger.warning(
            "IQVision scan skipped %d rows with empty Device column (no equipment key)",
            skipped_no_device,
        )

    return {
        "ok": True,
        "rows_seen": len(rows),
        "points_upserted": points_upserted,
        "equipment_upserted": len(equipment_ids),
        "skipped_no_device": skipped_no_device,
        "error": None,
    }


# ---------------------------------------------------------------------------
# Per-endpoint history sync
# ---------------------------------------------------------------------------

def run_iqvision_sync(
    endpoint_id: str,
    time_window: str = "lastweek",
) -> dict:
    """
    Sync historical data from one IQVision endpoint for every point it
    discovered that carries a niagara_history_path.

    Uses a bqltime window (default 'lastweek') — same shape as Niagara.
    """
    logger.info(
        "[iqvision.sync] invoked endpoint=%s window=%s", endpoint_id, time_window,
    )
    endpoint = _get_endpoint(endpoint_id)
    if not endpoint:
        logger.warning(
            "[iqvision.sync] EARLY EXIT: no site_iqvision_endpoints row id=%s "
            "(was the endpoint deleted?)",
            endpoint_id,
        )
        return {
            "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
            "errors": [f"No IQVision endpoint {endpoint_id}"],
        }
    if not endpoint.get("enabled", True):
        logger.warning(
            "[iqvision.sync] EARLY EXIT: endpoint disabled id=%s", endpoint_id,
        )
        return {
            "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
            "errors": ["IQVision endpoint is disabled"],
        }

    site_uuid = str(endpoint["site_id"])
    base_url = endpoint["base_url"]
    username = endpoint["username"]
    password = endpoint["password"]
    ssl_verify = bool(endpoint["ssl_verify"])

    points_ok = 0
    total_rows = 0
    errors: list[str] = []

    with get_conn() as conn:
        # Fail fast on lock waits / runaway queries instead of hanging forever.
        # Keeps a stuck sync from piling up indefinitely behind a Timescale
        # chunk-creation lock (e.g. while the BACnet scraper is writing).
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = '60s'")
            cur.execute("SET lock_timeout = '10s'")
        conn.commit()

        with conn.cursor() as cur:
            points = _get_iqvision_points_for_endpoint(cur, endpoint_id)

        if not points:
            logger.warning(
                "[iqvision.sync] EARLY EXIT: no points with niagara_history_path "
                "for endpoint=%s (run the IQVision scan first so history "
                "tags get populated)",
                endpoint_id,
            )
            return {
                "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
                "errors": [],
            }

        logger.info(
            "[iqvision.sync] start endpoint=%s site=%s base_url=%s points=%d window=%s",
            endpoint_id, site_uuid, base_url, len(points), time_window,
        )

        # Commit per-point so a hang on one point never strands the earlier
        # ones, and so Timescale locks are released between inserts.
        for idx, pt in enumerate(points, start=1):
            hp = pt["niagara_history_path"]
            logger.info(
                "[iqvision.sync] point %d/%d id=%s external_id=%s history=%s",
                idx, len(points), pt["id"], pt.get("external_id"), hp,
            )
            try:
                records = fetch_niagara_history(
                    history_path=hp,
                    base_url=base_url,
                    username=username,
                    password=password,
                    time_window=time_window,
                    ssl_verify=ssl_verify,
                )
                logger.info(
                    "[iqvision.sync] point %d/%d fetched=%d records history=%s",
                    idx, len(points), len(records), hp,
                )
                with conn.cursor() as cur:
                    inserted = _store_readings(pt["id"], site_uuid, records, cur)
                conn.commit()
                total_rows += inserted
                points_ok += 1
            except Exception as exc:
                conn.rollback()
                errors.append(f"{hp}: {exc}")
                logger.exception(
                    "[iqvision.sync] point failed history=%s err=%s", hp, exc,
                )

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE site_iqvision_endpoints
                SET last_sync_ts = now(), updated_at = now()
                WHERE id = %s
                """,
                (endpoint_id,),
            )
        conn.commit()

    logger.info(
        "[iqvision.sync] done endpoint=%s site=%s attempted=%d ok=%d rows=%d errors=%d",
        endpoint_id, site_uuid, len(points), points_ok, total_rows, len(errors),
    )
    return {
        "points_attempted": len(points),
        "points_ok": points_ok,
        "rows_inserted": total_rows,
        "errors": errors,
    }
