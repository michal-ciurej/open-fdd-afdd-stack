"""History sync step for the nightly orchestrator.

Fans out across enabled driver endpoints (site_niagara_endpoints,
site_iqvision_endpoints) and calls each driver's run_*_sync(site_id, time_window).
Inserts are idempotent on (point_id, ts), so overlapping windows are safe.

Invoked from run_nightly_sync.py.
"""

from __future__ import annotations

import logging

from openfdd_stack.platform.database import get_conn

log = logging.getLogger("open_fdd.history_sync")


def _list_enabled_sites(table: str) -> list[str]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT site_id::text AS site_id FROM {table} WHERE enabled = true"
            )
            return [r["site_id"] for r in cur.fetchall()]


def run_history_sync(time_window: str = "yesterday") -> int:
    """Pull `time_window` from every enabled driver endpoint.

    Returns the count of catastrophic per-site failures (uncaught exceptions).
    Per-point errors raised by the driver are logged but counted in
    result["errors"], not here.
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
            sites = _list_enabled_sites(table)
        except Exception:
            log.exception("%s: failed to list enabled sites", name)
            failures += 1
            continue

        if not sites:
            log.info("%s: no enabled endpoints, skipping", name)
            continue

        for site in sites:
            try:
                result = sync_fn(site_id=site, time_window=time_window)
                log.info(
                    "%s sync site=%s window=%s: attempted=%d ok=%d rows=%d errors=%d",
                    name,
                    site,
                    time_window,
                    result["points_attempted"],
                    result["points_ok"],
                    result["rows_inserted"],
                    len(result["errors"]),
                )
                for err in result["errors"]:
                    log.warning("%s site=%s point error: %s", name, site, err)
            except Exception:
                log.exception("%s: catastrophic failure for site=%s", name, site)
                failures += 1

    return failures
