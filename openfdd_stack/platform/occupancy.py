"""Core-occupancy schedule helpers.

The per-site weekly operating schedule lives in ``site_schedules`` (7 rows max,
keyed by ISO day-of-week 0=Mon..6=Sun, with tz-aware local start/end windows).
This module turns those rows into things the analytics layer needs:

  * :func:`occupied_mask` — a boolean ``pandas.Series`` aligned to a timeseries
    DataFrame's timestamp index, ``True`` where the sample falls inside core
    hours. This is what lets a DataFrame decide "in-hours vs out-of-hours" for
    fault finding and energy profiling.
  * :func:`occupied_hours_per_year` — the annualised core-hours scalar derived
    from the weekly windows, so the energy calc resolver can keep consuming a
    single ``occupied_hours_per_year`` number while the source of truth becomes
    the schedule.

Timestamps are stored UTC. Windows are LOCAL wall-clock in each row's ``tz``;
conversion is DST-aware via ``zoneinfo`` (an improvement over the rule engine's
naive ``params.schedule`` path, which compares UTC hours to local hour bounds).

This module is pure where it matters: the mask/hours functions take plain rows
so tests pass dicts. :func:`load_site_schedule` is the thin DB accessor.
"""

from __future__ import annotations

from datetime import time
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

# Average days per year, spread across the 7-day week, for annualising weekly
# core hours. Uses 365.25 to amortise leap years; the small DST drift (±1h per
# clock change) is immaterial at an annual-estimate granularity.
_DAYS_PER_YEAR = 365.25


def _seconds_of_day(t: time) -> int:
    return t.hour * 3600 + t.minute * 60 + t.second


def occupied_mask(
    index: pd.DatetimeIndex | Sequence[Any],
    schedule_rows: Sequence[Mapping[str, Any]],
) -> pd.Series:
    """Boolean Series (``True`` = inside core hours) aligned to ``index``.

    ``index`` is a timeseries index in UTC (tz-aware, or naive treated as UTC).
    ``schedule_rows`` are ``site_schedules`` rows: each a mapping with ``dow``
    (0=Mon..6=Sun), ``start_local``/``end_local`` (``datetime.time``), ``tz``.

    With no schedule rows, every sample is considered in-core-hours — matching
    the compliance default ("treat all hours as in-hours until configured") so
    derived metrics stay meaningful rather than collapsing to zero.
    """
    idx = pd.DatetimeIndex(index)
    if len(idx) == 0:
        return pd.Series([], index=idx, dtype=bool)
    if not schedule_rows:
        return pd.Series(True, index=idx)

    # Normalise to UTC-aware so per-tz conversion is well defined.
    idx_utc = idx.tz_localize("UTC") if idx.tz is None else idx.tz_convert("UTC")

    result = np.zeros(len(idx), dtype=bool)
    # Cache the local (dow, seconds-of-day) projection per tz — most sites use a
    # single tz across all 7 rows, so this converts once.
    local_cache: dict[str, tuple[np.ndarray, np.ndarray]] = {}

    for row in schedule_rows:
        tz_name = row.get("tz") or "UTC"
        if tz_name not in local_cache:
            try:
                tz = ZoneInfo(tz_name)
            except Exception:
                tz = ZoneInfo("UTC")
            local = idx_utc.tz_convert(tz)
            dow = np.asarray(local.weekday)  # Monday=0..Sunday=6
            tod = np.asarray(
                local.hour * 3600 + local.minute * 60 + local.second
            )
            local_cache[tz_name] = (dow, tod)
        dow, tod = local_cache[tz_name]

        start_sec = _seconds_of_day(row["start_local"])
        end_sec = _seconds_of_day(row["end_local"])
        sel = (dow == int(row["dow"])) & (tod >= start_sec) & (tod < end_sec)
        result |= sel

    return pd.Series(result, index=idx)


def weekly_core_hours(schedule_rows: Sequence[Mapping[str, Any]]) -> float:
    """Total core hours in one week, summed across the configured day windows."""
    total = 0.0
    for row in schedule_rows:
        span = _seconds_of_day(row["end_local"]) - _seconds_of_day(row["start_local"])
        if span > 0:
            total += span / 3600.0
    return total


def occupied_hours_per_year(schedule_rows: Sequence[Mapping[str, Any]]) -> float:
    """Annualised core hours derived from the weekly schedule.

    Lets the energy calc resolver keep consuming a single
    ``occupied_hours_per_year`` scalar while the schedule becomes the source of
    truth. An estimate: ``weekly_hours * (365.25 / 7)``.
    """
    return weekly_core_hours(schedule_rows) * (_DAYS_PER_YEAR / 7.0)


def load_site_schedule(site_id: str) -> list[dict]:
    """Fetch a site's weekly schedule rows (``[]`` if none configured).

    Returned rows match what :func:`occupied_mask` expects:
    ``dow`` (int), ``start_local``/``end_local`` (``datetime.time``), ``tz``.
    """
    from openfdd_stack.platform.database import get_conn

    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT dow, start_local, end_local, tz "
                "FROM site_schedules WHERE site_id = %s ORDER BY dow",
                (site_id,),
            )
            return [dict(r) for r in cur.fetchall()]
