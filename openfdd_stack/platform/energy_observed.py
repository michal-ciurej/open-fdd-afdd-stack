"""
Observed-channel helpers for the energy opportunity calculator.

Phase 3 wiring: turns ``fault_events`` and ``fault_results`` into the
``observed_hours`` and ``observed_evidence`` arguments that
``energy_calc_resolver.compute_opportunity_result`` already accepts.

Two helpers, both pure (no caching) — call from the recompute path.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from openfdd_stack.platform.database import get_conn

logger = logging.getLogger(__name__)


def trailing_fault_hours(
    equipment_id: str,
    fault_id: str,
    days: int = 365,
) -> float:
    """Sum ``fault_events.duration_seconds`` for ``(equipment_id, fault_id)`` over
    the trailing window, converted to hours. Open-ended events (no ``end_ts``)
    count from their ``start_ts`` to ``now()``.

    Returns 0.0 when no rows match — callers can treat that as "no observed
    fault hours yet, fall back to profile or spec default".
    """
    sql = """
        SELECT COALESCE(
            SUM(
                CASE
                    WHEN end_ts IS NOT NULL
                        THEN EXTRACT(EPOCH FROM (end_ts - start_ts))
                    ELSE EXTRACT(EPOCH FROM (now() - start_ts))
                END
            ),
            0
        ) AS seconds
        FROM fault_events
        WHERE equipment_id = %s
          AND fault_id = %s
          AND start_ts >= now() - (%s::int * INTERVAL '1 day')
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (equipment_id, fault_id, days))
            row = cur.fetchone()
    seconds = float((row or {}).get("seconds") or 0.0)
    return seconds / 3600.0


def latest_evidence(
    equipment_id: str,
    fault_id: str,
) -> Optional[dict[str, Any]]:
    """Most recent ``fault_results.evidence`` for ``(equipment_id, fault_id)``.

    Used to surface the actual observed values the rule saw (current SAT,
    duct ΔP, etc.) so the resolver can use them as the ``observed_evidence``
    input instead of synthetic deltas.
    """
    sql = """
        SELECT evidence
          FROM fault_results
         WHERE equipment_id = %s
           AND fault_id = %s
           AND flag_value > 0
         ORDER BY ts DESC
         LIMIT 1
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (equipment_id, fault_id))
            row = cur.fetchone()
    if not row:
        return None
    ev = row.get("evidence")
    return ev if isinstance(ev, dict) else None
