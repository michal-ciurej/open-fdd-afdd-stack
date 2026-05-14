"""
Auto-seed energy opportunities from FDD rule firings.

After each FDD-loop tick writes new ``fault_results``, this module inserts a
**disabled** ``energy_opportunities`` row for every (equipment, fault_id)
pair that:

  1. has at least one ``flag_value > 0`` row in the batch,
  2. references a real equipment UUID (not a site-name fallback),
  3. has hints in ``fault_definitions.params``:
        - ``default_calc_type`` (required, must be in ALLOWED_CALC_TYPES)
        - ``default_measure_family`` (required, must be a valid enum)
        - ``default_delta_params`` (optional, JSON object)
  4. does not already have an ``energy_opportunities`` row for that pair.

Rows are inserted ``enabled = false`` so the operator can review before
enabling. The auto-seed is opt-in per rule: rules without hints are silently
skipped, so the loop is safe to run on a partially configured catalogue.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Iterable

from psycopg2.extras import Json, execute_values

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.energy_calc_library import ALLOWED_CALC_TYPES

logger = logging.getLogger(__name__)

_MEASURE_FAMILIES = frozenset(
    {"runtime", "setpoint_reset", "airside_thermal", "degradation"}
)

_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"
)


def _looks_like_uuid(text: str) -> bool:
    return bool(_UUID_RE.match((text or "").strip()))


def _external_id_for(fault_id: str) -> str:
    safe = re.sub(r"[^a-z0-9_]+", "_", (fault_id or "").lower()).strip("_")
    return f"auto_{safe}"[:200]


def _name_for(fault_def_name: str | None, fault_id: str) -> str:
    base = (fault_def_name or fault_id or "Opportunity").strip()
    return f"{base} (auto-seeded)"[:256]


def auto_seed_from_results(results: Iterable[Any]) -> int:
    """Insert disabled opportunities for new (equipment, fault) pairs.

    ``results`` is the same ``list[FDDResult]`` that the FDD loop just wrote to
    ``fault_results``. Iterating it lets us auto-seed without an extra DB
    round-trip per row.

    Returns the number of rows inserted.
    """
    pairs: set[tuple[str, str]] = set()
    for r in results:
        flag = getattr(r, "flag_value", 0)
        if not flag or flag <= 0:
            continue
        eq = str(getattr(r, "equipment_id", "") or "").strip()
        fid = str(getattr(r, "fault_id", "") or "").strip()
        if not eq or not fid:
            continue
        if not _looks_like_uuid(eq):
            # Site-level fallback emits results with equipment_id = site_name.
            # Auto-seed is equipment-scoped only.
            continue
        pairs.add((eq, fid))

    if not pairs:
        return 0

    inserted = 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            # Pull hints + existing-opportunity status for all candidate pairs in one round.
            cur.execute(
                """
                SELECT fd.fault_id, fd.name, fd.params
                  FROM fault_definitions fd
                 WHERE fd.fault_id = ANY(%s)
                """,
                (list({fid for _, fid in pairs}),),
            )
            defs_by_id: dict[str, dict[str, Any]] = {
                row["fault_id"]: dict(row) for row in cur.fetchall()
            }

            cur.execute(
                """
                SELECT equipment_id, fdd_rule_id
                  FROM energy_opportunities
                 WHERE fdd_rule_id IS NOT NULL
                """
            )
            already = {
                (str(r["equipment_id"]), r["fdd_rule_id"])
                for r in cur.fetchall()
            }

            rows_to_insert: list[tuple] = []
            for equipment_id, fault_id in pairs:
                if (equipment_id, fault_id) in already:
                    continue
                fdef = defs_by_id.get(fault_id)
                if not fdef:
                    continue
                params = fdef.get("params") or {}
                if not isinstance(params, dict):
                    continue
                calc_type = params.get("default_calc_type")
                measure_family = params.get("default_measure_family")
                if calc_type not in ALLOWED_CALC_TYPES:
                    continue
                if measure_family not in _MEASURE_FAMILIES:
                    continue
                delta = params.get("default_delta_params") or {}
                if not isinstance(delta, dict):
                    delta = {}
                rows_to_insert.append(
                    (
                        equipment_id,
                        _external_id_for(fault_id),
                        _name_for(fdef.get("name"), fault_id),
                        None,  # description
                        measure_family,
                        calc_type,
                        fault_id,
                        Json(delta),
                        0.0,
                        False,  # enabled: review-before-enable
                    )
                )

            if rows_to_insert:
                execute_values(
                    cur,
                    """
                    INSERT INTO energy_opportunities (
                        equipment_id, external_id, name, description,
                        measure_family, calc_type, fdd_rule_id, delta_params,
                        capex_usd, enabled
                    ) VALUES %s
                    ON CONFLICT (equipment_id, external_id) DO NOTHING
                    """,
                    rows_to_insert,
                )
                inserted = cur.rowcount or 0
        conn.commit()

    if inserted:
        logger.info("Auto-seeded %d energy opportunities from FDD results", inserted)
    return inserted
