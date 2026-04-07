"""
FDD-oriented energy / savings preview calculations (interval-style inputs annualized).

Outputs align with common M&V-style summaries for dashboards and future fault-duration integration.
Not a full 223P model — plain engineering formulas with explicit assumptions.
"""

from __future__ import annotations

import math
from typing import Any, Optional

# --- Calc type registry (API + UI) -------------------------------------------------

CALC_TYPE_SPECS: dict[str, dict[str, Any]] = {
    "runtime_electric_kw": {
        "label": "Excess runtime — known kW",
        "summary": "kWh = kW × excess hours; for fans/pumps when measured or assumed load is constant.",
        "category": "electric_runtime",
        "fields": [
            {"key": "kw", "label": "Load (kW)", "type": "float", "min": 0},
            {"key": "hours_fault", "label": "Excess hours (e.g. per year)", "type": "float", "min": 0},
            {
                "key": "electric_rate_per_kwh",
                "label": "Electric rate ($/kWh)",
                "type": "float",
                "min": 0,
                "default": 0.12,
            },
        ],
    },
    "motor_hp_runtime": {
        "label": "Motor HP — runtime savings",
        "summary": "kW = (HP × 0.746 × load_factor) / η_motor; then kWh = kW × hours.",
        "category": "electric_runtime",
        "fields": [
            {"key": "motor_hp", "label": "Motor HP", "type": "float", "min": 0},
            {"key": "load_factor", "label": "Load factor (0–1)", "type": "float", "min": 0, "max": 1, "default": 0.8},
            {"key": "motor_efficiency", "label": "Motor efficiency (0–1)", "type": "float", "min": 0.01, "max": 1, "default": 0.9},
            {"key": "hours_fault", "label": "Excess hours (e.g. per year)", "type": "float", "min": 0},
            {
                "key": "electric_rate_per_kwh",
                "label": "Electric rate ($/kWh)",
                "type": "float",
                "min": 0,
                "default": 0.12,
            },
        ],
    },
    "vfd_affinity_cube": {
        "label": "Fan / pump VFD (affinity cube)",
        "summary": "ΔkW ≈ P_full × ((S_base/100)³ − (S_prop/100)³); annual kWh = ΔkW × hours.",
        "category": "vfd_affinity",
        "fields": [
            {"key": "p_full_kw", "label": "Power at full speed (kW)", "type": "float", "min": 0},
            {"key": "speed_base_pct", "label": "Baseline speed (%)", "type": "float", "min": 0, "max": 150, "default": 100},
            {"key": "speed_prop_pct", "label": "Improved speed (%)", "type": "float", "min": 0, "max": 150, "default": 70},
            {"key": "hours", "label": "Operating hours in fault/improved scenario", "type": "float", "min": 0},
            {
                "key": "electric_rate_per_kwh",
                "label": "Electric rate ($/kWh)",
                "type": "float",
                "min": 0,
                "default": 0.12,
            },
        ],
    },
    "oa_heating_sensible": {
        "label": "Excess OA — heating (sensible)",
        "summary": "BTU/h ≈ 1.08 × CFM × ΔT; therms ≈ BTU × hours / (100,000 × η).",
        "category": "airside_thermal",
        "fields": [
            {"key": "cfm_excess", "label": "Excess OA CFM", "type": "float", "min": 0},
            {"key": "delta_t_f", "label": "ΔT (°F) heating", "type": "float", "min": 0},
            {"key": "hours", "label": "Hours in condition", "type": "float", "min": 0},
            {"key": "heating_efficiency", "label": "Heating efficiency (0–1)", "type": "float", "min": 0.01, "max": 1, "default": 0.8},
            {"key": "therm_rate_usd", "label": "Gas rate ($/therm)", "type": "float", "min": 0, "default": 1.0},
        ],
    },
    "oa_cooling_sensible": {
        "label": "Excess OA — cooling (sensible)",
        "summary": "BTU/h ≈ 1.08 × CFM × ΔT; kWh ≈ BTU × hours / (3412 × COP).",
        "category": "airside_thermal",
        "fields": [
            {"key": "cfm_excess", "label": "Excess OA CFM", "type": "float", "min": 0},
            {"key": "delta_t_f", "label": "ΔT (°F) cooling (OA vs reference)", "type": "float", "min": 0},
            {"key": "hours", "label": "Hours in condition", "type": "float", "min": 0},
            {"key": "cop", "label": "Plant / chiller COP", "type": "float", "min": 0.1, "default": 3.5},
            {
                "key": "electric_rate_per_kwh",
                "label": "Electric rate ($/kWh)",
                "type": "float",
                "min": 0,
                "default": 0.12,
            },
        ],
    },
    "simultaneous_hydronic_btu": {
        "label": "Simultaneous heat + cool — hydronic waste",
        "summary": "BTU/h ≈ 500 × GPM × ΔT (water); useful for reheat / fighting coils.",
        "category": "hydronic_waste",
        "fields": [
            {"key": "gpm", "label": "Flow (GPM)", "type": "float", "min": 0},
            {"key": "delta_t_f", "label": "ΔT (°F)", "type": "float", "min": 0},
            {"key": "hours", "label": "Hours simultaneous", "type": "float", "min": 0},
            {"key": "assign_to", "label": "Assign fuel", "type": "enum", "options": ["electric_chiller", "gas_boiler"], "default": "electric_chiller"},
            {"key": "cop", "label": "COP (if electric assign)", "type": "float", "min": 0.1, "default": 3.5},
            {"key": "boiler_efficiency", "label": "Boiler η (if gas assign)", "type": "float", "min": 0.01, "max": 1, "default": 0.8},
            {
                "key": "electric_rate_per_kwh",
                "label": "Electric rate ($/kWh)",
                "type": "float",
                "min": 0,
                "default": 0.12,
            },
            {"key": "therm_rate_usd", "label": "Gas rate ($/therm)", "type": "float", "min": 0, "default": 1.0},
        ],
    },
    "lighting_watts": {
        "label": "Lighting — runtime",
        "summary": "kWh = (W/1000) × hours saved.",
        "category": "lighting",
        "fields": [
            {"key": "watts", "label": "Connected load (W)", "type": "float", "min": 0},
            {"key": "hours_saved", "label": "Hours saved (e.g. per year)", "type": "float", "min": 0},
            {
                "key": "electric_rate_per_kwh",
                "label": "Electric rate ($/kWh)",
                "type": "float",
                "min": 0,
                "default": 0.12,
            },
        ],
    },
}

ALLOWED_CALC_TYPES = frozenset(CALC_TYPE_SPECS.keys())


def _f(params: dict[str, Any], key: str, default: Optional[float] = None) -> Optional[float]:
    if key not in params or params[key] is None or params[key] == "":
        return default
    try:
        return float(params[key])
    except (TypeError, ValueError):
        return None


def _missing_required(spec: dict[str, Any], params: dict[str, Any]) -> list[str]:
    missing: list[str] = []
    for f in spec.get("fields") or []:
        if f.get("type") == "enum":
            if _f(params, f["key"], None) is None and f.get("default") is None:
                missing.append(f["key"])
            continue
        v = _f(params, f["key"], None)
        if v is None and f.get("default") is None:
            missing.append(f["key"])
    return missing


def preview_energy_calc(calc_type: str, parameters: dict[str, Any]) -> dict[str, Any]:
    """
    Return standard preview block. Uses annualized / user-supplied hours (not yet trend-integrated).
    """
    out: dict[str, Any] = {
        "calc_type": calc_type,
        "annual_kwh_saved": None,
        "annual_therms_saved": None,
        "annual_mmbtu_saved": None,
        "annual_cost_saved_usd": None,
        "peak_kw_reduced": None,
        "simple_payback_years": None,
        "confidence_score": None,
        "missing_inputs": [],
        "assumptions_used": [],
        "notes": "Preview uses static inputs; tie to fault duration and trends in a future analytics pass.",
    }
    if calc_type not in CALC_TYPE_SPECS:
        out["notes"] = f"Unknown calc_type {calc_type!r}."
        out["confidence_score"] = 0
        return out

    spec = CALC_TYPE_SPECS[calc_type]
    params = dict(parameters or {})
    for f in spec.get("fields") or []:
        if f.get("default") is not None and (f["key"] not in params or params[f["key"]] in (None, "")):
            params[f["key"]] = f["default"]

    missing = _missing_required(spec, params)
    out["missing_inputs"] = missing
    if missing:
        out["confidence_score"] = 1
        return out

    assumptions: list[str] = [
        "Sensible air only unless noted; no demand-charge model.",
        "Single operating point / annualized hours — not interval-integrated.",
    ]
    out["assumptions_used"] = assumptions

    kwh = 0.0
    therms = 0.0
    cost = 0.0
    peak_kw = None

    if calc_type == "runtime_electric_kw":
        kw = _f(params, "kw", 0) or 0
        h = _f(params, "hours_fault", 0) or 0
        rate = _f(params, "electric_rate_per_kwh", 0) or 0
        kwh = kw * h
        cost = kwh * rate
        peak_kw = kw
    elif calc_type == "motor_hp_runtime":
        hp = _f(params, "motor_hp", 0) or 0
        lf = _f(params, "load_factor", 0.8) or 0.8
        eta = _f(params, "motor_efficiency", 0.9) or 0.9
        h = _f(params, "hours_fault", 0) or 0
        rate = _f(params, "electric_rate_per_kwh", 0) or 0
        kw_m = (hp * 0.746 * lf) / max(eta, 1e-6)
        kwh = kw_m * h
        cost = kwh * rate
        peak_kw = kw_m
        assumptions.append("Motor kW from nameplate HP × load factor / efficiency.")
    elif calc_type == "vfd_affinity_cube":
        p_full = _f(params, "p_full_kw", 0) or 0
        sb = (_f(params, "speed_base_pct", 100) or 100) / 100.0
        sp = (_f(params, "speed_prop_pct", 70) or 70) / 100.0
        h = _f(params, "hours", 0) or 0
        rate = _f(params, "electric_rate_per_kwh", 0) or 0
        kw_saved = p_full * (max(sb, 0) ** 3 - max(sp, 0) ** 3)
        if kw_saved < 0:
            kw_saved = 0.0
        kwh = kw_saved * h
        cost = kwh * rate
        peak_kw = kw_saved
        assumptions.append("Affinity P ∝ speed³; ignores system curve and minimum speed limits.")
    elif calc_type == "oa_heating_sensible":
        cfm = _f(params, "cfm_excess", 0) or 0
        dt = _f(params, "delta_t_f", 0) or 0
        h = _f(params, "hours", 0) or 0
        eta = _f(params, "heating_efficiency", 0.8) or 0.8
        tr = _f(params, "therm_rate_usd", 0) or 0
        btuh = 1.08 * cfm * dt
        btu_tot = btuh * h
        th = btu_tot / (100_000.0 * max(eta, 1e-6))
        therms = th
        cost = th * tr
        out["annual_mmbtu_saved"] = (btu_tot / 1_000_000.0) if btu_tot else None
    elif calc_type == "oa_cooling_sensible":
        cfm = _f(params, "cfm_excess", 0) or 0
        dt = _f(params, "delta_t_f", 0) or 0
        h = _f(params, "hours", 0) or 0
        cop = _f(params, "cop", 3.5) or 3.5
        rate = _f(params, "electric_rate_per_kwh", 0) or 0
        btuh = 1.08 * cfm * dt
        btu_tot = btuh * h
        kwh = btu_tot / (3412.0 * max(cop, 1e-6))
        cost = kwh * rate
        out["annual_mmbtu_saved"] = (btu_tot / 1_000_000.0) if btu_tot else None
    elif calc_type == "simultaneous_hydronic_btu":
        gpm = _f(params, "gpm", 0) or 0
        dt = _f(params, "delta_t_f", 0) or 0
        h = _f(params, "hours", 0) or 0
        assign = str(params.get("assign_to") or "electric_chiller")
        btuh = 500.0 * gpm * dt
        btu_tot = btuh * h
        out["annual_mmbtu_saved"] = btu_tot / 1_000_000.0
        if assign == "gas_boiler":
            eta = _f(params, "boiler_efficiency", 0.8) or 0.8
            tr = _f(params, "therm_rate_usd", 0) or 0
            therms = btu_tot / (100_000.0 * max(eta, 1e-6))
            cost = therms * tr
        else:
            cop = _f(params, "cop", 3.5) or 3.5
            rate = _f(params, "electric_rate_per_kwh", 0) or 0
            kwh = btu_tot / (3412.0 * max(cop, 1e-6))
            cost = kwh * rate
    elif calc_type == "lighting_watts":
        w = _f(params, "watts", 0) or 0
        h = _f(params, "hours_saved", 0) or 0
        rate = _f(params, "electric_rate_per_kwh", 0) or 0
        kwh = (w / 1000.0) * h
        cost = kwh * rate
        peak_kw = w / 1000.0

    if not math.isfinite(kwh):
        kwh = 0.0
    if not math.isfinite(therms):
        therms = 0.0
    if not math.isfinite(cost):
        cost = 0.0

    if calc_type == "oa_heating_sensible":
        out["annual_kwh_saved"] = None
        out["annual_therms_saved"] = round(therms, 6) if therms else None
    elif calc_type == "simultaneous_hydronic_btu":
        assign_s = str(params.get("assign_to") or "electric_chiller")
        if assign_s == "gas_boiler":
            out["annual_kwh_saved"] = None
            out["annual_therms_saved"] = round(therms, 6) if therms else None
        else:
            out["annual_kwh_saved"] = round(kwh, 4) if kwh else None
            out["annual_therms_saved"] = None
    else:
        out["annual_kwh_saved"] = round(kwh, 4) if kwh else None
        out["annual_therms_saved"] = round(therms, 6) if therms else None

    out["annual_cost_saved_usd"] = round(cost, 2) if cost else None
    out["peak_kw_reduced"] = round(peak_kw, 4) if peak_kw is not None and peak_kw > 0 else None
    out["confidence_score"] = 3
    if calc_type == "vfd_affinity_cube" and _f(params, "p_full_kw"):
        out["confidence_score"] = 4
    elif calc_type == "motor_hp_runtime" and _f(params, "motor_hp"):
        out["confidence_score"] = 4

    return out


def list_calc_types_public() -> list[dict[str, Any]]:
    """Ordered list for API / UI."""
    order = list(CALC_TYPE_SPECS.keys())
    return [
        {"id": k, **{kk: vv for kk, vv in CALC_TYPE_SPECS[k].items() if kk != "fields"}, "fields": CALC_TYPE_SPECS[k]["fields"]}
        for k in order
    ]
