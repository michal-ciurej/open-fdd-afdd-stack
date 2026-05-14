"""Tests for phase 3 wiring: observed-channel helpers, recompute module,
auto-seed hook. All DB calls mocked — these are unit tests, not integration."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import MagicMock, patch
from uuid import uuid4

from openfdd_stack.platform import energy_auto_seed, energy_observed, energy_recompute


def _conn(fetchone_side_effect=None, fetchall_side_effect=None, rowcount=0):
    cursor = MagicMock()
    cursor.execute.return_value = None
    cursor.rowcount = rowcount
    if fetchone_side_effect is not None:
        cursor.fetchone.side_effect = fetchone_side_effect
    if fetchall_side_effect is not None:
        cursor.fetchall.side_effect = fetchall_side_effect
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=None)
    conn.cursor.return_value.__enter__ = MagicMock(return_value=cursor)
    conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
    conn.commit = MagicMock()
    return conn, cursor


# ---------- energy_observed ----------


def test_trailing_fault_hours_converts_seconds():
    conn, _ = _conn(fetchone_side_effect=[{"seconds": 3600.0 * 1420}])
    with patch.object(energy_observed, "get_conn", return_value=conn):
        hours = energy_observed.trailing_fault_hours(
            equipment_id=str(uuid4()), fault_id="rule_x", days=365
        )
    assert hours == 1420.0


def test_trailing_fault_hours_returns_zero_when_no_rows():
    conn, _ = _conn(fetchone_side_effect=[{"seconds": None}])
    with patch.object(energy_observed, "get_conn", return_value=conn):
        hours = energy_observed.trailing_fault_hours(
            equipment_id=str(uuid4()), fault_id="rule_x"
        )
    assert hours == 0.0


def test_latest_evidence_returns_dict():
    conn, _ = _conn(
        fetchone_side_effect=[{"evidence": {"sat_actual_f": 53.0, "duct_dp_inwc": 2.8}}]
    )
    with patch.object(energy_observed, "get_conn", return_value=conn):
        ev = energy_observed.latest_evidence(
            equipment_id=str(uuid4()), fault_id="rule_x"
        )
    assert ev == {"sat_actual_f": 53.0, "duct_dp_inwc": 2.8}


def test_latest_evidence_none_when_no_row():
    conn, _ = _conn(fetchone_side_effect=[None])
    with patch.object(energy_observed, "get_conn", return_value=conn):
        ev = energy_observed.latest_evidence(
            equipment_id=str(uuid4()), fault_id="rule_x"
        )
    assert ev is None


# ---------- energy_recompute ----------


def test_recompute_opportunity_pulls_observed_when_rule_linked():
    opp_id = uuid4()
    eq_id = uuid4()
    site_id = uuid4()

    # fetchone sequence:
    #   1. SELECT opportunity row (in recompute_opportunity)
    #   2. _lookup_site_id_for_equipment
    #   3. _load_profile_row
    #   4. _load_rates_row
    fetch_seq = [
        {
            "id": opp_id,
            "equipment_id": eq_id,
            "calc_type": "runtime_electric_kw",
            "fdd_rule_id": "chiller_no_load_flag",
            "delta_params": {"kw": 10},
            "capex_usd": 500,
            "enabled": True,
        },
        {"site_id": site_id},
        {"nameplate_kw": None, "motor_hp": None},
        {
            "electric_rate_per_kwh": 0.20,
            "demand_charge_per_kw": 0,
            "therm_rate_usd": 1.0,
            "currency": "GBP",
        },
    ]
    conn, cur = _conn(fetchone_side_effect=fetch_seq)

    with (
        patch.object(energy_recompute, "get_conn", return_value=conn),
        patch.object(
            energy_recompute, "trailing_fault_hours", return_value=1420.0
        ) as m_hours,
        patch.object(
            energy_recompute, "latest_evidence", return_value={"sat_actual_f": 53.0}
        ) as m_ev,
        patch.object(energy_recompute, "emit") as m_emit,
    ):
        result = energy_recompute.recompute_opportunity(opp_id)

    assert result is not None
    # 10 kW × 1420 h × £0.20 = £2,840
    assert result["annual_savings_usd"] == 2840.0
    assert result["fault_hours_observed"] == 1420.0
    # Quality is 'observed' because hours came from the observed channel; rate
    # is 'partial' from rates table; kw 'partial' from delta. Worst = partial.
    assert result["data_quality"] == "partial"
    m_hours.assert_called_once()
    m_ev.assert_called_once()
    m_emit.assert_called_once()


def test_recompute_opportunity_skips_observed_when_no_rule():
    opp_id = uuid4()
    eq_id = uuid4()
    fetch_seq = [
        {
            "id": opp_id,
            "equipment_id": eq_id,
            "calc_type": "runtime_electric_kw",
            "fdd_rule_id": None,
            "delta_params": {"kw": 10, "hours_fault": 100},
            "capex_usd": 0,
            "enabled": True,
        },
        {"site_id": uuid4()},
        {},
        {
            "electric_rate_per_kwh": 0.12,
            "demand_charge_per_kw": 0,
            "therm_rate_usd": 1.0,
            "currency": "GBP",
        },
    ]
    conn, _ = _conn(fetchone_side_effect=fetch_seq)
    with (
        patch.object(energy_recompute, "get_conn", return_value=conn),
        patch.object(energy_recompute, "trailing_fault_hours") as m_hours,
        patch.object(energy_recompute, "latest_evidence") as m_ev,
        patch.object(energy_recompute, "emit"),
    ):
        result = energy_recompute.recompute_opportunity(opp_id)
    assert result is not None
    # Observed helpers never called when fdd_rule_id is None.
    m_hours.assert_not_called()
    m_ev.assert_not_called()


def test_recompute_opportunity_unknown_calc_type_skipped():
    opp_id = uuid4()
    conn, _ = _conn(
        fetchone_side_effect=[
            {
                "id": opp_id,
                "equipment_id": uuid4(),
                "calc_type": "not_a_real_calc",
                "fdd_rule_id": None,
                "delta_params": {},
                "capex_usd": 0,
                "enabled": True,
            }
        ]
    )
    with (
        patch.object(energy_recompute, "get_conn", return_value=conn),
        patch.object(energy_recompute, "emit"),
    ):
        result = energy_recompute.recompute_opportunity(opp_id)
    assert result is None


def test_recompute_opportunity_missing_row_returns_none():
    conn, _ = _conn(fetchone_side_effect=[None])
    with (
        patch.object(energy_recompute, "get_conn", return_value=conn),
        patch.object(energy_recompute, "emit"),
    ):
        result = energy_recompute.recompute_opportunity(uuid4())
    assert result is None


# ---------- energy_auto_seed ----------


def _result(equipment_id: str, fault_id: str, flag: int = 1):
    return SimpleNamespace(
        equipment_id=equipment_id,
        fault_id=fault_id,
        flag_value=flag,
        ts=datetime.now(timezone.utc),
        evidence={},
        site_id="any",
    )


def test_auto_seed_inserts_disabled_opportunity_for_new_pair():
    eq_id = str(uuid4())
    fault_id = "chiller_no_load_flag"
    results = [_result(eq_id, fault_id)]

    conn, cur = _conn(
        fetchall_side_effect=[
            [  # fault_definitions SELECT
                {
                    "fault_id": fault_id,
                    "name": "Chiller no load",
                    "params": {
                        "default_calc_type": "runtime_electric_kw",
                        "default_measure_family": "runtime",
                        "default_delta_params": {"kw": 25},
                    },
                }
            ],
            [],  # existing opportunities (none)
        ],
        rowcount=1,
    )
    with patch.object(energy_auto_seed, "get_conn", return_value=conn):
        with patch.object(energy_auto_seed, "execute_values") as m_exec:
            n = energy_auto_seed.auto_seed_from_results(results)

    assert n == 1
    assert m_exec.called
    inserted_rows = m_exec.call_args[0][2]
    assert len(inserted_rows) == 1
    eq, ext_id, name, _desc, family, calc_type, fid, _delta, _cap, enabled = inserted_rows[0]
    assert eq == eq_id
    assert fid == fault_id
    assert family == "runtime"
    assert calc_type == "runtime_electric_kw"
    assert enabled is False  # review-before-enable
    assert ext_id.startswith("auto_")


def test_auto_seed_skips_when_fault_definition_has_no_hints():
    eq_id = str(uuid4())
    fault_id = "rule_without_hints"
    results = [_result(eq_id, fault_id)]
    conn, _ = _conn(
        fetchall_side_effect=[
            [{"fault_id": fault_id, "name": "x", "params": {"foo": "bar"}}],
            [],
        ]
    )
    with patch.object(energy_auto_seed, "get_conn", return_value=conn):
        with patch.object(energy_auto_seed, "execute_values") as m_exec:
            n = energy_auto_seed.auto_seed_from_results(results)
    assert n == 0
    m_exec.assert_not_called()


def test_auto_seed_skips_when_opportunity_already_exists():
    eq_id = str(uuid4())
    fault_id = "chiller_no_load_flag"
    results = [_result(eq_id, fault_id)]
    conn, _ = _conn(
        fetchall_side_effect=[
            [
                {
                    "fault_id": fault_id,
                    "name": "x",
                    "params": {
                        "default_calc_type": "runtime_electric_kw",
                        "default_measure_family": "runtime",
                    },
                }
            ],
            [{"equipment_id": eq_id, "fdd_rule_id": fault_id}],  # already linked
        ]
    )
    with patch.object(energy_auto_seed, "get_conn", return_value=conn):
        with patch.object(energy_auto_seed, "execute_values") as m_exec:
            n = energy_auto_seed.auto_seed_from_results(results)
    assert n == 0
    m_exec.assert_not_called()


def test_auto_seed_skips_site_level_fallback_rows():
    # equipment_id="MainCampus" is not a UUID — would be a site-name fallback
    # from the FDD loop; auto-seed is equipment-scoped only.
    results = [_result("MainCampus", "chiller_no_load_flag")]
    # No DB calls expected because the input filter rejects this row.
    with patch.object(energy_auto_seed, "get_conn") as m_get_conn:
        n = energy_auto_seed.auto_seed_from_results(results)
    assert n == 0
    m_get_conn.assert_not_called()


def test_auto_seed_skips_flag_zero_results():
    eq_id = str(uuid4())
    results = [_result(eq_id, "rule_x", flag=0)]
    with patch.object(energy_auto_seed, "get_conn") as m_get_conn:
        n = energy_auto_seed.auto_seed_from_results(results)
    assert n == 0
    m_get_conn.assert_not_called()


def test_auto_seed_skips_invalid_calc_type():
    eq_id = str(uuid4())
    fault_id = "rule_with_bad_hint"
    results = [_result(eq_id, fault_id)]
    conn, _ = _conn(
        fetchall_side_effect=[
            [
                {
                    "fault_id": fault_id,
                    "name": "x",
                    "params": {
                        "default_calc_type": "not_a_real_calc",
                        "default_measure_family": "runtime",
                    },
                }
            ],
            [],
        ]
    )
    with patch.object(energy_auto_seed, "get_conn", return_value=conn):
        with patch.object(energy_auto_seed, "execute_values") as m_exec:
            n = energy_auto_seed.auto_seed_from_results(results)
    assert n == 0
    m_exec.assert_not_called()
