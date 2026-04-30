"""Per-equipment column_map must not collide across equipments."""

from __future__ import annotations

from unittest.mock import patch

from openfdd_stack.platform.equipment_column_map import build_equipment_column_map


class _FakeCursor:
    def __init__(self, rows):
        self._rows = rows
        self.executed = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def execute(self, query, params=None):
        self.executed.append((query, params))

    def fetchall(self):
        return list(self._rows)


class _FakeConn:
    def __init__(self, rows):
        self._rows = rows

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def cursor(self):
        return _FakeCursor(self._rows)


def test_build_equipment_column_map_scopes_by_equipment_id():
    """
    Two different equipments can share the same Brick class + fdd_input without collisions
    because we build the map scoped to the equipment_id.
    """
    eq1_rows = [
        {
            "external_id": "eq1/zone_temp",
            "brick_type": "Zone_Air_Temperature_Sensor",
            "fdd_input": "space_temperature",
        }
    ]
    eq2_rows = [
        {
            "external_id": "eq2/zone_temp",
            "brick_type": "Zone_Air_Temperature_Sensor",
            "fdd_input": "space_temperature",
        }
    ]

    with patch(
        "openfdd_stack.platform.equipment_column_map.get_conn",
        return_value=_FakeConn(eq1_rows),
    ):
        m1 = build_equipment_column_map(site_id="site", equipment_id="eq1")
    with patch(
        "openfdd_stack.platform.equipment_column_map.get_conn",
        return_value=_FakeConn(eq2_rows),
    ):
        m2 = build_equipment_column_map(site_id="site", equipment_id="eq2")

    # Disambiguated key (BrickClass|fdd_input) is safe across equipments.
    assert (
        m1["Zone_Air_Temperature_Sensor"] == "eq1/zone_temp"
        or m1["Zone_Air_Temperature_Sensor|space_temperature"] == "eq1/zone_temp"
    )
    assert (
        m2["Zone_Air_Temperature_Sensor"] == "eq2/zone_temp"
        or m2["Zone_Air_Temperature_Sensor|space_temperature"] == "eq2/zone_temp"
    )

    # And the common alias should map within each equipment.
    assert m1.get("space_temperature") == "eq1/zone_temp"
    assert m2.get("space_temperature") == "eq2/zone_temp"


def test_build_equipment_column_map_disambiguates_within_equipment():
    """Within one equipment, multiple points of the same Brick class require fdd_input."""
    rows = [
        {
            "external_id": "eq/sensor_a",
            "brick_type": "Zone_Air_Temperature_Sensor",
            "fdd_input": "space_temperature",
        },
        {
            "external_id": "eq/sensor_b",
            "brick_type": "Zone_Air_Temperature_Sensor",
            "fdd_input": "space_temperature_2",
        },
    ]
    with patch(
        "openfdd_stack.platform.equipment_column_map.get_conn",
        return_value=_FakeConn(rows),
    ):
        m = build_equipment_column_map(site_id="site", equipment_id="eq")

    assert m["Zone_Air_Temperature_Sensor|space_temperature"] == "eq/sensor_a"
    assert m["Zone_Air_Temperature_Sensor|space_temperature_2"] == "eq/sensor_b"
    assert m["space_temperature"] == "eq/sensor_a"
    assert m["space_temperature_2"] == "eq/sensor_b"

