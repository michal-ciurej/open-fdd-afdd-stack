"""Tests for /sites/{site_id}/energy-rates (mock DB)."""

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
    """TestClient with API-key auth headers set globally for the session."""
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


def _rates_conn(fetchone_side_effect):
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


def _rates_row(site_id):
    return {
        "site_id": site_id,
        "electric_rate_per_kwh": 0.12,
        "demand_charge_per_kw": 0.0,
        "therm_rate_usd": 1.0,
        "currency": "USD",
        "updated_at": datetime.now(timezone.utc),
    }


def test_get_returns_existing_rates_row(client):
    site_id = uuid4()
    conn = _rates_conn(fetchone_side_effect=[{"id": site_id}, _rates_row(site_id)])
    with patch(
        "openfdd_stack.platform.api.energy_rates.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/sites/{site_id}/energy-rates")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["electric_rate_per_kwh"] == 0.12
    assert body["currency"] == "USD"


def test_get_creates_default_row_when_missing(client):
    site_id = uuid4()
    conn = _rates_conn(
        fetchone_side_effect=[{"id": site_id}, None, _rates_row(site_id)]
    )
    with patch(
        "openfdd_stack.platform.api.energy_rates.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/sites/{site_id}/energy-rates")
    assert r.status_code == 200, r.text


def test_get_unknown_site_returns_404(client):
    site_id = uuid4()
    conn = _rates_conn(fetchone_side_effect=[None])
    with patch(
        "openfdd_stack.platform.api.energy_rates.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.get(f"/api/sites/{site_id}/energy-rates")
    assert r.status_code == 404


def test_put_upserts_partial_payload(client):
    site_id = uuid4()
    updated = _rates_row(site_id)
    updated["electric_rate_per_kwh"] = 0.18
    updated["currency"] = "GBP"
    conn = _rates_conn(fetchone_side_effect=[{"id": site_id}, updated])
    with patch(
        "openfdd_stack.platform.api.energy_rates.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.put(
            f"/api/sites/{site_id}/energy-rates",
            json={"electric_rate_per_kwh": 0.18, "currency": "GBP"},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["electric_rate_per_kwh"] == 0.18
    assert body["currency"] == "GBP"


def test_put_rejects_negative_rate(client):
    site_id = uuid4()
    r = client.put(
        f"/api/sites/{site_id}/energy-rates",
        json={"electric_rate_per_kwh": -0.01},
    )
    assert r.status_code == 422


def test_put_empty_body_returns_current_row(client):
    site_id = uuid4()
    conn = _rates_conn(fetchone_side_effect=[{"id": site_id}, _rates_row(site_id)])
    with patch(
        "openfdd_stack.platform.api.energy_rates.get_conn",
        side_effect=lambda: conn,
    ):
        r = client.put(f"/api/sites/{site_id}/energy-rates", json={})
    assert r.status_code == 200, r.text
