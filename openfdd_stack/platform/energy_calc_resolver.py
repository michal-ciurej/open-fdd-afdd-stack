"""
Energy opportunity input resolver — turns the new normalized model (opportunity
deltas + equipment profile + site rates + observed evidence) into the flat
params dict that energy_calc_library.preview_energy_calc expects.

Resolution priority for each calc-library field key, highest wins:
    1. opportunity.delta_params[key]   -> 'partial'  (operator override)
    2. observed_evidence[key]          -> 'observed' (from fault_results.evidence)
    3. equipment_energy_profile field  -> 'partial'  (operator-configured nameplate)
    4. site_energy_rates field         -> 'partial'  (operator-configured rate)
    5. spec default in CALC_TYPE_SPECS -> 'assumed'  (platform fallback)
    6. otherwise                       -> missing input (no value)

Hours have two flavors. The user may pin a value via delta_params['hours_fault']
(or 'hours' / 'hours_saved' depending on calc type); otherwise the resolver
falls back to ``observed_hours`` (from fault_events trailing 365d in phase 3)
and finally to ``equipment_energy_profile.occupied_hours_per_year``.

This module is pure: the API/recompute layer reads rows from the DB and passes
them in. Tests instantiate it with plain dicts.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

from openfdd_stack.platform.energy_calc_library import (
    CALC_TYPE_SPECS,
    preview_energy_calc,
)


# Calc-library parameter keys served from equipment_energy_profile columns.
PROFILE_TO_PARAM_KEYS: dict[str, tuple[str, ...]] = {
    "nameplate_kw": ("kw", "kw_actual", "kw_stack", "kw_hw_pump", "p_full_kw"),
    "motor_hp": ("motor_hp",),
    "motor_efficiency": ("motor_efficiency", "eta_motor"),
    "design_cfm": ("cfm", "cfm_excess", "cfm_oa"),
    "design_sat_f": ("sat_opt_f",),
    "design_cop": ("cop",),
    "design_heating_efficiency": ("heating_efficiency", "boiler_efficiency"),
    "occupied_hours_per_year": ("hours", "hours_fault", "hours_saved"),
}

# Calc-library parameter keys served from site_energy_rates columns.
RATES_TO_PARAM_KEYS: dict[str, tuple[str, ...]] = {
    "electric_rate_per_kwh": ("electric_rate_per_kwh",),
    "therm_rate_usd": ("therm_rate_usd",),
}

# Quality ordering: lower numeric value = lower confidence.
_QUALITY_RANK = {"observed": 3, "partial": 2, "assumed": 1}


def _invert_field_mapping(
    mapping: dict[str, tuple[str, ...]],
) -> dict[str, str]:
    """Flip {source_col: (param_key, ...)} → {param_key: source_col}."""
    out: dict[str, str] = {}
    for source, keys in mapping.items():
        for k in keys:
            out.setdefault(k, source)
    return out


_PARAM_FROM_PROFILE = _invert_field_mapping(PROFILE_TO_PARAM_KEYS)
_PARAM_FROM_RATES = _invert_field_mapping(RATES_TO_PARAM_KEYS)


def _has_value(v: Any) -> bool:
    return v is not None and v != ""


def resolve_calc_inputs(
    *,
    calc_type: str,
    delta_params: Mapping[str, Any] | None,
    profile: Mapping[str, Any] | None,
    rates: Mapping[str, Any] | None,
    observed_hours: Optional[float] = None,
    observed_evidence: Mapping[str, Any] | None = None,
) -> tuple[dict[str, Any], dict[str, str]]:
    """Build the flat ``params`` dict for ``preview_energy_calc`` plus a
    per-field quality map. Unknown calc_types yield ({}, {}).
    """
    spec = CALC_TYPE_SPECS.get(calc_type)
    if not spec:
        return {}, {}

    delta = dict(delta_params or {})
    profile = dict(profile or {})
    rates = dict(rates or {})
    evidence = dict(observed_evidence or {})

    params: dict[str, Any] = {}
    quality: dict[str, str] = {}

    for field in spec.get("fields") or []:
        key = field["key"]

        # 1. Operator override via opportunity.delta_params
        if _has_value(delta.get(key)):
            params[key] = delta[key]
            quality[key] = "partial"
            continue

        # 2. Observed value from fault evidence (phase 3 wires this).
        if _has_value(evidence.get(key)):
            params[key] = evidence[key]
            quality[key] = "observed"
            continue

        # 3a. Hours have a dedicated observed channel (trailing fault hours).
        if (
            key in PROFILE_TO_PARAM_KEYS["occupied_hours_per_year"]
            and observed_hours is not None
        ):
            params[key] = float(observed_hours)
            quality[key] = "observed"
            continue

        # 3b. Equipment profile mapping.
        prof_col = _PARAM_FROM_PROFILE.get(key)
        if prof_col and _has_value(profile.get(prof_col)):
            params[key] = profile[prof_col]
            quality[key] = "partial"
            continue

        # 4. Site rates mapping.
        rate_col = _PARAM_FROM_RATES.get(key)
        if rate_col and _has_value(rates.get(rate_col)):
            params[key] = rates[rate_col]
            quality[key] = "partial"
            continue

        # 5. Spec default — only if the field actually declares one.
        if field.get("default") is not None:
            params[key] = field["default"]
            quality[key] = "assumed"
            continue

        # 6. No value — leave out of params; preview_energy_calc will list it.

    return params, quality


def _overall_quality(quality_by_field: Mapping[str, str]) -> str:
    if not quality_by_field:
        return "assumed"
    ranks = [_QUALITY_RANK.get(q, 0) for q in quality_by_field.values()]
    min_rank = min(ranks)
    for label, rank in _QUALITY_RANK.items():
        if rank == min_rank:
            return label
    return "assumed"


def _simple_payback_years(
    capex_usd: float, annual_savings_usd: Optional[float]
) -> Optional[float]:
    if annual_savings_usd is None or annual_savings_usd <= 0:
        return None
    if capex_usd <= 0:
        return 0.0
    return capex_usd / annual_savings_usd


def _npv_5yr(
    capex_usd: float, annual_savings_usd: Optional[float]
) -> Optional[float]:
    """Naive 5-year NPV at 0% discount — projected savings minus capex.
    Phase 2 keeps the formula trivial; refine when a discount rate is configured.
    """
    if annual_savings_usd is None:
        return None
    return 5.0 * annual_savings_usd - capex_usd


def compute_opportunity_result(
    *,
    calc_type: str,
    delta_params: Mapping[str, Any] | None,
    capex_usd: float,
    profile: Mapping[str, Any] | None,
    rates: Mapping[str, Any] | None,
    observed_hours: Optional[float] = None,
    observed_evidence: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Compute the full cached-result row for one opportunity.

    Returns a dict matching the energy_opportunity_results table shape (sans
    opportunity_id). Phase 2 callers persist this verbatim.
    """
    params, quality = resolve_calc_inputs(
        calc_type=calc_type,
        delta_params=delta_params,
        profile=profile,
        rates=rates,
        observed_hours=observed_hours,
        observed_evidence=observed_evidence,
    )
    preview = preview_energy_calc(calc_type, params)

    savings = preview.get("annual_cost_saved_usd")
    # Phase 2 assumption: a fix removes 100% of the waste this opportunity
    # represents, so baseline = savings and projected = 0. The model can be
    # refined later (e.g. partial fix factor) without changing callers.
    baseline = savings if isinstance(savings, (int, float)) else None
    projected = 0.0 if baseline is not None else None

    return {
        "baseline_annual_cost_usd": baseline,
        "projected_annual_cost_usd": projected,
        "annual_savings_usd": savings,
        "annual_kwh_saved": preview.get("annual_kwh_saved"),
        "annual_therms_saved": preview.get("annual_therms_saved"),
        "peak_kw_reduced": preview.get("peak_kw_reduced"),
        "simple_payback_years": _simple_payback_years(capex_usd, savings),
        "npv_5yr_usd": _npv_5yr(capex_usd, savings),
        "fault_hours_observed": observed_hours,
        "data_quality": _overall_quality(quality),
        "missing_inputs": preview.get("missing_inputs") or [],
        "notes": preview.get("notes"),
    }
