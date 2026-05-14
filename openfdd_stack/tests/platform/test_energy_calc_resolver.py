"""Tests for the energy_calc_resolver — hydration priority and data_quality."""

from openfdd_stack.platform.energy_calc_resolver import (
    compute_opportunity_result,
    resolve_calc_inputs,
)


def test_delta_params_win_over_profile_and_rates():
    """Operator's delta_params override should win for the same key."""
    params, quality = resolve_calc_inputs(
        calc_type="runtime_electric_kw",
        delta_params={"kw": 99, "hours_fault": 100, "electric_rate_per_kwh": 0.20},
        profile={"nameplate_kw": 50},
        rates={"electric_rate_per_kwh": 0.12},
    )
    assert params["kw"] == 99
    assert params["hours_fault"] == 100
    assert params["electric_rate_per_kwh"] == 0.20
    assert quality["kw"] == "partial"
    assert quality["hours_fault"] == "partial"


def test_profile_fills_in_missing_keys():
    """When delta_params doesn't have a key, profile column is used."""
    params, quality = resolve_calc_inputs(
        calc_type="runtime_electric_kw",
        delta_params={"hours_fault": 100},
        profile={"nameplate_kw": 25.0},
        rates={"electric_rate_per_kwh": 0.10},
    )
    assert params["kw"] == 25.0
    assert quality["kw"] == "partial"  # came from profile
    assert quality["electric_rate_per_kwh"] == "partial"  # came from rates


def test_observed_evidence_beats_profile():
    """Observed values from fault evidence should beat profile defaults."""
    params, quality = resolve_calc_inputs(
        calc_type="ahu_sat_sensible_waste",
        delta_params={"hours": 1000},
        profile={"design_cfm": 10000, "design_sat_f": 65, "design_cop": 3.5},
        rates={"electric_rate_per_kwh": 0.12},
        observed_evidence={"sat_actual_f": 53.0},
    )
    assert params["sat_actual_f"] == 53.0
    assert quality["sat_actual_f"] == "observed"
    assert params["cfm"] == 10000
    assert quality["cfm"] == "partial"


def test_observed_hours_used_when_no_delta_override():
    """Trailing fault-hours channel kicks in when delta_params doesn't pin hours."""
    params, quality = resolve_calc_inputs(
        calc_type="runtime_electric_kw",
        delta_params={},
        profile={"nameplate_kw": 5, "occupied_hours_per_year": 2600},
        rates={"electric_rate_per_kwh": 0.12},
        observed_hours=1420.0,
    )
    assert params["hours_fault"] == 1420.0
    assert quality["hours_fault"] == "observed"


def test_spec_default_marked_assumed():
    """When no upstream source provides a value, spec default → 'assumed'."""
    params, quality = resolve_calc_inputs(
        calc_type="motor_hp_runtime",
        delta_params={"motor_hp": 25, "hours_fault": 100},
        profile={},
        rates={"electric_rate_per_kwh": 0.12},
    )
    # load_factor and motor_efficiency have spec defaults
    assert params["load_factor"] == 0.8
    assert quality["load_factor"] == "assumed"
    assert params["motor_efficiency"] == 0.9
    assert quality["motor_efficiency"] == "assumed"


def test_overall_quality_is_worst_field():
    """Overall data_quality = the worst (lowest-rank) input quality used."""
    result = compute_opportunity_result(
        calc_type="motor_hp_runtime",
        delta_params={"motor_hp": 25, "hours_fault": 100},
        capex_usd=0,
        profile={},
        rates={"electric_rate_per_kwh": 0.12},
    )
    # load_factor and motor_efficiency fall back to spec defaults → 'assumed'
    assert result["data_quality"] == "assumed"


def test_unknown_calc_type_returns_empty_params():
    params, quality = resolve_calc_inputs(
        calc_type="not_a_real_calc",
        delta_params={"x": 1},
        profile={},
        rates={},
    )
    assert params == {}
    assert quality == {}


def test_compute_runtime_electric_kw_known_value():
    """Reference golden value for the simplest formula."""
    result = compute_opportunity_result(
        calc_type="runtime_electric_kw",
        delta_params={"kw": 10, "hours_fault": 100},
        capex_usd=500,
        profile={},
        rates={"electric_rate_per_kwh": 0.12},
    )
    assert result["annual_kwh_saved"] == 1000.0
    assert result["annual_savings_usd"] == 120.0
    assert result["baseline_annual_cost_usd"] == 120.0
    assert result["projected_annual_cost_usd"] == 0.0
    # capex 500 / savings 120 = 4.167 yr
    assert abs(result["simple_payback_years"] - 4.1667) < 0.01
    # NPV 5 yr at 0% discount: 5*120 - 500 = 100
    assert result["npv_5yr_usd"] == 100.0


def test_simple_payback_zero_when_no_capex():
    result = compute_opportunity_result(
        calc_type="runtime_electric_kw",
        delta_params={"kw": 10, "hours_fault": 100},
        capex_usd=0,
        profile={},
        rates={"electric_rate_per_kwh": 0.12},
    )
    assert result["simple_payback_years"] == 0.0


def test_simple_payback_none_when_no_savings():
    """Missing inputs → no savings → no payback."""
    result = compute_opportunity_result(
        calc_type="runtime_electric_kw",
        delta_params={},
        capex_usd=500,
        profile={},
        rates={},
    )
    assert result["simple_payback_years"] is None
    assert result["data_quality"] in ("assumed", "partial")


def test_profile_design_cfm_routes_to_calc_cfm():
    """design_cfm in the profile populates several calc keys (cfm, cfm_excess, cfm_oa)."""
    for calc_type, key in [
        ("ahu_sat_sensible_waste", "cfm"),
        ("oa_heating_sensible", "cfm_excess"),
        ("enthalpy_wheel_proxy", "cfm_oa"),
    ]:
        params, _ = resolve_calc_inputs(
            calc_type=calc_type,
            delta_params={},
            profile={"design_cfm": 12000},
            rates={"electric_rate_per_kwh": 0.12, "therm_rate_usd": 1.0},
        )
        assert params[key] == 12000, f"expected design_cfm to populate {key}"
