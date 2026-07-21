"""Unit tests for the equipment-by-equipment poll batching helpers.

The live poller groups an endpoint's polling points into one bounded BQL request
per equipment (scoped to that equipment's folder subtree) instead of fanning a
broad scan across the whole station. These tests pin that grouping logic; they
are pure (no DB / no HTTP).
"""

from openfdd_stack.platform.drivers.niagara import (
    _common_ancestor_ord,
    _parse_bql_html_scan,
    _poll_batches,
    parse_niagara_poll_value,
)

_S = "slot:/Drivers/BacnetNetwork"
_FULL = "local:|station:|" + _S  # how nav ORDs arrive from a scan


def _pt(nav_ord, equipment_id=None, equipment_name=None):
    return {
        "niagara_nav_ord": nav_ord,
        "equipment_id": equipment_id,
        "equipment_name": equipment_name,
    }


def test_common_ancestor_same_folder():
    assert (
        _common_ancestor_ord([f"{_S}/FCU14/points", f"{_S}/FCU14/points"])
        == f"{_S}/FCU14/points"
    )


def test_common_ancestor_collapses_to_equipment_folder():
    # Points split across /points and /alarms -> the shared equipment folder.
    assert (
        _common_ancestor_ord([f"{_S}/FCU14/points", f"{_S}/FCU14/alarms"])
        == f"{_S}/FCU14"
    )


def test_common_ancestor_single_and_empty():
    assert _common_ancestor_ord([f"{_S}/FCU14/points"]) == f"{_S}/FCU14/points"
    assert _common_ancestor_ord([]) is None
    assert _common_ancestor_ord(["local:|station:|nope"]) is None  # no slot: prefix


def test_poll_batches_one_request_per_equipment():
    points = [
        _pt(f"{_FULL}/FCU14/points/RaTemp", "eq-14", "FCU-14"),
        _pt(f"{_FULL}/FCU14/points/RaSet", "eq-14", "FCU-14"),
        _pt(f"{_FULL}/FCU15/points/Sa", "eq-15", "FCU-15"),
        _pt(f"{_FULL}/FCU15/alarms/HiT", "eq-15", "FCU-15"),  # forces collapse to /FCU15
    ]
    batches = _poll_batches(points)
    by_label = {label: (folder, len(pts)) for folder, label, pts in batches}

    # Exactly one request per equipment.
    assert len(batches) == 2
    assert by_label["FCU-14"] == (f"{_S}/FCU14/points", 2)
    assert by_label["FCU-15"] == (f"{_S}/FCU15", 2)


def test_poll_batches_unassigned_points_fall_back_to_folder():
    points = [
        _pt(f"{_FULL}/FCU14/points/RaTemp", "eq-14", "FCU-14"),
        _pt(f"{_FULL}/Orphan/points/X", None, None),  # no equipment_id
    ]
    batches = _poll_batches(points)
    labels = {label for _, label, _ in batches}

    assert "FCU-14" in labels
    assert "(unassigned)" in labels
    unassigned = next(b for b in batches if b[1] == "(unassigned)")
    assert unassigned[0] == f"{_S}/Orphan/points"
    assert len(unassigned[2]) == 1


# --- HTML parser: the poll query adds a Value column the scan parser must keep ---

_POLL_HTML = """<html><body><table>
<tr><th>Device</th><th>PointLocation</th><th>Point</th><th>Value</th><th>Tags</th></tr>
<tr><td>FCU14</td><td>slot:/x/RaTemp</td><td>RaTemp</td><td>21.50 &#176;C {ok} @ def</td><td>n:history</td></tr>
<tr><td>FCU14</td><td>slot:/x/Fan</td><td>Fan</td><td>1 {ok}</td><td></td></tr>
<tr><td>FCU14</td><td>slot:/x/Down</td><td>Down</td><td>--- {down}</td><td></td></tr>
</table></body></html>"""

_SCAN_HTML = """<table>
<tr><th>Device</th><th>PointLocation</th><th>Point</th><th>Tags</th></tr>
<tr><td>FCU14</td><td>slot:/x/RaTemp</td><td>RaTemp</td><td>n:history</td></tr>
</table>"""


def test_parse_bql_captures_value_on_poll_response():
    rows = _parse_bql_html_scan(_POLL_HTML)
    assert [r["value"] for r in rows] == ["21.50 °C {ok} @ def", "1 {ok}", "--- {down}"]
    # ...and those values parse to numbers the poller can insert (down sensor skipped).
    parsed = [parse_niagara_poll_value(r["value"]) for r in rows]
    inserted = [v for v, s in parsed if v is not None and s == "ok"]
    assert inserted == [21.5, 1.0]


def test_parse_bql_scan_response_has_no_value_but_still_parses():
    rows = _parse_bql_html_scan(_SCAN_HTML)
    assert len(rows) == 1
    assert rows[0]["value"] is None
    assert rows[0]["point_location"] == "slot:/x/RaTemp"
