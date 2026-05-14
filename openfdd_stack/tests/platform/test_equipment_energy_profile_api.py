"""Tests for /equipment/{equipment_id}/energy-profile (mock DB)."""

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


def _profile_conn(fetchone_side_effect):
    cursor = MagicMock()
    cursor.execute.return_value = None
    cursor.fetchone.side_effect = fetchone_side_effect
    conn = MagicMock()
    conn.__enter__ = MagicMock(return_value=conn)
    conn.__exit__ = MagicMock(return_value=None)
    conn.cursor.return_value.__enter__ = MagicMock(return_value=cursor)
    conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
    conn.commit = MagicMock()
    return conn


def _profile_row(equipment_id, **overrides):
    base = {
        "equipment_id": equipment_id,
        "nameplate_kw": None,
        "motor_hp": None,
        "motor_efficiency": None,
        "design_cfm": None,
        "design_sat_f": None,
        "design_static_pressure_inwc": None,
        "design_cop": None,
        "design_heating_efficiency": None,
        "occupied_hours_per_year": None,
        "updated_at": datetime.now(timezone.utc),
    }
    base.update(overrides)
    return base


def test_get_returns_existing_profile(client):
    equipment_id = uuid4()
    site_id = uuid4()
    row = _profile_row(equipment_id, design_cfm=10000.0, motor_hp=25.0)
    conn = _profile_conn(fetchone_side_effect=[{"site_id": site_id}, row])
    with patch(
        "openfdd_stack.platform.api.equipment_energy_profile.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/equipment/{equipment_id}/energy-profile")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["design_cfm"] == 10000.0
    assert body["motor_hp"] == 25.0


def test_get_creates_default_row_when_missing(client):
    equipment_id = uuid4()
    site_id = uuid4()
    conn = _profile_conn(
        fetchone_side_effect=[{"site_id": site_id}, None, _profile_row(equipment_id)]
    )
    with patch(
        "openfdd_stack.platform.api.equipment_energy_profile.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/equipment/{equipment_id}/energy-profile")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["nameplate_kw"] is None
    assert body["design_cfm"] is None


def test_get_unknown_equipment_returns_404(client):
    equipment_id = uuid4()
    conn = _profile_conn(fetchone_side_effect=[None])
    with patch(
        "openfdd_stack.platform.api.equipment_energy_profile.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/equipment/{equipment_id}/energy-profile")
    assert r.status_code == 404


def test_put_upserts_partial_payload(client):
    equipment_id = uuid4()
    site_id = uuid4()
    updated = _profile_row(
        equipment_id,
        design_cfm=12000.0,
        motor_hp=30.0,
        motor_efficiency=0.92,
    )
    conn = _profile_conn(fetchone_side_effect=[{"site_id": site_id}, updated])
    with patch(
        "openfdd_stack.platform.api.equipment_energy_profile.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.put(
            f"/api/equipment/{equipment_id}/energy-profile",
            json={
                "design_cfm": 12000,
                "motor_hp": 30,
                "motor_efficiency": 0.92,
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["design_cfm"] == 12000.0
    assert body["motor_efficiency"] == 0.92


def test_put_explicit_null_clears_value(client):
    equipment_id = uuid4()
    site_id = uuid4()
    cleared = _profile_row(equipment_id, design_cfm=None)
    conn = _profile_conn(fetchone_side_effect=[{"site_id": site_id}, cleared])
    with patch(
        "openfdd_stack.platform.api.equipment_energy_profile.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.put(
            f"/api/equipment/{equipment_id}/energy-profile",
            json={"design_cfm": None},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["design_cfm"] is None


def test_put_rejects_invalid_motor_efficiency(client):
    equipment_id = uuid4()
    r = client.put(
        f"/api/equipment/{equipment_id}/energy-profile",
        json={"motor_efficiency": 1.5},
    )
    assert r.status_code == 422


def test_put_rejects_negative_design_cfm(client):
    equipment_id = uuid4()
    r = client.put(
        f"/api/equipment/{equipment_id}/energy-profile",
        json={"design_cfm": -100},
    )
    assert r.status_code == 422
