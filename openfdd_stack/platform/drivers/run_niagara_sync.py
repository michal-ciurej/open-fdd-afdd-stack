#!/usr/bin/env python3
"""
Run Niagara history sync: once or on a fixed interval → TimescaleDB.

Iterates over every site that has a Niagara endpoint configured in
`site_niagara_endpoints` and pulls the configured bqltime window for each
point on that site with a niagara_history_path.

Can be run standalone (one-shot) or as a Docker service with --loop.

Usage:
  python run_niagara_sync.py                     # one-shot, all sites
  python run_niagara_sync.py --site <uuid|name>  # one-shot, one site
  python run_niagara_sync.py --loop              # on interval (daily default)
  python run_niagara_sync.py --window last24hours
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.drivers.niagara import run_niagara_sync


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def _list_enabled_sites() -> list[str]:
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT site_id::text AS site_id
                FROM site_niagara_endpoints
                WHERE enabled = true
                """
            )
            return [r["site_id"] for r in cur.fetchall()]


def main() -> int:
    parser = argparse.ArgumentParser(description="Niagara history sync → TimescaleDB")
    parser.add_argument("--loop", action="store_true", help="Run on a fixed interval")
    parser.add_argument(
        "--site", default=None, help="Limit to one site (UUID or name)"
    )
    parser.add_argument(
        "--window",
        default="lastweek",
        help="Niagara bqltime window (e.g. lastweek, last24hours, today)",
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
        sites = [args.site] if args.site else _list_enabled_sites()
        if not sites:
            log.info("No Niagara endpoints enabled; nothing to sync.")
        else:
            for site in sites:
                try:
                    result = run_niagara_sync(site_id=site, time_window=args.window)
                    log.info(
                        "Niagara sync site=%s window=%s: attempted=%d ok=%d rows=%d errors=%d",
                        site,
                        args.window,
                        result["points_attempted"],
                        result["points_ok"],
                        result["rows_inserted"],
                        len(result["errors"]),
                    )
                    for err in result["errors"]:
                        log.warning("Sync error: %s", err)
                except Exception as exc:
                    log.exception("Niagara sync failed for site %s: %s", site, exc)
                    if not args.loop:
                        return 1

        if not args.loop:
            break

        log.info("Sleeping %d min until next sync.", args.interval_min)
        time.sleep(args.interval_min * 60)

    return 0


if __name__ == "__main__":
    sys.exit(main())
