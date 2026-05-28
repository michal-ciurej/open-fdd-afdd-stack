#!/usr/bin/env python3
"""Nightly sync orchestrator: one-shot ACA Job entry point.

Today: runs history sync (Niagara + IQVision, "yesterday" window).
Future: additional nightly maintenance steps slot in as further function calls.

Prod deployment: ACA Job `predmain-nightly-sync` with cron `0 3 * * *`,
reusing the fdd-loop image with command override:
    ["python","-u","-m","openfdd_stack.platform.drivers.run_nightly_sync"]

Local manual run:
    docker compose exec fdd-loop python -m openfdd_stack.platform.drivers.run_nightly_sync
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent.parent))

from openfdd_stack.platform.drivers.history_sync import run_history_sync


def setup_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.DEBUG if verbose else logging.INFO,
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Nightly sync orchestrator (ACA Job entry point)"
    )
    parser.add_argument(
        "--window",
        default="yesterday",
        help="bqltime window for history sync (default: yesterday)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="Debug logging")
    args = parser.parse_args()

    setup_logging(args.verbose)
    log = logging.getLogger("open_fdd.nightly_sync")

    log.info("Nightly sync starting")
    failures = run_history_sync(time_window=args.window)
    log.info("Nightly sync complete (catastrophic failures: %d)", failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
