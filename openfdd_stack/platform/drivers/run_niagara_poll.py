#!/usr/bin/env python3
"""
Run Niagara live-value polling: per-endpoint, per-equipment-folder BQL scans.

Iterates every Niagara endpoint that has `poll_enabled=true`, and for each
groups its polling points by their `niagara_nav_ord` folder. One BQL request
per folder, sequential, with the endpoint's `poll_equipment_delay_ms` between
requests (falling back to OFDD_NIAGARA_POLL_EQUIPMENT_DELAY_MS when null).

Usage:
    python -m openfdd_stack.platform.drivers.run_niagara_poll             # one-shot
    python -m openfdd_stack.platform.drivers.run_niagara_poll --loop      # continuous (dev)

In cloud (ACA Container Apps Job), leave --loop off — cron drives cadence.

Env:
    OFDD_NIAGARA_POLL_ENABLED             global kill-switch (default false)
    OFDD_NIAGARA_POLL_INTERVAL_MIN        --loop interval when running continuously (default 15)
    OFDD_NIAGARA_POLL_EQUIPMENT_DELAY_MS  default per-endpoint delay (default 200)
    OFDD_NIAGARA_POLL_REQUEST_TIMEOUT_SEC per-request timeout (default 30)

Per-endpoint controls live in `site_niagara_endpoints`:
    poll_enabled              (bool, required=true to be included)
    poll_equipment_delay_ms   (int, nullable → falls back to env default)
"""

from __future__ import annotations

import argparse
import logging
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from openfdd_stack.platform.config import get_platform_settings
from openfdd_stack.platform.drivers.niagara import (
    list_polling_endpoints,
    poll_niagara_endpoint,
)


def _setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )


def _run_once(settings) -> dict:
    """One full pass over all poll-enabled Niagara endpoints."""
    log = logging.getLogger("niagara.poll")
    if not settings.niagara_poll_enabled:
        log.info("OFDD_NIAGARA_POLL_ENABLED=false — skipping cycle")
        return {"skipped": True, "reason": "global kill-switch"}

    endpoints = list_polling_endpoints()
    log.info("niagara.poll: cycle start, %d endpoints", len(endpoints))
    total_rows = 0
    total_seen = 0
    total_unmatched = 0
    started = time.monotonic()

    for ep in endpoints:
        try:
            summary = poll_niagara_endpoint(
                endpoint_id=str(ep["id"]),
                default_delay_ms=int(settings.niagara_poll_equipment_delay_ms),
                request_timeout_sec=int(settings.niagara_poll_request_timeout_sec),
            )
            log.info(
                "niagara.poll: endpoint=%s summary=%s",
                ep.get("name") or ep.get("id"),
                {k: summary.get(k) for k in ("folders", "rows_seen", "rows_inserted", "rows_unmatched", "duration_ms")},
            )
            total_rows += int(summary.get("rows_inserted") or 0)
            total_seen += int(summary.get("rows_seen") or 0)
            total_unmatched += int(summary.get("rows_unmatched") or 0)
        except Exception:
            log.exception("niagara.poll: endpoint %s failed", ep.get("id"))
            # continue to next endpoint

    duration_ms = int((time.monotonic() - started) * 1000)
    log.info(
        "niagara.poll: cycle done in %d ms — rows_inserted=%d rows_seen=%d rows_unmatched=%d",
        duration_ms, total_rows, total_seen, total_unmatched,
    )
    return {
        "endpoints": len(endpoints),
        "rows_inserted": total_rows,
        "rows_seen": total_seen,
        "rows_unmatched": total_unmatched,
        "duration_ms": duration_ms,
    }


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Niagara live-value polling (per-equipment BQL scans, sequential)"
    )
    parser.add_argument(
        "--loop", action="store_true",
        help="Run continuously with OFDD_NIAGARA_POLL_INTERVAL_MIN between cycles. "
             "Omit for one-shot mode (ACA Job).",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="DEBUG-level logs")
    args = parser.parse_args()

    _setup_logging(args.verbose)
    settings = get_platform_settings()
    log = logging.getLogger("niagara.poll")

    if not args.loop:
        result = _run_once(settings)
        log.info("niagara.poll: one-shot result=%s", result)
        return 0

    interval_min = int(settings.niagara_poll_interval_min)
    sleep_sec = max(60, interval_min * 60)
    log.info("niagara.poll: loop mode, interval=%d min (sleep=%d s)", interval_min, sleep_sec)
    while True:
        try:
            _run_once(settings)
        except KeyboardInterrupt:
            log.info("niagara.poll: interrupted, exiting")
            return 0
        except Exception:
            log.exception("niagara.poll: cycle failed (loop continues)")
        time.sleep(sleep_sec)


if __name__ == "__main__":
    sys.exit(main())
