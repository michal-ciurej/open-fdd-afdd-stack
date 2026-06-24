#!/usr/bin/env python3
"""
Run Niagara history sync: once or on a fixed interval → TimescaleDB.

Iterates over every enabled Niagara endpoint configured in
`site_niagara_endpoints` and pulls the configured bqltime window for each
point that endpoint discovered with a niagara_history_path. A site may own
several endpoints (e.g. multiple controllers); each is synced independently.

Can be run standalone (one-shot) or as a Docker service with --loop.

Usage:
  python run_niagara_sync.py                       # one-shot, all endpoints
  python run_niagara_sync.py --site <uuid|name>    # one-shot, every endpoint on a site
  python run_niagara_sync.py --endpoint <uuid>     # one-shot, one endpoint
  python run_niagara_sync.py --loop                # on interval (daily default)
  python run_niagara_sync.py --window last24hours
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.drivers.niagara import run_niagara_sync


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def _list_enabled_endpoint_ids(site: Optional[str] = None) -> list[str]:
    """Enabled Niagara endpoint ids, optionally limited to one site (UUID or name)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            if site:
                cur.execute(
                    """
                    SELECT e.id::text AS id
                    FROM site_niagara_endpoints e
                    JOIN sites s ON s.id = e.site_id
                    WHERE e.enabled = true AND (s.id::text = %s OR s.name = %s)
                    ORDER BY e.name
                    """,
                    (site, site),
                )
            else:
                cur.execute(
                    """
                    SELECT id::text AS id
                    FROM site_niagara_endpoints
                    WHERE enabled = true
                    ORDER BY site_id, name
                    """
                )
            return [r["id"] for r in cur.fetchall()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Niagara history sync → TimescaleDB")
    parser.add_argument("--loop", action="store_true", help="Run on a fixed interval")
    parser.add_argument(
        "--site", default=None, help="Limit to every endpoint on one site (UUID or name)"
    )
    parser.add_argument(
        "--endpoint", default=None, help="Limit to one Niagara endpoint (UUID)"
    )
    parser.add_argument(
        "--window",
        default="lastweek",
        help="Niagara bqltime window: today, yesterday, lastweek, thisweek, "
        "weektodate, lastmonth, thismonth (case-insensitive)",
    )
    parser.add_argument(
        "--interval-min",
        type=int,
        default=1440,
        help="Minutes between sync runs when --loop is set (default 1440 = daily)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    setup_logging(args.verbose)
    log = logging.getLogger("open_fdd.niagara.runner")

    while True:
        if args.endpoint:
            endpoint_ids = [args.endpoint]
        else:
            endpoint_ids = _list_enabled_endpoint_ids(args.site)
        if not endpoint_ids:
            log.info("No Niagara endpoints enabled; nothing to sync.")
        else:
            for endpoint_id in endpoint_ids:
                try:
                    result = run_niagara_sync(
                        endpoint_id=endpoint_id, time_window=args.window
                    )
                    log.info(
                        "Niagara sync endpoint=%s window=%s: attempted=%d ok=%d rows=%d errors=%d",
                        endpoint_id,
                        args.window,
                        result["points_attempted"],
                        result["points_ok"],
                        result["rows_inserted"],
                        len(result["errors"]),
                    )
                    for err in result["errors"]:
                        log.warning("Sync error: %s", err)
                except Exception as exc:
                    log.exception(
                        "Niagara sync failed for endpoint %s: %s", endpoint_id, exc
                    )
                    if not args.loop:
                        return 1

        if not args.loop:
            break

        log.info("Sleeping %d min until next sync.", args.interval_min)
        time.sleep(args.interval_min * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
