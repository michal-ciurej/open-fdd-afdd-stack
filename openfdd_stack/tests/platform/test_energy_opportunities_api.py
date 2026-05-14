"""Tests for /energy-opportunities CRUD + preview (mock DB)."""

from datetime import datetime, timezone
from unittest.mock import MagicMock, patch
from uuid import uuid4

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("httpx")
from fastapi.testclient import TestClient

from openfdd_stack.platform.api.main import app


_API_KEY = "test-machine-key"


@pytest.fixture
def client():
    settings_mock = MagicMock()
    settings_mock.api_key = _API_KEY
    settings_mock.swa_ingress_secret = ""
    with patch(
        "openfdd_stack.platform.api.auth_principal.get_platform_settings",
        return_value=settings_mock,
    ):
        c = TestClient(app)
        c.headers["Authorization"] = f"Bearer {_API_KEY}"
        yield c


def _opp_conn(fetchone_side_effect=None, fetchall_value=None):
    cursor = MagicMock()
    cursor.execute.return_value = None
    if fetchone_side_effect is not None:
        cursor.fetchone.side_effect = fetchone_side_effect
    if fetchall_value is not None:
        cursor.fetchall.return_value = fetchall_value
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=None)
    conn.cursor.return_value.__enter__ = MagicMock(return_value=cursor)
    conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
    conn.commit = MagicMock()
    return conn


def _equipment_row(equipment_id, site_id):
    return {
        "id": equipment_id,
        "site_id": site_id,
        "name": "AHU-03",
        "equipment_type": "Air_Handling_Unit",
    }


def _opp_row(opp_id, equipment_id, **overrides):
    base = {
        "id": opp_id,
        "equipment_id": equipment_id,
        "external_id": "sat_reset",
        "name": "SAT reset",
        "description": None,
        "measure_family": "setpoint_reset",
        "calc_type": "runtime_electric_kw",
        "fdd_rule_id": None,
        "delta_params": {"kw": 10, "hours_fault": 100},
        "capex_usd": 500,
        "enabled": True,
        "created_at": datetime.now(timezone.utc),
        "updated_at": datetime.now(timezone.utc),
    }
    base.update(overrides)
    return base


def _result_row(**overrides):
    base = {
        "baseline_annual_cost_usd": 120.0,
        "projected_annual_cost_usd": 0.0,
        "annual_savings_usd": 120.0,
        "annual_kwh_saved": 1000.0,
        "annual_therms_saved": None,
        "peak_kw_reduced": 10.0,
        "simple_payback_years": 4.1667,
        "npv_5yr_usd": 100.0,
        "fault_hours_observed": None,
        "data_quality": "partial",
        "missing_inputs": [],
        "notes": "test",
        "computed_at": datetime.now(timezone.utc),
    }
    base.update(overrides)
    return base


def test_list_requires_scope(client):
    r = client.get("/api/energy-opportunities")
    assert r.status_code == 400


def test_list_by_equipment_empty(client):
    equipment_id = uuid4()
    site_id = uuid4()
    conn = _opp_conn(
        fetchone_side_effect=[_equipment_row(equipment_id, site_id)],
        fetchall_value=[],
    )
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/energy-opportunities?equipment_id={equipment_id}")
    assert r.status_code == 200, r.text
    assert r.json() == []


def test_create_then_returns_with_result(client):
    equipment_id = uuid4()
    site_id = uuid4()
    opp_id = uuid4()
    opp = _opp_row(opp_id, equipment_id)
    result = _result_row()
    conn = _opp_conn(
        fetchone_side_effect=[
            _equipment_row(equipment_id, site_id),  # _load_equipment
            None,  # uniqueness check returns no existing row
            opp,  # INSERT RETURNING
            {},  # _load_profile (empty)
            {  # _load_rates
                "electric_rate_per_kwh": 0.12,
                "demand_charge_per_kw": 0.0,
                "therm_rate_usd": 1.0,
                "currency": "USD",
            },
            result,  # _compute_and_upsert_result RETURNING
        ]
    )
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.post(
            "/api/energy-opportunities",
            json={
                "equipment_id": str(equipment_id),
                "external_id": "sat_reset",
                "name": "SAT reset",
                "measure_family": "setpoint_reset",
                "calc_type": "runtime_electric_kw",
                "delta_params": {"kw": 10, "hours_fault": 100},
                "capex_usd": 500,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["external_id"] == "sat_reset"
    assert body["result"]["annual_savings_usd"] == 120.0
    assert body["result"]["data_quality"] == "partial"


def test_create_rejects_duplicate_external_id(client):
    equipment_id = uuid4()
    site_id = uuid4()
    conn = _opp_conn(
        fetchone_side_effect=[
            _equipment_row(equipment_id, site_id),
            {"id": uuid4()},  # uniqueness check finds an existing row
        ]
    )
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.post(
            "/api/energy-opportunities",
            json={
                "equipment_id": str(equipment_id),
                "external_id": "sat_reset",
                "name": "SAT reset",
                "measure_family": "setpoint_reset",
                "calc_type": "runtime_electric_kw",
            },
        )
    assert r.status_code == 409


def test_create_rejects_unknown_calc_type(client):
    equipment_id = uuid4()
    r = client.post(
        "/api/energy-opportunities",
        json={
            "equipment_id": str(equipment_id),
            "external_id": "x",
            "name": "x",
            "measure_family": "runtime",
            "calc_type": "not_a_real_calc",
        },
    )
    assert r.status_code == 400


def test_create_rejects_invalid_measure_family(client):
    equipment_id = uuid4()
    r = client.post(
        "/api/energy-opportunities",
        json={
            "equipment_id": str(equipment_id),
            "external_id": "x",
            "name": "x",
            "measure_family": "not_a_family",
            "calc_type": "runtime_electric_kw",
        },
    )
    assert r.status_code == 422


def test_patch_recomputes_on_save(client):
    equipment_id = uuid4()
    site_id = uuid4()
    opp_id = uuid4()
    existing = _opp_row(opp_id, equipment_id)
    updated = _opp_row(opp_id, equipment_id, capex_usd=1000)
    result = _result_row(simple_payback_years=8.33)
    conn = _opp_conn(
        fetchone_side_effect=[
            existing,  # SELECT existing
            _equipment_row(equipment_id, site_id),
            updated,  # UPDATE RETURNING
            {},  # _load_profile
            {  # _load_rates
                "electric_rate_per_kwh": 0.12,
                "demand_charge_per_kw": 0.0,
                "therm_rate_usd": 1.0,
                "currency": "USD",
            },
            result,
        ]
    )
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.patch(
            f"/api/energy-opportunities/{opp_id}",
            json={"capex_usd": 1000},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["capex_usd"] == 1000.0
    # Result has been recomputed and embedded.
    assert body["result"]["simple_payback_years"] == 8.33


def test_preview_unsaved_opportunity(client):
    equipment_id = uuid4()
    site_id = uuid4()
    conn = _opp_conn(
        fetchone_side_effect=[
            _equipment_row(equipment_id, site_id),
            {},  # profile
            {
                "electric_rate_per_kwh": 0.12,
                "demand_charge_per_kw": 0.0,
                "therm_rate_usd": 1.0,
                "currency": "USD",
            },
        ]
    )
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.post(
            "/api/energy-opportunities/preview",
            json={
                "equipment_id": str(equipment_id),
                "calc_type": "runtime_electric_kw",
                "delta_params": {"kw": 10, "hours_fault": 100},
                "capex_usd": 500,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["annual_savings_usd"] == 120.0
    assert abs(body["simple_payback_years"] - 4.1667) < 0.01


def test_delete_opportunity(client):
    opp_id = uuid4()
    equipment_id = uuid4()
    site_id = uuid4()
    conn = _opp_conn(
        fetchone_side_effect=[
            {"equipment_id": equipment_id},  # SELECT equipment_id
            _equipment_row(equipment_id, site_id),  # _load_equipment
            {"id": opp_id},  # DELETE returning
        ]
    )
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.delete(f"/api/energy-opportunities/{opp_id}")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "deleted"


def test_get_unknown_opportunity_returns_404(client):
    opp_id = uuid4()
    conn = _opp_conn(fetchone_side_effect=[None])
    with patch(
        "openfdd_stack.platform.api.energy_opportunities.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/energy-opportunities/{opp_id}")
    assert r.status_code == 404
