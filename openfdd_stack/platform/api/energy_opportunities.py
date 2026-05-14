"""Equipment-scoped energy opportunities API.

CRUD over the `energy_opportunities` table plus per-opportunity preview and
recompute. Every write triggers a synchronous recompute of
`energy_opportunity_results` so GETs always return a cached result alongside
the opportunity row. Phase 3 adds nightly refresh from the FDD loop tick;
phase 4 adds the site-level ranking page.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query
from psycopg2.extras import Json

from openfdd_stack.platform.database import get_conn
from openfdd_stack.platform.energy_calc_library import ALLOWED_CALC_TYPES
from openfdd_stack.platform.energy_calc_resolver import compute_opportunity_result
from openfdd_stack.platform.api.auth_principal import (
    AuthUser,
    Role,
    accessible_site_ids,
    get_current_user,
    require_roles,
)
from openfdd_stack.platform.api.models import (
    EnergyOpportunityCreate,
    EnergyOpportunityPreviewBody,
    EnergyOpportunityRead,
    EnergyOpportunityResultRead,
    EnergyOpportunityUpdate,
)

router = APIRouter(prefix="/energy-opportunities", tags=["energy-opportunities"])
logger = logging.getLogger(__name__)


_OPP_COLS = (
    "id, equipment_id, external_id, name, description, measure_family, "
    "calc_type, fdd_rule_id, delta_params, capex_usd, enabled, created_at, updated_at"
)

_RESULT_COLS = (
    "baseline_annual_cost_usd, projected_annual_cost_usd, annual_savings_usd, "
    "annual_kwh_saved, annual_therms_saved, peak_kw_reduced, simple_payback_years, "
    "npv_5yr_usd, fault_hours_observed, data_quality, missing_inputs, notes, computed_at"
)


# --- helpers ---------------------------------------------------------------


def _validate_calc_type(calc_type: str) -> None:
    if calc_type not in ALLOWED_CALC_TYPES:
        raise HTTPException(
            400,
            f"Unknown calc_type {calc_type!r}. See GET /energy-calculations/calc-types.",
        )


def _check_site_access(site_id: str, user: AuthUser) -> None:
    accessible = accessible_site_ids(user)
    if accessible is not None and site_id not in accessible:
        raise HTTPException(403, "No permission for this site")


def _load_equipment(cur, equipment_id: UUID) -> dict[str, Any]:
    cur.execute(
        "SELECT id, site_id, name, equipment_type FROM equipment WHERE id = %s",
        (str(equipment_id),),
    )
    row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Equipment not found")
    return dict(row)


def _load_profile(cur, equipment_id: UUID) -> dict[str, Any]:
    """Return the profile row as a dict; empty dict if none exists yet."""
    cur.execute(
        """SELECT nameplate_kw, motor_hp, motor_efficiency, design_cfm,
                  design_sat_f, design_static_pressure_inwc, design_cop,
                  design_heating_efficiency, occupied_hours_per_year
             FROM equipment_energy_profile WHERE equipment_id = %s""",
        (str(equipment_id),),
    )
    row = cur.fetchone()
    return dict(row) if row else {}


def _load_rates(cur, site_id: str) -> dict[str, Any]:
    """Return the site rates row as a dict; falls back to platform defaults."""
    cur.execute(
        """SELECT electric_rate_per_kwh, demand_charge_per_kw, therm_rate_usd, currency
             FROM site_energy_rates WHERE site_id = %s""",
        (site_id,),
    )
    row = cur.fetchone()
    if row:
        return dict(row)
    # No row yet — return library defaults so compute still returns a value.
    return {
        "electric_rate_per_kwh": 0.12,
        "demand_charge_per_kw": 0.0,
        "therm_rate_usd": 1.0,
        "currency": "USD",
    }


def _compute_and_upsert_result(
    cur,
    opportunity_id: UUID,
    calc_type: str,
    delta_params: dict[str, Any],
    capex_usd: float,
    profile: dict[str, Any],
    rates: dict[str, Any],
) -> dict[str, Any]:
    """Run the resolver+library compute, upsert the cached row, return it."""
    result = compute_opportunity_result(
        calc_type=calc_type,
        delta_params=delta_params,
        capex_usd=float(capex_usd or 0),
        profile=profile,
        rates=rates,
    )
    cur.execute(
        f"""
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
        RETURNING {_RESULT_COLS}
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
    return dict(cur.fetchone())


def _hydrate_opportunity_row(
    opp_row: dict[str, Any], result_row: Optional[dict[str, Any]]
) -> EnergyOpportunityRead:
    """Build the response model from a SELECT-joined row pair."""
    payload = dict(opp_row)
    payload["result"] = (
        EnergyOpportunityResultRead.model_validate(dict(result_row)) if result_row else None
    )
    return EnergyOpportunityRead.model_validate(payload)


def _select_opportunity_with_result(cur, opportunity_id: UUID) -> Optional[tuple[dict, Optional[dict]]]:
    cur.execute(
        f"""
        SELECT {_OPP_COLS}, {_RESULT_COLS}
          FROM energy_opportunities o
          LEFT JOIN energy_opportunity_results r ON r.opportunity_id = o.id
         WHERE o.id = %s
        """,
        (str(opportunity_id),),
    )
    row = cur.fetchone()
    if not row:
        return None
    return _split_joined_row(row)


def _split_joined_row(row: dict[str, Any]) -> tuple[dict, Optional[dict]]:
    """Split a single SELECT row from the opps-LEFT-JOIN-results query."""
    result_keys = {
        "baseline_annual_cost_usd",
        "projected_annual_cost_usd",
        "annual_savings_usd",
        "annual_kwh_saved",
        "annual_therms_saved",
        "peak_kw_reduced",
        "simple_payback_years",
        "npv_5yr_usd",
        "fault_hours_observed",
        "data_quality",
        "missing_inputs",
        "notes",
        "computed_at",
    }
    opp = {k: v for k, v in row.items() if k not in result_keys}
    result = {k: row[k] for k in result_keys if k in row}
    # If the LEFT JOIN had no match every result field is NULL — detect that.
    has_result = any(result.get(k) is not None for k in ("data_quality", "computed_at"))
    return opp, (result if has_result else None)


# --- endpoints --------------------------------------------------------------


@router.get("", response_model=list[EnergyOpportunityRead])
def list_opportunities(
    equipment_id: Optional[UUID] = Query(None),
    site_id: Optional[UUID] = Query(None),
    user: AuthUser = Depends(get_current_user),
):
    """List opportunities filtered by equipment or site. Each row embeds its
    cached result (null when no result has been computed yet)."""
    if equipment_id is None and site_id is None:
        raise HTTPException(400, "Specify equipment_id or site_id")

    with get_conn() as conn:
        with conn.cursor() as cur:
            if equipment_id is not None:
                eq = _load_equipment(cur, equipment_id)
                _check_site_access(str(eq["site_id"]), user)
                cur.execute(
                    f"""
                    SELECT {_OPP_COLS}, {_RESULT_COLS}
                      FROM energy_opportunities o
                      LEFT JOIN energy_opportunity_results r ON r.opportunity_id = o.id
                     WHERE o.equipment_id = %s
                     ORDER BY r.annual_savings_usd DESC NULLS LAST, o.name
                    """,
                    (str(equipment_id),),
                )
            else:
                _check_site_access(str(site_id), user)
                cur.execute(
                    f"""
                    SELECT {_OPP_COLS}, {_RESULT_COLS}
                      FROM energy_opportunities o
                      LEFT JOIN energy_opportunity_results r ON r.opportunity_id = o.id
                      JOIN equipment e ON e.id = o.equipment_id
                     WHERE e.site_id = %s
                     ORDER BY r.annual_savings_usd DESC NULLS LAST, o.name
                    """,
                    (str(site_id),),
                )
            rows = cur.fetchall()
    return [
        _hydrate_opportunity_row(*_split_joined_row(dict(r))) for r in rows
    ]


@router.post(
    "",
    response_model=EnergyOpportunityRead,
    dependencies=[Depends(require_roles(Role.ADMIN, Role.ENGINEER))],
)
def create_opportunity(
    body: EnergyOpportunityCreate,
    user: AuthUser = Depends(get_current_user),
):
    """Create an opportunity and synchronously compute its cached result."""
    _validate_calc_type(body.calc_type)
    with get_conn() as conn:
        with conn.cursor() as cur:
            eq = _load_equipment(cur, body.equipment_id)
            _check_site_access(str(eq["site_id"]), user)

            # Uniqueness check (external_id per equipment).
            cur.execute(
                "SELECT id FROM energy_opportunities WHERE equipment_id = %s AND external_id = %s",
                (str(body.equipment_id), body.external_id),
            )
            if cur.fetchone():
                raise HTTPException(
                    409,
                    "Opportunity with this external_id already exists for this equipment",
                )

            cur.execute(
                f"""
                INSERT INTO energy_opportunities (
                    equipment_id, external_id, name, description, measure_family,
                    calc_type, fdd_rule_id, delta_params, capex_usd, enabled
                ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s)
                RETURNING {_OPP_COLS}
                """,
                (
                    str(body.equipment_id),
                    body.external_id,
                    body.name,
                    body.description,
                    body.measure_family,
                    body.calc_type,
                    body.fdd_rule_id,
                    Json(body.delta_params or {}),
                    float(body.capex_usd or 0),
                    body.enabled,
                ),
            )
            opp_row = dict(cur.fetchone())

            profile = _load_profile(cur, body.equipment_id)
            rates = _load_rates(cur, str(eq["site_id"]))
            result_row = _compute_and_upsert_result(
                cur=cur,
                opportunity_id=opp_row["id"],
                calc_type=opp_row["calc_type"],
                delta_params=dict(opp_row["delta_params"] or {}),
                capex_usd=float(opp_row["capex_usd"] or 0),
                profile=profile,
                rates=rates,
            )
        conn.commit()
    return _hydrate_opportunity_row(opp_row, result_row)


@router.get("/{opportunity_id}", response_model=EnergyOpportunityRead)
def get_opportunity(
    opportunity_id: UUID,
    user: AuthUser = Depends(get_current_user),
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            found = _select_opportunity_with_result(cur, opportunity_id)
            if not found:
                raise HTTPException(404, "Opportunity not found")
            opp_row, result_row = found
            eq = _load_equipment(cur, opp_row["equipment_id"])
            _check_site_access(str(eq["site_id"]), user)
    return _hydrate_opportunity_row(opp_row, result_row)


@router.patch(
    "/{opportunity_id}",
    response_model=EnergyOpportunityRead,
    dependencies=[Depends(require_roles(Role.ADMIN, Role.ENGINEER))],
)
def update_opportunity(
    opportunity_id: UUID,
    body: EnergyOpportunityUpdate,
    user: AuthUser = Depends(get_current_user),
):
    """Update opportunity fields and synchronously recompute the cached result."""
    if body.calc_type is not None:
        _validate_calc_type(body.calc_type)

    body_dict = body.model_dump(exclude_unset=True)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_OPP_COLS} FROM energy_opportunities WHERE id = %s",
                (str(opportunity_id),),
            )
            existing = cur.fetchone()
            if not existing:
                raise HTTPException(404, "Opportunity not found")
            existing = dict(existing)
            eq = _load_equipment(cur, existing["equipment_id"])
            _check_site_access(str(eq["site_id"]), user)

            if body_dict:
                updates: list[str] = []
                params: list[Any] = []
                for key, value in body_dict.items():
                    if key == "delta_params":
                        updates.append("delta_params = %s::jsonb")
                        params.append(Json(value or {}))
                    else:
                        updates.append(f"{key} = %s")
                        params.append(value)
                updates.append("updated_at = now()")
                params.append(str(opportunity_id))
                cur.execute(
                    f"UPDATE energy_opportunities SET {', '.join(updates)} "
                    f"WHERE id = %s RETURNING {_OPP_COLS}",
                    params,
                )
                opp_row = dict(cur.fetchone())
            else:
                opp_row = existing

            profile = _load_profile(cur, opp_row["equipment_id"])
            rates = _load_rates(cur, str(eq["site_id"]))
            result_row = _compute_and_upsert_result(
                cur=cur,
                opportunity_id=opp_row["id"],
                calc_type=opp_row["calc_type"],
                delta_params=dict(opp_row["delta_params"] or {}),
                capex_usd=float(opp_row["capex_usd"] or 0),
                profile=profile,
                rates=rates,
            )
        conn.commit()
    return _hydrate_opportunity_row(opp_row, result_row)


@router.delete(
    "/{opportunity_id}",
    dependencies=[Depends(require_roles(Role.ADMIN, Role.ENGINEER))],
)
def delete_opportunity(
    opportunity_id: UUID,
    user: AuthUser = Depends(get_current_user),
):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT equipment_id FROM energy_opportunities WHERE id = %s",
                (str(opportunity_id),),
            )
            row = cur.fetchone()
            if not row:
                raise HTTPException(404, "Opportunity not found")
            eq = _load_equipment(cur, row["equipment_id"])
            _check_site_access(str(eq["site_id"]), user)
            cur.execute(
                "DELETE FROM energy_opportunities WHERE id = %s",
                (str(opportunity_id),),
            )
        conn.commit()
    return {"status": "deleted"}


@router.post(
    "/{opportunity_id}/recompute",
    response_model=EnergyOpportunityRead,
    dependencies=[Depends(require_roles(Role.ADMIN, Role.ENGINEER))],
)
def recompute_opportunity(
    opportunity_id: UUID,
    user: AuthUser = Depends(get_current_user),
):
    """Force a fresh compute of the cached result for one opportunity."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"SELECT {_OPP_COLS} FROM energy_opportunities WHERE id = %s",
                (str(opportunity_id),),
            )
            existing = cur.fetchone()
            if not existing:
                raise HTTPException(404, "Opportunity not found")
            opp_row = dict(existing)
            eq = _load_equipment(cur, opp_row["equipment_id"])
            _check_site_access(str(eq["site_id"]), user)
            profile = _load_profile(cur, opp_row["equipment_id"])
            rates = _load_rates(cur, str(eq["site_id"]))
            result_row = _compute_and_upsert_result(
                cur=cur,
                opportunity_id=opp_row["id"],
                calc_type=opp_row["calc_type"],
                delta_params=dict(opp_row["delta_params"] or {}),
                capex_usd=float(opp_row["capex_usd"] or 0),
                profile=profile,
                rates=rates,
            )
        conn.commit()
    return _hydrate_opportunity_row(opp_row, result_row)


@router.post("/preview", response_model=EnergyOpportunityResultRead)
def preview_opportunity(
    body: EnergyOpportunityPreviewBody,
    user: AuthUser = Depends(get_current_user),
):
    """Preview a not-yet-saved opportunity. Reads profile + rates for the
    target equipment so the wizard shows realistic numbers before commit.
    """
    _validate_calc_type(body.calc_type)
    with get_conn() as conn:
        with conn.cursor() as cur:
            eq = _load_equipment(cur, body.equipment_id)
            _check_site_access(str(eq["site_id"]), user)
            profile = _load_profile(cur, body.equipment_id)
            rates = _load_rates(cur, str(eq["site_id"]))
    result = compute_opportunity_result(
        calc_type=body.calc_type,
        delta_params=body.delta_params or {},
        capex_usd=float(body.capex_usd or 0),
        profile=profile,
        rates=rates,
    )
    result["computed_at"] = datetime.now(timezone.utc)
    return EnergyOpportunityResultRead.model_validate(result)
