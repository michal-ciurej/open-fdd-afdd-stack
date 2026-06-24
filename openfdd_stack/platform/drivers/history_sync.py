"""History sync step for the nightly orchestrator.

Fans out across every enabled driver endpoint (site_niagara_endpoints,
site_iqvision_endpoints) and calls each driver's run_*_sync(endpoint_id,
time_window). A site may own several endpoints of the same type (e.g. multiple
Niagara controllers); each is synced independently. Inserts are idempotent on
(point_id, ts), so overlapping windows are safe.

Invoked from run_nightly_sync.py.
"""

from __future__ import annotations

import logging

from openfdd_stack.platform.database import get_conn

log = logging.getLogger("open_fdd.history_sync")


def _list_enabled_endpoints(table: str) -> list[dict]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT id::text AS id, site_id::text AS site_id, name "
                f"FROM {table} WHERE enabled = true ORDER BY site_id, name"
            )
            return [dict(r) for r in cur.fetchall()]


def run_history_sync(time_window: str = "yesterday") -> int:
    """Pull `time_window` from every enabled driver endpoint.

    Returns the count of catastrophic per-endpoint failures (uncaught
    exceptions). Per-point errors raised by the driver are logged but counted
    in result["errors"], not here.
    """
    from openfdd_stack.platform.drivers.iqvision import run_iqvision_sync
    from openfdd_stack.platform.drivers.niagara import run_niagara_sync

    drivers = [
        ("Niagara", "site_niagara_endpoints", run_niagara_sync),
        ("IQVision", "site_iqvision_endpoints", run_iqvision_sync),
    ]

    failures = 0
    for name, table, sync_fn in drivers:
        try:
            endpoints = _list_enabled_endpoints(table)
        except Exception:
            log.exception("%s: failed to list enabled endpoints", name)
            failures += 1
            continue

        if not endpoints:
            log.info("%s: no enabled endpoints, skipping", name)
            continue

        for ep in endpoints:
            endpoint_id = ep["id"]
            label = f"{ep.get('name')}@{ep['site_id']}"
            try:
                result = sync_fn(endpoint_id=endpoint_id, time_window=time_window)
                log.info(
                    "%s sync endpoint=%s (%s) window=%s: attempted=%d ok=%d rows=%d errors=%d",
                    name,
                    endpoint_id,
                    label,
                    time_window,
                    result["points_attempted"],
                    result["points_ok"],
                    result["rows_inserted"],
                    len(result["errors"]),
                )
                for err in result["errors"]:
                    log.warning("%s endpoint=%s point error: %s", name, endpoint_id, err)
            except Exception:
                log.exception("%s: catastrophic failure for endpoint=%s", name, endpoint_id)
                failures += 1

    return failures
