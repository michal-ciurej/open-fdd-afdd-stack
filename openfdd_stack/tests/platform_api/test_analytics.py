"""Analytics API tests (GET /analytics/fault-summary, /analytics/fault-timeseries)."""

from datetime import date, datetime
from unittest.mock import MagicMock, patch
from fastapi.testclient import TestClient

from openfdd_stack.platform.api.main import app
from openfdd_stack.platform import fault_scoring

client = TestClient(app)


def test_fault_summary_returns_shape():
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = [
            {"fault_id": "fc1", "count": 10, "flag_sum": 10},
            {"fault_id": "fc2", "count": 2, "flag_sum": 2},
        ]
        cur.fetchone.return_value = {"n": 2}
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            "/analytics/fault-summary?start_date=2025-01-01&end_date=2025-01-07"
        )
    assert r.status_code == 200
    data = r.json()
    assert (
        "period" in data
        and "by_fault_id" in data
        and "total_faults" in data
        and "active_in_period" in data
    )
    assert data["total_faults"] == 12
    assert data["active_in_period"] == 2
    assert len(data["by_fault_id"]) == 2


def test_fault_summary_404_unknown_site():
    with patch("openfdd_stack.platform.api.analytics.resolve_site_uuid", return_value=None):
        r = client.get(
            "/analytics/fault-summary?site_id=nosuch&start_date=2025-01-01&end_date=2025-01-07"
        )
    assert r.status_code == 404


def test_fault_timeseries_returns_shape():
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = [
            {"time": datetime(2025, 1, 1, 12, 0), "metric": "fc1", "value": 1.0},
            {"time": datetime(2025, 1, 1, 13, 0), "metric": "fc1", "value": 0.0},
        ]
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            "/analytics/fault-timeseries?start_date=2025-01-01&end_date=2025-01-07&bucket=hour"
        )
    assert r.status_code == 200
    data = r.json()
    assert "period" in data and "bucket" in data and "series" in data
    assert data["bucket"] == "hour"
    assert len(data["series"]) == 2
    assert data["series"][0]["metric"] == "fc1" and data["series"][0]["value"] == 1.0


def test_fault_timeseries_invalid_bucket_rejected():
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = []
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            "/analytics/fault-timeseries?start_date=2025-01-01&end_date=2025-01-07&bucket=invalid"
        )
    assert r.status_code == 422


def test_fault_timeseries_equipment_ids_adds_sql_filter():
    """Plots page passes equipment_ids so aggregates are not site-wide for a single device."""
    eq = "550e8400-e29b-41d4-a716-446655440000"
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = []
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            f"/analytics/fault-timeseries?start_date=2025-01-01&end_date=2025-01-07&bucket=hour"
            f"&equipment_ids={eq}"
        )
    assert r.status_code == 200
    assert r.json()["equipment_ids"] == [eq]
    cur.execute.assert_called_once()
    sql, params = cur.execute.call_args[0]
    assert "fr.equipment_id IN" in sql
    assert eq in params


def test_fault_timeseries_raw_bucket_uses_native_resolution_sql():
    """Issues page requests bucket=raw: one point per evaluated timestamp,
    deduped across overlapping FDD runs via COUNT(DISTINCT equipment_id)."""
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = [
            {"time": datetime(2025, 1, 1, 12, 0), "metric": "fc1", "value": 2.0},
        ]
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            "/analytics/fault-timeseries?start_date=2025-01-01&end_date=2025-01-07&bucket=raw"
        )
    assert r.status_code == 200
    data = r.json()
    assert data["bucket"] == "raw"
    assert data["series"][0]["value"] == 2.0
    cur.execute.assert_called_once()
    sql, params = cur.execute.call_args[0]
    # Native resolution: no date_trunc; dedupe across runs; only flagged rows.
    assert "date_trunc" not in sql
    assert "COUNT(DISTINCT fr.equipment_id)" in sql
    assert "fr.flag_value > 0" in sql
    assert "GROUP BY fr.ts" in sql
    # The raw branch must NOT prepend the bucket token to the SQL params.
    assert "raw" not in params
    assert params[0] == date(2025, 1, 1)


def test_system_host_empty_when_no_table():
    with patch("openfdd_stack.platform.api.analytics._table_exists", return_value=False):
        r = client.get("/analytics/system/host")
    assert r.status_code == 200
    assert r.json()["hosts"] == []


def test_system_containers_empty_when_no_table():
    with patch("openfdd_stack.platform.api.analytics._table_exists", return_value=False):
        r = client.get("/analytics/system/containers")
    assert r.status_code == 200
    assert r.json()["containers"] == []


def test_system_disk_empty_when_no_table():
    with patch("openfdd_stack.platform.api.analytics._table_exists", return_value=False):
        r = client.get("/analytics/system/disk")
    assert r.status_code == 200
    assert r.json()["disks"] == []


def test_container_logs_invalid_ref_rejected():
    r = client.get("/analytics/system/containers/bad!name/logs?follow=false")
    assert r.status_code == 400


def test_container_logs_snapshot_when_docker_mocked():
    fake_container = MagicMock()
    fake_container.logs.return_value = b"2025-01-01T00:00:00 line one\n"
    fake_client = MagicMock()
    fake_client.containers.get.return_value = fake_container
    with patch(
        "openfdd_stack.platform.api.analytics._docker_client", return_value=fake_client
    ):
        r = client.get("/analytics/system/containers/openfdd_api/logs?follow=false&tail=50")
    assert r.status_code == 200
    assert r.text == "2025-01-01T00:00:00 line one\n"
    fake_client.containers.get.assert_called_once_with("openfdd_api")
    fake_container.logs.assert_called_once_with(
        stream=False, tail=50, timestamps=True
    )


def test_container_logs_snapshot_404_when_not_found():
    DockerNotFound = type("NotFound", (Exception,), {})
    DockerNotFound.__module__ = "docker.errors"

    fake_client = MagicMock()
    fake_client.containers.get.side_effect = DockerNotFound("nope")
    with patch(
        "openfdd_stack.platform.api.analytics._docker_client", return_value=fake_client
    ):
        r = client.get("/analytics/system/containers/missing/logs?follow=false")
    assert r.status_code == 404


def test_container_logs_snapshot_503_when_no_docker():
    with patch("openfdd_stack.platform.api.analytics._docker_client", return_value=None):
        r = client.get("/analytics/system/containers/foo/logs?follow=false")
    assert r.status_code == 503


# --- Equipment attention score --------------------------------------------


def test_scoring_formula_and_bands():
    """Locked spec: weight critical=10/high=5/warning=2, score = sum(weight x persistence),
    attention if serious fault persists >= 40% OR score >= 8; degraded if score >= 2."""
    ahu3 = [
        {"severity": "critical", "persistence": 0.82},
        {"severity": "warning", "persistence": 0.50},
        {"severity": "warning", "persistence": 0.30},
    ]
    assert fault_scoring.equipment_score(ahu3) == 9.8
    assert fault_scoring.band(9.8, ahu3) == "attention"

    # A high-severity fault that persists >= 40% escalates on its own (low score).
    ahu1 = [{"severity": "high", "persistence": 0.71}]
    assert fault_scoring.band(fault_scoring.equipment_score(ahu1), ahu1) == "attention"

    # A persistent warning alone stays degraded, not attention.
    rtu5 = [{"severity": "warning", "persistence": 0.55}, {"severity": "warning", "persistence": 0.45}]
    assert fault_scoring.equipment_score(rtu5) == 2.0
    assert fault_scoring.band(2.0, rtu5) == "degraded"

    # Below the degraded floor with no serious fault -> healthy.
    healthy = [{"severity": "warning", "persistence": 0.30}]
    assert fault_scoring.band(fault_scoring.equipment_score(healthy), healthy) == "healthy"

    # Unknown severity falls back to the warning weight (2).
    assert fault_scoring.weight_for("nonsense") == fault_scoring.DEFAULT_WEIGHT


def test_scoring_trend_slope():
    assert fault_scoring.trend([0.2, 0.4, 0.6, 0.8]) == "worsening"
    assert fault_scoring.trend([0.8, 0.6, 0.4, 0.2]) == "improving"
    assert fault_scoring.trend([0.5, 0.52, 0.48, 0.5]) == "stable"
    assert fault_scoring.trend([0.9, 0.1]) == "stable"  # too few points to call


def _attention_row(bucket, flagged, total, is_active=True):
    return {
        "site_id": "site-1",
        "equipment_id": "AHU-9",
        "equipment_uuid": "11111111-1111-1111-1111-111111111111",
        "equipment_name": "AHU-9",
        "equipment_type": "Air_Handling_Unit",
        "fault_id": "fc1",
        "fault_name": "Freeze-protection risk",
        "fault_severity": "critical",
        "fault_category": "safety",
        "bucket": bucket,
        "total_ts": total,
        "flagged_ts": flagged,
        "first_ts": datetime(2025, 1, 1, 0, 0),
        "last_ts": datetime(2025, 1, 6, 0, 0),
        "is_active": is_active,
    }


def test_equipment_attention_returns_ranked_shape():
    rows = [
        _attention_row(datetime(2025, 1, 1), 8, 10),
        _attention_row(datetime(2025, 1, 2), 8, 10),
        _attention_row(datetime(2025, 1, 3), 8, 10),
    ]
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = rows
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            "/analytics/equipment-attention?start_date=2025-01-01&end_date=2025-01-07"
        )
    assert r.status_code == 200
    data = r.json()
    assert set(data["bands"]) == {"attention", "degraded", "healthy", "evaluated"}
    assert data["bands"]["attention"] == 1
    assert data["critical_active"] == 1
    unit = data["equipment"][0]
    # persistence 24/30 = 0.8, critical weight 10 -> score 8.0 -> attention band
    assert unit["score"] == 8.0
    assert unit["band"] == "attention"
    assert unit["dominant"]["severity"] == "critical"
    assert unit["dominant"]["persistence"] == 0.8
    assert data["worst_system"]["label"] == "Air Handling Unit"


def test_equipment_attention_persistence_sql_dedupes_runs():
    """Persistence must use COUNT(DISTINCT ts) (flagged FILTER + total) so the
    append-only overlap between FDD runs does not inflate the denominator."""
    with patch("openfdd_stack.platform.api.analytics.get_conn") as mock_conn:
        conn = MagicMock()
        cur = MagicMock()
        cur.fetchall.return_value = []
        conn.cursor.return_value.__enter__ = MagicMock(return_value=cur)
        conn.cursor.return_value.__exit__ = MagicMock(return_value=None)
        conn.__enter__ = MagicMock(return_value=conn)
        conn.__exit__ = MagicMock(return_value=None)
        mock_conn.return_value = conn

        r = client.get(
            "/analytics/equipment-attention?start_date=2025-01-01&end_date=2025-01-07"
        )
    assert r.status_code == 200
    sql, _params = cur.execute.call_args[0]
    assert "COUNT(DISTINCT fr.ts)" in sql
    assert "FILTER (WHERE fr.flag_value = 1)" in sql
    assert "date_trunc(%s, fr.ts)" in sql


def test_equipment_attention_404_unknown_site():
    with patch("openfdd_stack.platform.api.analytics.resolve_site_uuid", return_value=None):
        r = client.get(
            "/analytics/equipment-attention?site_id=nosuch&start_date=2025-01-01&end_date=2025-01-07"
        )
    assert r.status_code == 404
