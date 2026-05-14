"""
Energy opportunity recompute paths.

Re-runs ``compute_opportunity_result`` (via the resolver) for one opportunity,
a piece of equipment, or a whole site, and upserts the cached row in
``energy_opportunity_results``.

Called from:
  * end of an FDD-loop tick (see openfdd_stack.platform.loop) — passes
    the set of sites just processed, so trailing fault-hours and latest
    evidence get refreshed without explicit operator action.
  * background jobs queued from rate or profile PUT handlers (see
    openfdd_stack.platform.api.energy_rates / equipment_energy_profile) —
    cascades a change in shared inputs to every dependent opportunity.

Each entry-point is idempotent and best-effort: failures are logged and
swallowed so a single bad opportunity doesn't poison a whole site tick.
"""

from __future__ import annotations

import logging
from typing import Any, Optional
from uuid import UUID

from psycopg2.extras import Json

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.energy_calc_library import ALLOWED_CALC_TYPES
from openfdd_stack.platform.energy_calc_resolver import compute_opportunity_result
from openfdd_stack.platform.energy_observed import (
    latest_evidence,
    trailing_fault_hours,
)
from openfdd_stack.platform.realtime import TOPIC_ENERGY_RECOMPUTE, emit

logger = logging.getLogger(__name__)


_OPP_COLS = (
    "id, equipment_id, calc_type, fdd_rule_id, delta_params, capex_usd, enabled"
)


def _load_profile_row(cur, equipment_id) -> dict[str, Any]:
    cur.execute(
        """SELECT nameplate_kw, motor_hp, motor_efficiency, design_cfm,
                  design_sat_f, design_static_pressure_inwc, design_cop,
                  design_heating_efficiency, occupied_hours_per_year
             FROM equipment_energy_profile WHERE equipment_id = %s""",
        (str(equipment_id),),
    )
    row = cur.fetchone()
    return dict(row) if row else {}


def _load_rates_row(cur, site_id) -> dict[str, Any]:
    cur.execute(
        """SELECT electric_rate_per_kwh, demand_charge_per_kw, therm_rate_usd, currency
             FROM site_energy_rates WHERE site_id = %s""",
        (str(site_id),),
    )
    row = cur.fetchone()
    if row:
        return dict(row)
    return {
        "electric_rate_per_kwh": 0.12,
        "demand_charge_per_kw": 0.0,
        "therm_rate_usd": 1.0,
        "currency": "GBP",
    }


def _lookup_site_id_for_equipment(cur, equipment_id) -> Optional[str]:
    cur.execute(
        "SELECT site_id FROM equipment WHERE id = %s",
        (str(equipment_id),),
    )
    row = cur.fetchone()
    return str(row["site_id"]) if row else None


def _upsert_result(cur, opportunity_id, result: dict[str, Any]) -> None:
    cur.execute(
        """
        INSERT INTO energy_opportunity_results (
            opportunity_id, baseline_annual_cost_usd, projected_annual_cost_usd,
            annual_savings_usd, annual_kwh_saved, annual_therms_saved,
            peak_kw_reduced, simple_payback_years, npv_5yr_usd,
            fault_hours_observed, data_quality, missing_inputs, notes, computed_at
        ) VALUES (
            %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, now()
        )
        ON CONFLICT (opportunity_id) DO UPDATE SET
            baseline_annual_cost_usd  = EXCLUDED.baseline_annual_cost_usd,
            projected_annual_cost_usd = EXCLUDED.projected_annual_cost_usd,
            annual_savings_usd        = EXCLUDED.annual_savings_usd,
            annual_kwh_saved          = EXCLUDED.annual_kwh_saved,
            annual_therms_saved       = EXCLUDED.annual_therms_saved,
            peak_kw_reduced           = EXCLUDED.peak_kw_reduced,
            simple_payback_years      = EXCLUDED.simple_payback_years,
            npv_5yr_usd               = EXCLUDED.npv_5yr_usd,
            fault_hours_observed      = EXCLUDED.fault_hours_observed,
            data_quality              = EXCLUDED.data_quality,
            missing_inputs            = EXCLUDED.missing_inputs,
            notes                     = EXCLUDED.notes,
            computed_at               = now()
        """,
        (
            str(opportunity_id),
            result["baseline_annual_cost_usd"],
            result["projected_annual_cost_usd"],
            result["annual_savings_usd"],
            result["annual_kwh_saved"],
            result["annual_therms_saved"],
            result["peak_kw_reduced"],
            result["simple_payback_years"],
            result["npv_5yr_usd"],
            result["fault_hours_observed"],
            result["data_quality"],
            Json(result["missing_inputs"]),
            result["notes"],
        ),
    )


def _recompute_one(cur, opp: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Run resolver + compute for a single opportunity row dict; upsert result.

    Returns the result dict for telemetry, or None if the calc_type is unknown
    (defensive — bad rows shouldn't kill a sweep).
    """
    calc_type = opp.get("calc_type")
    if calc_type not in ALLOWED_CALC_TYPES:
        logger.warning(
            "recompute: opportunity %s has unknown calc_type %r — skipping",
            opp.get("id"),
            calc_type,
        )
        return None

    site_id = _lookup_site_id_for_equipment(cur, opp["equipment_id"])
    if site_id is None:
        logger.warning(
            "recompute: equipment %s for opportunity %s no longer exists",
            opp["equipment_id"],
            opp["id"],
        )
        return None

    profile = _load_profile_row(cur, opp["equipment_id"])
    rates = _load_rates_row(cur, site_id)

    # Observed channel — only meaningful when the opportunity is tied to an FDD rule.
    observed_hours = None
    observed_evidence = None
    fdd_rule_id = opp.get("fdd_rule_id")
    if fdd_rule_id:
        try:
            observed_hours = trailing_fault_hours(
                equipment_id=str(opp["equipment_id"]),
                fault_id=fdd_rule_id,
            )
        except Exception:
            logger.exception(
                "recompute: trailing_fault_hours failed for opp=%s rule=%s",
                opp["id"],
                fdd_rule_id,
            )
        try:
            observed_evidence = latest_evidence(
                equipment_id=str(opp["equipment_id"]),
                fault_id=fdd_rule_id,
            )
        except Exception:
            logger.exception(
                "recompute: latest_evidence failed for opp=%s rule=%s",
                opp["id"],
                fdd_rule_id,
            )

    result = compute_opportunity_result(
        calc_type=calc_type,
        delta_params=dict(opp.get("delta_params") or {}),
        capex_usd=float(opp.get("capex_usd") or 0),
        profile=profile,
        rates=rates,
        observed_hours=observed_hours,
        observed_evidence=observed_evidence,
    )
    _upsert_result(cur, opp["id"], result)
    return result


def recompute_opportunity(opportunity_id: UUID | str) -> Optional[dict[str, Any]]:
    """Refresh the cached result for one opportunity. Safe to call from any path."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_OPP_COLS} FROM energy_opportunities WHERE id = %s",
                (str(opportunity_id),),
            )
            row = cur.fetchone()
            if not row:
                return None
            result = _recompute_one(cur, dict(row))
        conn.commit()
    emit(TOPIC_ENERGY_RECOMPUTE + ".opportunity", {"id": str(opportunity_id)})
    return result


def _recompute_many(scope_label: str, scope_value: str, sql: str) -> int:
    """Run _recompute_one over every row returned by sql (parametrized by scope_value).
    Returns the number of opportunities successfully recomputed."""
    succeeded = 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql, (scope_value,))
            rows = [dict(r) for r in cur.fetchall()]
            for opp in rows:
                try:
                    if _recompute_one(cur, opp) is not None:
                        succeeded += 1
                except Exception:
                    logger.exception(
                        "recompute(%s=%s): opportunity %s failed",
                        scope_label,
                        scope_value,
                        opp.get("id"),
                    )
        conn.commit()
    emit(
        TOPIC_ENERGY_RECOMPUTE + "." + scope_label,
        {scope_label: scope_value, "count": succeeded},
    )
    return succeeded


def recompute_for_equipment(equipment_id: UUID | str) -> int:
    return _recompute_many(
        "equipment_id",
        str(equipment_id),
        f"""SELECT {_OPP_COLS}
              FROM energy_opportunities
             WHERE equipment_id = %s AND enabled = true""",
    )


def recompute_for_site(site_id: UUID | str) -> int:
    return _recompute_many(
        "site_id",
        str(site_id),
        f"""SELECT o.id, o.equipment_id, o.calc_type, o.fdd_rule_id,
                   o.delta_params, o.capex_usd, o.enabled
              FROM energy_opportunities o
              JOIN equipment e ON e.id = o.equipment_id
             WHERE e.site_id = %s AND o.enabled = true""",
    )


def recompute_all_enabled() -> int:
    """Sweep every enabled opportunity across all sites — used by the
    end-of-FDD-tick hook in :mod:`openfdd_stack.platform.loop`."""
    succeeded = 0
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""SELECT {_OPP_COLS} FROM energy_opportunities WHERE enabled = true"""
            )
            rows = [dict(r) for r in cur.fetchall()]
            for opp in rows:
                try:
                    if _recompute_one(cur, opp) is not None:
                        succeeded += 1
                except Exception:
                    logger.exception(
                        "recompute_all_enabled: opportunity %s failed",
                        opp.get("id"),
                    )
        conn.commit()
    emit(TOPIC_ENERGY_RECOMPUTE + ".all", {"count": succeeded})
    return succeeded
