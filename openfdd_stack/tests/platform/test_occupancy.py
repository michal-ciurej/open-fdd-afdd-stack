"""Tests for occupancy schedule helpers - mask alignment, tz/DST, hours."""

from datetime import time

import pandas as pd

from openfdd_stack.platform.occupancy import (
    occupied_hours_per_year,
    occupied_mask,
    weekly_core_hours,
)


def _mon_fri_7_to_19(tz: str = "Europe/London") -> list[dict]:
    return [
        {"dow": d, "start_local": time(7, 0), "end_local": time(19, 0), "tz": tz}
        for d in range(0, 5)  # Mon..Fri
    ]


def test_mask_in_and_out_of_core_hours_utc():
    # 2024-01-01 is a Monday. Index in UTC; schedule in UTC so local == UTC.
    sched = _mon_fri_7_to_19(tz="UTC")
    idx = pd.to_datetime(
        [
            "2024-01-01 06:59:00",  # Mon, just before open -> out
            "2024-01-01 07:00:00",  # Mon, open edge -> in
            "2024-01-01 12:00:00",  # Mon, midday -> in
            "2024-01-01 19:00:00",  # Mon, close edge is exclusive -> out
            "2024-01-06 12:00:00",  # Saturday -> out
        ],
        utc=True,
    )
    mask = occupied_mask(idx, sched)
    assert list(mask) == [False, True, True, False, False]
    assert mask.index.equals(idx)


def test_mask_respects_local_tz_offset():
    # London in January is UTC+0, so a 07:00 local window opens at 07:00 UTC.
    # In July it's UTC+1, so the same local window opens at 06:00 UTC.
    sched = _mon_fri_7_to_19(tz="Europe/London")
    # 2024-07-01 is a Monday (BST, UTC+1).
    idx = pd.to_datetime(
        [
            "2024-07-01 05:59:00",  # 06:59 local -> out
            "2024-07-01 06:00:00",  # 07:00 local -> in
        ],
        utc=True,
    )
    mask = occupied_mask(idx, sched)
    assert list(mask) == [False, True]


def test_mask_naive_index_treated_as_utc():
    sched = _mon_fri_7_to_19(tz="UTC")
    idx = pd.to_datetime(["2024-01-01 08:00:00", "2024-01-01 20:00:00"])
    assert idx.tz is None
    mask = occupied_mask(idx, sched)
    assert list(mask) == [True, False]


def test_no_schedule_is_all_in_hours():
    idx = pd.to_datetime(["2024-01-01 03:00:00", "2024-01-06 23:00:00"], utc=True)
    mask = occupied_mask(idx, [])
    assert mask.all()


def test_empty_index_returns_empty_bool_series():
    mask = occupied_mask(pd.DatetimeIndex([]), _mon_fri_7_to_19())
    assert len(mask) == 0
    assert mask.dtype == bool


def test_weekly_and_annual_hours():
    sched = _mon_fri_7_to_19()
    # 5 days * 12 h = 60 h/week.
    assert weekly_core_hours(sched) == 60.0
    annual = occupied_hours_per_year(sched)
    # ~60 * 52.18 ≈ 3130 h/yr.
    assert 3100 < annual < 3160
