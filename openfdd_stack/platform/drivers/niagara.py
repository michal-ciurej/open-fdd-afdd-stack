"""
Niagara 4 driver: scan station + fetch historical timeseries via ORD-embedded BQL.

Niagara's webapps servlet accepts ORD URLs with an embedded BQL pipe segment
and returns an HTML table. Two BQL shapes are used here:

1) Station scan (list all ControlPoints on the station):
   /ord/station:|slot:/Drivers|bql:select
     proxyExt.device.displayName as 'Device',
     navOrd as 'PointLocation',
     displayName as 'Point',
     vykonPro:Lib.tags() as 'Tags'
   from control:ControlPoint|view:?fullScreen=false

2) Per-history fetch:
   /ord/history:/<StationName>/<HistoryId>|bql:select timestamp, value
   from * where timestamp in bqltime.<window>

The driver:
  - Builds the ORD URL with proper encoding: spaces -> %20, ' -> %27, | -> %7C.
  - Keeps history: / intact (encoding the ":" in "history:" breaks the ORD).
  - Sends HTTP Basic Auth and follows redirects.
  - Parses the HTML table via the stdlib parser (no lxml / BeautifulSoup).
  - For scans: groups points into equipment by "folder twice removed" in the
    nav ORD (equipment = parent of the `points` folder), parses Haystack tags,
    reads the n:history tag as the point's history path.
  - For history: stores (ts, value) rows into timeseries_readings using
    ON CONFLICT DO NOTHING so re-runs are idempotent.

Per-site credentials live in `site_niagara_endpoints`; there is no global
"the Niagara" URL.
"""

from __future__ import annotations

import logging
import re
import time
import urllib.parse
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from typing import Any, Optional
from uuid import UUID

import requests
from psycopg2.extras import Json, execute_values

from openfdd_stack.platform.database import get_conn

logger = logging.getLogger("open_fdd.niagara")

_NIAGARA_TZ_ANNOTATION = re.compile(r"\[.*?\]")

# Niagara renders history timestamps in a locale format rather than ISO-8601
# when the BQL response is served via the webapps HTML table (e.g.
# "12-Apr-26 12:00:00 AM BST"). Map common UK/EU/US tz abbreviations → UTC
# offset in minutes so we can parse them deterministically.
_NIAGARA_TZ_OFFSETS_MIN: dict[str, int] = {
    "UTC": 0, "GMT": 0, "Z": 0,
    "BST": 60, "IST": 60, "WEST": 60,
    "CET": 60, "CEST": 120,
    "EET": 120, "EEST": 180,
    "EST": -300, "EDT": -240,
    "CST": -360, "CDT": -300,
    "MST": -420, "MDT": -360,
    "PST": -480, "PDT": -420,
}

# Locale-rendered timestamp formats Niagara may emit, tried in order.
_NIAGARA_TS_FORMATS: tuple[str, ...] = (
    "%d-%b-%y %I:%M:%S %p",   # 12-Apr-26 12:00:00 AM
    "%d-%b-%Y %I:%M:%S %p",   # 12-Apr-2026 12:00:00 AM
    "%d-%b-%y %H:%M:%S",      # 12-Apr-26 13:00:00
    "%d-%b-%Y %H:%M:%S",      # 12-Apr-2026 13:00:00
)

# Leading numeric (including sign / decimal / exponent) for values like
# "16.5 °C", "0.0 %", "-3.2e-4 kW". Anything after the number is treated as
# a unit suffix and discarded.
_NIAGARA_VAL_RE = re.compile(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?")

# Boolean histories (Niagara BooleanPoint) render their value as status text
# rather than a number - the configured trueText/falseText, e.g. "true"/"false",
# "On"/"Off", "Active"/"Inactive", "Occupied"/"Unoccupied". The timeseries value
# column is double precision, so we map these to 1.0/0.0 (mirroring the BACnet
# driver's _pv_to_float) instead of dropping the row. Matched case-insensitively
# after stripping; extend these sets to cover other facet texts as needed.
_NIAGARA_TRUE_TOKENS = frozenset({
    "true", "active", "on", "closed", "yes", "occupied", "enabled", "running",
})
_NIAGARA_FALSE_TOKENS = frozenset({
    "false", "inactive", "off", "open", "no", "unoccupied", "disabled", "stopped",
})

# Valid Niagara "bqltime" windows that a caller can pass to run_niagara_sync.
# The string is substituted directly into the BQL query (e.g. bqltime.lastweek).
# Niagara's bqltime keywords are lowercase (bqltime.lastweek, bqltime.weektodate);
# callers are normalised to lower case before lookup so any casing is accepted.
_VALID_BQL_WINDOWS = {
  "today",
  "yesterday",
  "lastweek",
  "thisweek",
  "weektodate",
  "lastmonth",
  "thismonth",
}


# ---------------------------------------------------------------------------
# HTML table parser (stdlib only)
# ---------------------------------------------------------------------------

class _BqlTableParser(HTMLParser):
    """Extract headers + rows from the first <table> in a Niagara BQL HTML response."""

    def __init__(self) -> None:
        super().__init__()
        self._in_table = False
        self._in_row = False
        self._in_cell = False
        self._cell_buf = ""
        self._current_row: list[str] = []
        self.headers: list[str] = []
        self.rows: list[list[str]] = []
        self._done = False

    def handle_starttag(self, tag: str, attrs) -> None:
        if self._done:
            return
        if tag == "table":
            self._in_table = True
        elif tag == "tr" and self._in_table:
            self._in_row = True
            self._current_row = []
        elif tag in ("th", "td") and self._in_row:
            self._in_cell = True
            self._cell_buf = ""

    def handle_endtag(self, tag: str) -> None:
        if self._done:
            return
        if tag == "table":
            self._in_table = False
            self._done = True
        elif tag == "tr" and self._in_row:
            self._in_row = False
            if self._current_row:
                if not self.headers:
                    self.headers = self._current_row
                else:
                    self.rows.append(self._current_row)
        elif tag in ("th", "td") and self._in_cell:
            self._in_cell = False
            self._current_row.append(self._cell_buf.strip())

    def handle_data(self, data: str) -> None:
        if self._in_cell:
            self._cell_buf += data

    def handle_entityref(self, name: str) -> None:
        _entities = {"amp": "&", "lt": "<", "gt": ">", "nbsp": " ", "quot": '"', "apos": "'"}
        if self._in_cell:
            self._cell_buf += _entities.get(name, "")

    def handle_charref(self, name: str) -> None:
        if self._in_cell:
            try:
                char = chr(int(name[1:], 16) if name.startswith("x") else int(name))
                self._cell_buf += char
            except (ValueError, OverflowError):
                pass


# ---------------------------------------------------------------------------
# ORD / BQL URL builder
# ---------------------------------------------------------------------------

def _encode_ord_url(base_url: str, ord_body: str) -> str:
    """
    Build a Niagara webapps ORD URL, encoding the pipe separators but preserving
    colons and slashes inside ORD segments (Niagara rejects %3A for `:`).

    The safe characters match what Workbench produces on the wire: `:/,=?&*`
    stay literal; spaces become %20, `'` becomes %27, `|` becomes %7C.
    """
    encoded = urllib.parse.quote(ord_body, safe=":/,=?&*")
    return f"{base_url.rstrip('/')}/ord/{encoded}"


_SCAN_BQL = (
    "select "
    "proxyExt.device.displayName as 'Device',"
    "navOrd as 'PointLocation',"
    "displayName as 'Point',"
    "vykonPro:Lib.tags() as 'Tags' "
    "from control:ControlPoint"
)


def _build_scan_url(base_url: str) -> str:
    """URL for the station-wide ControlPoint scan."""
    ord_body = f"station:|slot:/Drivers|bql:{_SCAN_BQL}|view:?fullScreen=true"
    return _encode_ord_url(base_url, ord_body)


# BQL for live-value polling. `out.value.toString` returns the ordinal for
# booleans (0/1) and enums (0/1/2/...) rather than a label, which lets rules
# treat everything as a number without an enum→float mapping. Numerics come
# through as their float value, with unit/status/priority trailing.
_POLL_BQL = (
    "select "
    "proxyExt.device.displayName as 'Device',"
    "navOrd as 'PointLocation',"
    "displayName as 'Point',"
    "out.value.toString as 'Value',"
    "vykonPro:Lib.tags() as 'Tags' "
    "from control:ControlPoint"
)


def _build_polling_url(base_url: str, folder_ord: str) -> str:
    """Live-value BQL scoped to one equipment-folder ORD.

    ``folder_ord`` looks like ``slot:/Drivers/BacnetNetwork/FS_29_ACE_FCU14/points``
    — derived at runtime from the polling points' ``niagara_nav_ord`` by
    :func:`_folder_ord_from_point_ord`. The URL is the same shape as the
    station-wide scan but restricted to that folder, so each JACE only encodes
    the live values of one equipment's points per request.
    """
    if not folder_ord.startswith("slot:"):
        raise ValueError(f"expected 'slot:' prefix on folder ORD, got {folder_ord!r}")
    ord_body = f"station:|{folder_ord}|bql:{_POLL_BQL}|view:?fullScreen=true"
    return _encode_ord_url(base_url, ord_body)


def _normalize_ord(o: Optional[str]) -> str:
    """Strip Niagara's optional ``local:|`` / ``station:|`` prefixes.

    Point ORDs come back from scans as ``local:|station:|slot:/…`` but are
    sometimes stored (or passed) without those prefixes. Normalize both sides
    to their ``slot:…`` tail before equality-comparing.
    """
    if not o:
        return ""
    for prefix in ("local:|", "station:|"):
        if o.startswith(prefix):
            o = o[len(prefix):]
    return o


def _folder_ord_from_point_ord(point_ord: Optional[str]) -> Optional[str]:
    """Compute the parent folder ORD of a point's ``niagara_nav_ord``.

    Given ``local:|station:|slot:/Drivers/BacnetNetwork/FS_29_ACE_FCU14/points/RaDeadband``
    returns ``slot:/Drivers/BacnetNetwork/FS_29_ACE_FCU14/points``.

    Grouping polling points by this key gives one BQL request per equipment
    folder — the JACE encodes only that folder's live values per request,
    avoiding the "encode everything at once" cost of a station-wide scan.
    """
    s = _normalize_ord(point_ord)
    if not s.startswith("slot:"):
        return None
    idx = s.rfind("/")
    return s[:idx] if idx > 0 else None


def _common_ancestor_ord(folder_ords: list[str]) -> Optional[str]:
    """Longest shared ``slot:`` folder ORD across the given folder ORDs.

    Used to scope one BQL request to a single equipment: the tightest folder that
    still contains every one of that equipment's point folders. Returns ``None``
    when the inputs share no ``slot:`` prefix.
    """
    folders = [f for f in folder_ords if f and f.startswith("slot:")]
    if not folders:
        return None
    common = folders[0].split("/")
    for f in folders[1:]:
        parts = f.split("/")
        i = 0
        while i < len(common) and i < len(parts) and common[i] == parts[i]:
            i += 1
        common = common[:i]
        if not common:
            return None
    folder = "/".join(common)
    return folder if folder.startswith("slot:") else None


def _poll_batches(points: list[dict]) -> list[tuple[str, str, list[dict]]]:
    """Split polling points into ``(query_folder_ord, label, points)`` batches so
    each station request is scoped to a single equipment.

    Points are grouped by ``equipment_id``; the request folder for a group is the
    common-ancestor folder of its points (one bounded BQL scan covers exactly
    that equipment's subtree). Points with no equipment fall back to their own
    parent folder, so nothing is silently dropped. Iterating the batches
    sequentially keeps only one equipment's worth of points in flight per
    request, instead of fanning a broad scan across the whole station.
    """
    by_equip: dict = {}
    unassigned: list[dict] = []
    for pt in points:
        eq = pt.get("equipment_id")
        if eq is None:
            unassigned.append(pt)
        else:
            by_equip.setdefault(eq, []).append(pt)

    batches: list[tuple[str, str, list[dict]]] = []
    for eq_id, eq_points in by_equip.items():
        label = eq_points[0].get("equipment_name") or str(eq_id)
        parent_folders = [
            _folder_ord_from_point_ord(p["niagara_nav_ord"]) for p in eq_points
        ]
        folder = _common_ancestor_ord([f for f in parent_folders if f])
        if folder:
            batches.append((folder, label, eq_points))
        else:
            logger.warning(
                "poll: equipment %s has no common slot folder; %d point(s) skipped",
                label, len(eq_points),
            )

    # Unassigned points keep the per-folder behaviour so they're still polled.
    by_folder: dict = {}
    for pt in unassigned:
        folder = _folder_ord_from_point_ord(pt["niagara_nav_ord"])
        if folder:
            by_folder.setdefault(folder, []).append(pt)
    for folder, pts in by_folder.items():
        batches.append((folder, "(unassigned)", pts))

    return batches


# `2.00 °C {ok} @ def`, `1 {ok} @ def` (bool), `78 % {ok} @ 8`, `--- {down}`, etc.
_POLL_VALUE_RE = re.compile(
    r"^\s*"
    r"(?P<val>[-+]?\d+(?:\.\d+)?)"        # numeric (int or float)
    r"[^\s{@]*"                            # optional unit token
    r"\s*"
    r"(?:\{(?P<status>[^}]*)\})?"          # optional {status}
    r".*$"                                  # ignore trailing @ priority etc.
)


def parse_niagara_poll_value(raw: Optional[str]) -> tuple[Optional[float], str]:
    """Parse a Niagara ``out.value.toString`` cell.

    Returns ``(value, status)``. ``status`` is lower-cased (``ok`` when the
    cell had no ``{...}`` marker at all). ``value`` is ``None`` if the cell
    doesn't start with a number (``---`` for downed sensors, unexpected text)
    — the caller is expected to skip DB writes in that case.

    With ``out.value.toString`` in the BQL, booleans arrive as ``1`` / ``0``
    and enums as their ordinal (``2``, ``3``, ...), so a single numeric parser
    covers every point type without an enum-to-float mapping.
    """
    if not raw:
        return (None, "empty")
    m = _POLL_VALUE_RE.match(raw)
    if not m:
        return (None, "unparseable")
    status = (m.group("status") or "ok").lower().strip()
    try:
        return (float(m.group("val")), status)
    except ValueError:
        return (None, status or "unparseable")


def _build_history_url(base_url: str, history_path: str, time_window: str) -> str:
    """
    URL for a per-history BQL fetch over a bqltime window.

    history_path example: /Finsbury_Circus_OS_B3/GF_CHW_Meter_Active_Energy
    Produces:
      {base}/ord/history:/Finsbury_Circus_OS_B3/GF_CHW_Meter_Active_Energy
            |bql:select timestamp,value from * where timestamp in bqltime.lastweek
            |view:?fullScreen=true

    The trailing `|view:?fullScreen=true` is required: without it Niagara serves
    a shell page that loads the table via JS, so the HTTP body has no <table>
    for our parser. fullScreen forces the pre-rendered table view.
    """
    # Niagara bqltime keywords are lowercase; accept any case from callers
    # (the config UI historically sent camelCase) and emit the lowercase form.
    window = (time_window or "").strip().lower()
    if window not in _VALID_BQL_WINDOWS:
        raise ValueError(
            f"Unsupported bqltime window '{time_window}'. Allowed: {sorted(_VALID_BQL_WINDOWS)}"
        )
    path = history_path if history_path.startswith("/") else f"/{history_path}"
    bql = f"select timestamp,value from * where timestamp in bqltime.{window}"
    ord_body = f"history:{path}|bql:{bql}|view:?fullScreen=true"
    return _encode_ord_url(base_url, ord_body)


# ---------------------------------------------------------------------------
# Tag + nav ORD helpers
# ---------------------------------------------------------------------------

_TAG_SPLIT = re.compile(r",\s*")


def _parse_tags(raw: str) -> dict[str, Any]:
    """
    Parse a Niagara/Haystack tag string into a dict.

    Examples:
      "h4:equip, h4:ahu, n:name=AHU_01, n:history=MyHistory"
      → {"h4:equip": True, "h4:ahu": True, "n:name": "AHU_01", "n:history": "MyHistory"}

    Rules:
      - Split the string on commas.
      - For each token, split on the FIRST `=` only (values can contain `=`).
      - A bare token (no `=`) is a marker tag: stored as True.
      - Keep the full `namespace:key` as the dict key so callers can look up
        `n:history`, `h4:equip`, etc. without ambiguity.
    """
    out: dict[str, Any] = {}
    if not raw:
        return out
    for token in _TAG_SPLIT.split(raw.strip()):
        token = token.strip()
        if not token:
            continue
        if "=" in token:
            key, _, val = token.partition("=")
            out[key.strip()] = val.strip()
        else:
            out[token] = True
    return out


def _equipment_from_nav_ord(nav_ord: str) -> Optional[str]:
    """
    Return the equipment name derived from a point's nav ORD.

    The convention used by the Niagara stations we target is that every point
    lives in a folder literally named `points`, whose parent is the device:

      local:|station:|slot:/Drivers/LonNetwork/Floor1/AHU_01/points/Heat
                                                       ^^^^^^  ^^^^^^
                                                       device  points folder

    So we find the last `/points/` segment and return the folder immediately
    before it. If the nav ORD doesn't match that shape, return None so the
    caller can fall back to the BQL `Device` column.
    """
    if not nav_ord:
        return None
    segments = nav_ord.split("/")
    for i in range(len(segments) - 1, 0, -1):
        if segments[i] == "points" and i - 1 >= 0:
            candidate = segments[i - 1].strip()
            if candidate:
                return candidate
    return None


# ---------------------------------------------------------------------------
# Timestamp / HTML parsing
# ---------------------------------------------------------------------------

def _parse_niagara_ts(raw: str) -> Optional[datetime]:
    """
    Parse a Niagara BQL timestamp cell into a UTC datetime.

    Handles two shapes the station may emit:
      1. ISO-8601 with an optional [Region/Zone] annotation, e.g.
         "2026-04-12T12:00:00+01:00[Europe/London]".
      2. Locale-rendered, e.g. "12-Apr-26 12:00:00 AM BST". Niagara uses this
         when the webapps servlet renders the BQL table as HTML; the trailing
         token is a timezone *abbreviation* which we resolve via
         _NIAGARA_TZ_OFFSETS_MIN. Unknown abbreviations fall back to UTC.
    """
    if not raw:
        return None
    cleaned = _NIAGARA_TZ_ANNOTATION.sub("", raw).strip()
    if not cleaned:
        return None

    # 1. ISO-8601 fast path.
    try:
        dt = datetime.fromisoformat(cleaned)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        pass

    # 2. Locale format. Split off a trailing alphabetic tz abbreviation
    #    (BST / GMT / EST / ...) so strptime only sees the date+time portion.
    parts = cleaned.split()
    tz_token: Optional[str] = None
    if len(parts) >= 2 and parts[-1].isalpha() and parts[-1].isupper():
        tz_token = parts[-1]
        body = " ".join(parts[:-1])
    else:
        body = cleaned

    parsed: Optional[datetime] = None
    for fmt in _NIAGARA_TS_FORMATS:
        try:
            parsed = datetime.strptime(body, fmt)
            break
        except ValueError:
            continue
    if parsed is None:
        return None

    if tz_token is None:
        tzinfo = timezone.utc
    else:
        offset_min = _NIAGARA_TZ_OFFSETS_MIN.get(tz_token)
        if offset_min is None:
            logger.warning(
                "[niagara.decode] unknown tz abbreviation %r in %r; assuming UTC",
                tz_token, raw,
            )
            tzinfo = timezone.utc
        else:
            tzinfo = timezone(timedelta(minutes=offset_min))

    return parsed.replace(tzinfo=tzinfo).astimezone(timezone.utc)


def _parse_niagara_value(raw: str) -> Optional[float]:
    """
    Parse a Niagara value cell into a float.

    Handles three shapes the station may emit:
      1. Numeric with an optional trailing display unit ("16.5 °C", "0.0 %",
         "1.23e-2 kW") - the first numeric literal is taken, the rest discarded.
      2. Boolean status text from BooleanPoint histories ("true"/"false",
         "On"/"Off", "Active"/"Inactive", ...) - mapped to 1.0/0.0 so binary
         histories land in the numeric value column instead of being dropped.
      3. Empty / unknown / non-numeric ("null", "{null}", multi-state enums) → None.
    """
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    # 1. Plain number fast path.
    try:
        return float(s)
    except ValueError:
        pass
    # 2. Boolean status text → 1.0 / 0.0. Checked before the numeric-literal
    #    regex because "true"/"off"/... carry no digit and would otherwise drop.
    token = s.lower()
    if token in _NIAGARA_TRUE_TOKENS:
        return 1.0
    if token in _NIAGARA_FALSE_TOKENS:
        return 0.0
    # 3. Leading numeric literal with a trailing unit ("16.5 °C").
    m = _NIAGARA_VAL_RE.search(s)
    if not m:
        return None
    try:
        return float(m.group(0))
    except ValueError:
        return None


def _parse_bql_html_history(html: str, history_path: str) -> list[tuple[datetime, float]]:
    """Parse a BQL history table into (ts_utc, value) tuples."""
    parser = _BqlTableParser()
    parser.feed(html)

    logger.info(
        "[niagara.decode] history=%s table_headers=%s raw_rows=%d",
        history_path, parser.headers, len(parser.rows),
    )

    if not parser.headers:
        logger.warning(
            "[niagara.decode] no <table> headers in BQL response history=%s html_snippet=%r",
            history_path, (html or "")[:400],
        )
        return []

    headers_lower = [h.lower().strip() for h in parser.headers]
    ts_idx = next(
        (i for i, h in enumerate(headers_lower) if "timestamp" in h or h == "time"),
        None,
    )
    val_idx = next(
        (i for i, h in enumerate(headers_lower) if h == "value" or "value" in h),
        None,
    )
    logger.info(
        "[niagara.decode] history=%s ts_idx=%s val_idx=%s",
        history_path, ts_idx, val_idx,
    )
    if ts_idx is None or val_idx is None:
        logger.warning(
            "[niagara.decode] cannot locate timestamp/value columns history=%s headers=%s",
            history_path, parser.headers,
        )
        return []

    records: list[tuple[datetime, float]] = []
    short_rows = bad_ts = bad_val = 0
    for row in parser.rows:
        if len(row) <= max(ts_idx, val_idx):
            short_rows += 1
            continue
        ts = _parse_niagara_ts(row[ts_idx])
        if ts is None:
            bad_ts += 1
            continue
        val = _parse_niagara_value(row[val_idx])
        if val is None:
            bad_val += 1
            continue
        records.append((ts, val))

    if records:
        logger.info(
            "[niagara.decode] history=%s kept=%d dropped(short=%d bad_ts=%d bad_val=%d) first=%s last=%s sample=%r",
            history_path, len(records), short_rows, bad_ts, bad_val,
            records[0][0].isoformat(), records[-1][0].isoformat(),
            (records[0], records[-1]),
        )
    else:
        logger.warning(
            "[niagara.decode] history=%s kept=0 dropped(short=%d bad_ts=%d bad_val=%d) sample_rows=%r",
            history_path, short_rows, bad_ts, bad_val, parser.rows[:3],
        )
    return records


def _parse_bql_html_scan(html: str) -> list[dict[str, Optional[str]]]:
    """
    Parse a Niagara BQL HTML table (station scan *or* live-value poll).

    Required columns (case-insensitive): Device, PointLocation, Point, Tags.
    The poll query additionally selects a ``Value`` column; it is captured under
    the ``value`` key when present and is ``None`` on scan responses (which don't
    select it). Returns one dict per row with normalised keys: device,
    point_location, point, tags, value.
    """
    parser = _BqlTableParser()
    parser.feed(html)

    if not parser.headers:
        logger.warning("Niagara scan returned no table")
        return []

    headers_norm = [h.lower().strip().replace(" ", "_") for h in parser.headers]
    def _find(*names: str) -> Optional[int]:
        for n in names:
            if n in headers_norm:
                return headers_norm.index(n)
        return None

    device_idx = _find("device")
    loc_idx = _find("pointlocation", "point_location")
    point_idx = _find("point")
    tags_idx = _find("tags")
    value_idx = _find("value")  # present on poll responses, absent on scans

    if None in (device_idx, loc_idx, point_idx, tags_idx):
        logger.warning(
            "Scan result missing expected columns. Got: %s", parser.headers
        )
        return []

    rows: list[dict[str, Optional[str]]] = []
    for row in parser.rows:
        if len(row) <= max(device_idx, loc_idx, point_idx, tags_idx):
            continue
        rows.append({
            "device": row[device_idx].strip(),
            "point_location": row[loc_idx].strip(),
            "point": row[point_idx].strip(),
            "tags": row[tags_idx].strip(),
            "value": (
                row[value_idx].strip()
                if value_idx is not None and value_idx < len(row)
                else None
            ),
        })
    return rows


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def _http_get(
    url: str,
    username: str,
    password: str,
    ssl_verify: bool,
    timeout: int,
) -> requests.Response:
    """GET with Basic auth; raises for network / auth failures."""
    logger.debug("Niagara GET %s", url)
    return requests.get(
        url,
        auth=(username, password),
        headers={"Accept": "text/html"},
        verify=ssl_verify,
        timeout=timeout,
        allow_redirects=True,
    )


def test_niagara_connection(
    base_url: str,
    username: str,
    password: str,
    ssl_verify: bool = True,
    timeout: int = 10,
) -> dict:
    """Ping the station scan URL and report whether auth + routing are OK."""
    url = _build_scan_url(base_url)
    try:
        resp = _http_get(url, username, password, ssl_verify, timeout)
        ok = resp.status_code not in (401, 403, 500, 502, 503, 504)
        return {"ok": ok, "status_code": resp.status_code, "error": None}
    except requests.exceptions.SSLError as exc:
        return {"ok": False, "status_code": None, "error": f"SSL error: {exc}"}
    except requests.exceptions.ConnectionError as exc:
        return {"ok": False, "status_code": None, "error": f"Connection error: {exc}"}
    except requests.exceptions.Timeout:
        return {"ok": False, "status_code": None, "error": f"Timeout after {timeout}s"}
    except Exception as exc:
        return {"ok": False, "status_code": None, "error": str(exc)}


def fetch_niagara_history(
    history_path: str,
    base_url: str,
    username: str,
    password: str,
    time_window: str = "lastweek",
    ssl_verify: bool = True,
    timeout: int = 30,
) -> list[tuple[datetime, float]]:
    """
    Query one Niagara history using an ORD-embedded bqltime window.

    time_window is a Niagara `bqltime.*` keyword (e.g. 'lastweek', 'today').
    """
    url = _build_history_url(base_url, history_path, time_window)
    logger.info("[niagara.fetch] GET history=%s window=%s url=%s", history_path, time_window, url)
    try:
        resp = _http_get(url, username, password, ssl_verify, timeout)
        body_len = len(resp.text or "")
        logger.info(
            "[niagara.fetch] status=%s body_bytes=%d history=%s",
            resp.status_code, body_len, history_path,
        )
        # Surface a small snippet on non-200 or suspiciously short bodies.
        if resp.status_code != 200 or body_len < 200:
            logger.warning(
                "[niagara.fetch] unexpected response history=%s snippet=%r",
                history_path, (resp.text or "")[:400],
            )
        resp.raise_for_status()
    except requests.exceptions.HTTPError as exc:
        logger.error(
            "[niagara.fetch] HTTP %s fetching history %s: %s",
            exc.response.status_code, history_path, exc,
        )
        return []
    except requests.exceptions.RequestException as exc:
        logger.error("[niagara.fetch] network error history=%s err=%s", history_path, exc)
        return []
    records = _parse_bql_html_history(resp.text, history_path)
    logger.info("[niagara.fetch] parsed_records=%d history=%s", len(records), history_path)
    return records


# ---------------------------------------------------------------------------
# DB: endpoint lookup + scan ingest + history ingest
# ---------------------------------------------------------------------------

def _get_endpoint(endpoint_id: str) -> Optional[dict]:
    """Load one Niagara endpoint row by its id."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, site_id, name, base_url, username, password,
                       ssl_verify, enabled
                FROM site_niagara_endpoints
                WHERE id = %s
                """,
                (endpoint_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def _list_endpoints_for_site(site_id: str, enabled_only: bool = False) -> list[dict]:
    """List Niagara endpoints for a site (UUID or name).

    Used by the API and the nightly runner to fan out across every endpoint a
    site owns. Pass enabled_only=True to skip disabled endpoints.
    """
    enabled_clause = "AND e.enabled = true" if enabled_only else ""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT e.id, e.site_id, e.name, e.base_url, e.username,
                       e.password, e.ssl_verify, e.enabled
                FROM site_niagara_endpoints e
                JOIN sites s ON s.id = e.site_id
                WHERE (s.id::text = %s OR s.name = %s) {enabled_clause}
                ORDER BY e.name
                """,
                (site_id, site_id),
            )
            return [dict(r) for r in cur.fetchall()]


def _upsert_equipment(cur, site_id: str, name: str) -> str:
    """Upsert equipment by (site_id, name); return its id.

    New rows get ``equipment_type='Equipment'`` (Brick 1.4 generic) instead of
    NULL. This keeps the TTL writer's ``a brick:{etype}`` valid out of the box,
    and lets the AI-assisted tagging workflow refine the class later. We do
    NOT overwrite an existing equipment_type - operators (or the LLM) may have
    already classified the row, and station scans should be idempotent.
    """
    cur.execute(
        """
        INSERT INTO equipment (site_id, name, equipment_type)
        VALUES (%s, %s, 'Equipment')
        ON CONFLICT (site_id, name) DO UPDATE SET name = EXCLUDED.name
        RETURNING id
        """,
        (site_id, name),
    )
    return str(cur.fetchone()["id"])


def _upsert_niagara_point(
    cur,
    site_id: str,
    equipment_id: str,
    external_id: str,
    niagara_nav_ord: str,
    niagara_tags: dict,
    niagara_history_path: Optional[str],
    description: Optional[str],
    object_name: Optional[str],
    niagara_endpoint_id: Optional[str] = None,
    iqvision_endpoint_id: Optional[str] = None,
) -> str:
    """Upsert a point by (site_id, external_id, endpoint_key); fills the Niagara
    metadata columns and records the owning station endpoint.

    `object_name` carries the BQL `Point` displayName so the data-model export
    surfaces a human-readable identifier alongside BACnet-discovered points.

    Exactly one of niagara_endpoint_id / iqvision_endpoint_id is set depending
    on which driver scanned the point. The generated `endpoint_key` column
    (see migration 033) means two controllers on one site that expose identical
    nav ORDs no longer collide on (site_id, external_id).
    """
    cur.execute(
        """
        INSERT INTO points (
            site_id, external_id, equipment_id, description, object_name,
            niagara_nav_ord, niagara_tags, niagara_history_path,
            niagara_endpoint_id, iqvision_endpoint_id
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT ON CONSTRAINT points_site_extid_endpoint_uq DO UPDATE SET
            equipment_id        = EXCLUDED.equipment_id,
            description         = COALESCE(EXCLUDED.description, points.description),
            object_name         = COALESCE(EXCLUDED.object_name, points.object_name),
            niagara_nav_ord     = EXCLUDED.niagara_nav_ord,
            niagara_tags        = EXCLUDED.niagara_tags,
            niagara_history_path = COALESCE(EXCLUDED.niagara_history_path, points.niagara_history_path),
            niagara_endpoint_id  = COALESCE(EXCLUDED.niagara_endpoint_id, points.niagara_endpoint_id),
            iqvision_endpoint_id = COALESCE(EXCLUDED.iqvision_endpoint_id, points.iqvision_endpoint_id)
        RETURNING id
        """,
        (
            site_id,
            external_id,
            equipment_id,
            description,
            object_name,
            niagara_nav_ord,
            Json(niagara_tags) if niagara_tags else None,
            niagara_history_path,
            niagara_endpoint_id,
            iqvision_endpoint_id,
        ),
    )
    return str(cur.fetchone()["id"])


def _store_readings(
    point_id: UUID,
    site_id: str,
    records: list[tuple[datetime, float]],
    cur,
) -> int:
    """Idempotent bulk insert into timeseries_readings."""
    if not records:
        logger.info(
            "[niagara.write] skip empty point_id=%s site_id=%s",
            point_id, site_id,
        )
        return 0
    rows = [(ts, site_id, str(point_id), val) for ts, val in records]
    first, last = records[0], records[-1]
    logger.info(
        "[niagara.write] INSERT attempt point_id=%s site_id=%s rows=%d first=(%s, %s) last=(%s, %s)",
        point_id, site_id, len(rows),
        first[0].isoformat(), first[1], last[0].isoformat(), last[1],
    )
    try:
        execute_values(
            cur,
            """
            INSERT INTO timeseries_readings (ts, site_id, point_id, value)
            VALUES %s
            ON CONFLICT (point_id, ts) DO NOTHING
            """,
            rows,
            page_size=1000,
        )
    except Exception:
        logger.exception(
            "[niagara.write] INSERT failed point_id=%s site_id=%s rows=%d",
            point_id, site_id, len(rows),
        )
        raise
    # rowcount reflects rows actually inserted after ON CONFLICT DO NOTHING.
    inserted = cur.rowcount if cur.rowcount is not None else -1
    logger.info(
        "[niagara.write] INSERT ok point_id=%s attempted=%d inserted=%d (duplicates skipped=%d)",
        point_id, len(rows), inserted, max(0, len(rows) - max(0, inserted)),
    )
    return len(rows)


def _get_niagara_points_for_endpoint(cur, endpoint_id: str) -> list[dict]:
    """Points discovered by this Niagara endpoint that carry a history path."""
    # Diagnostic: total points on the endpoint vs points with a history path.
    cur.execute(
        "SELECT count(*) AS n FROM points WHERE niagara_endpoint_id = %s",
        (endpoint_id,),
    )
    total = cur.fetchone()["n"]
    cur.execute(
        """
        SELECT count(*) AS n
        FROM points
        WHERE niagara_endpoint_id = %s
          AND niagara_history_path IS NOT NULL
          AND niagara_history_path <> ''
        """,
        (endpoint_id,),
    )
    with_hist = cur.fetchone()["n"]
    logger.info(
        "[niagara.select] endpoint=%s points_total=%d points_with_history_path=%d",
        endpoint_id, total, with_hist,
    )
    cur.execute(
        """
        SELECT id, site_id, external_id, niagara_history_path
        FROM points
        WHERE niagara_endpoint_id = %s
          AND niagara_history_path IS NOT NULL
          AND niagara_history_path <> ''
        ORDER BY niagara_history_path
        """,
        (endpoint_id,),
    )
    return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Station scan
# ---------------------------------------------------------------------------

def scan_niagara_station(endpoint_id: str) -> dict:
    """
    Run the ControlPoint BQL query against one Niagara endpoint, parse the HTML
    response, and upsert the equipment + points owned by that endpoint.

    Grouping:
      equipment = `nav_ord` folder twice removed (parent of `points` folder),
      falling back to the BQL Device column when the nav ORD doesn't match
      the `/<device>/points/<point>` convention.

    Returns a summary dict for UI / job results.
    """
    endpoint = _get_endpoint(endpoint_id)
    if not endpoint:
        return {
            "ok": False,
            "error": f"No Niagara endpoint {endpoint_id}",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }
    if not endpoint.get("enabled", True):
        return {
            "ok": False,
            "error": "Niagara endpoint is disabled",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }

    site_id = str(endpoint["site_id"])
    url = _build_scan_url(endpoint["base_url"])
    try:
        resp = _http_get(
            url,
            endpoint["username"],
            endpoint["password"],
            bool(endpoint["ssl_verify"]),
            timeout=60,
        )
        resp.raise_for_status()
    except requests.exceptions.RequestException as exc:
        logger.exception(
            "Niagara scan HTTP error for endpoint %s (site %s)", endpoint_id, site_id
        )
        return {
            "ok": False,
            "error": f"HTTP error: {exc}",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }

    rows = _parse_bql_html_scan(resp.text)
    logger.info(
        "Niagara scan: endpoint=%s site=%s parsed_rows=%d",
        endpoint_id, site_id, len(rows),
    )

    equipment_ids: dict[str, str] = {}
    points_upserted = 0

    with get_conn() as conn:
        with conn.cursor() as cur:
            for r in rows:
                nav_ord = r["point_location"]
                point_name = r["point"]
                device_fallback = r["device"]
                equip_name = _equipment_from_nav_ord(nav_ord) or device_fallback
                if not equip_name:
                    continue

                tags = _parse_tags(r["tags"])
                history_tag = tags.get("n:history")
                history_path = history_tag if isinstance(history_tag, str) else None

                # A point's external_id needs to be stable. Use the full nav ORD
                # - the most specific identifier the scan gives us, which
                # survives renaming of the displayName. Uniqueness across
                # controllers on one site is handled by endpoint_key, so the
                # nav ORD does not need to be globally unique on its own.
                external_id = nav_ord or f"{equip_name}/{point_name}"

                equip_id = equipment_ids.get(equip_name)
                if not equip_id:
                    equip_id = _upsert_equipment(cur, site_id, equip_name)
                    equipment_ids[equip_name] = equip_id

                _upsert_niagara_point(
                    cur,
                    site_id=site_id,
                    equipment_id=equip_id,
                    external_id=external_id,
                    niagara_nav_ord=nav_ord,
                    niagara_tags=tags,
                    niagara_history_path=history_path,
                    description=point_name or None,
                    object_name=point_name or None,
                    niagara_endpoint_id=endpoint["id"],
                )
                points_upserted += 1

            cur.execute(
                """
                UPDATE site_niagara_endpoints
                SET last_scan_ts = now(), updated_at = now()
                WHERE id = %s
                """,
                (endpoint_id,),
            )
        conn.commit()

    return {
        "ok": True,
        "rows_seen": len(rows),
        "points_upserted": points_upserted,
        "equipment_upserted": len(equipment_ids),
        "error": None,
    }


# ---------------------------------------------------------------------------
# Per-endpoint live-value polling
# ---------------------------------------------------------------------------
#
# One BQL request per equipment folder (parent of the polling points' navOrd),
# sequentially, with a per-endpoint politeness delay between requests. The JACE
# only encodes one equipment's live values per request, avoiding the CPU spike
# from a station-wide toString scan.
#
# Preconditions:
#   * migration 034 adds site_niagara_endpoints.poll_enabled + poll_equipment_delay_ms
#   * migration 035 adds niagara_poll_log for observability
#   * points.niagara_nav_ord (from 033) must be populated by the manual mapping
#     workflow; points.polling (from 011) gates each individual point.

def _load_polling_points_for_endpoint(endpoint_id: str) -> list[dict]:
    """Points on this endpoint that are opted in for live polling.

    Filters to points that carry a nav ORD (needed to build the polling URL and
    match response rows back to point ids) AND haven't had polling explicitly
    turned off. COALESCE(polling, true) preserves the pre-011 default. The
    equipment id + name come along so the poller can batch one bounded request
    per equipment (see :func:`_poll_batches`).
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT p.id, p.site_id, p.external_id, p.niagara_nav_ord,
                       p.equipment_id, e.name AS equipment_name
                FROM points p
                LEFT JOIN equipment e ON e.id = p.equipment_id
                WHERE p.niagara_endpoint_id = %s
                  AND p.niagara_nav_ord IS NOT NULL
                  AND COALESCE(p.polling, true) = true
                """,
                (endpoint_id,),
            )
            return [dict(r) for r in cur.fetchall()]


def _log_poll_row(
    *,
    endpoint_id: Optional[str],
    endpoint_name: Optional[str],
    site_id: Optional[str],
    folder_ord: Optional[str],
    status: str,
    rows_seen: int = 0,
    rows_inserted: int = 0,
    rows_unmatched: int = 0,
    duration_ms: Optional[int] = None,
    error: Optional[str] = None,
) -> None:
    """Best-effort insert into niagara_poll_log. Never raises."""
    try:
        with get_conn() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO niagara_poll_log (
                      endpoint_id, endpoint_name, site_id, folder_ord, status,
                      rows_seen, rows_inserted, rows_unmatched, duration_ms, error
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        endpoint_id, endpoint_name, site_id, folder_ord, status,
                        rows_seen, rows_inserted, rows_unmatched, duration_ms, error,
                    ),
                )
            conn.commit()
    except Exception:
        logger.exception("niagara_poll_log insert failed (endpoint=%s status=%s)", endpoint_id, status)


def poll_niagara_endpoint(endpoint_id: str, default_delay_ms: int, request_timeout_sec: int = 30) -> dict:
    """Poll one Niagara endpoint: group polling points by equipment, BQL-scan
    each equipment's folder subtree sequentially, write readings.

    Each request is scoped to a single equipment (via _poll_batches), so no one
    query pulls the whole station at once. ``default_delay_ms`` is the
    platform-level fallback between requests; the per-endpoint override
    (``site_niagara_endpoints.poll_equipment_delay_ms``) wins when set.

    Returns a summary dict for the driver's aggregate report. Individual
    per-equipment successes/failures are also written to ``niagara_poll_log``.
    """
    endpoint = _get_endpoint_with_polling(endpoint_id)
    if not endpoint:
        return {"ok": False, "error": f"no endpoint {endpoint_id}", "folders": 0, "rows_inserted": 0}
    if not endpoint.get("enabled", True) or not endpoint.get("poll_enabled", False):
        _log_poll_row(
            endpoint_id=endpoint_id, endpoint_name=endpoint.get("name"),
            site_id=str(endpoint["site_id"]) if endpoint.get("site_id") else None,
            folder_ord=None, status="skipped",
            error="endpoint disabled" if not endpoint.get("enabled", True) else "poll_enabled=false",
        )
        return {"ok": True, "skipped": True, "folders": 0, "rows_inserted": 0}

    points = _load_polling_points_for_endpoint(endpoint_id)
    if not points:
        _log_poll_row(
            endpoint_id=endpoint_id, endpoint_name=endpoint.get("name"),
            site_id=str(endpoint["site_id"]), folder_ord=None,
            status="summary", rows_seen=0, rows_inserted=0, rows_unmatched=0,
        )
        return {"ok": True, "folders": 0, "rows_inserted": 0, "note": "no polling points"}

    # One bounded request per equipment: group polling points by equipment and
    # scan only that equipment's folder subtree (see _poll_batches). Sequential
    # iteration keeps a single equipment's points in flight per station request.
    batches = _poll_batches(points)

    delay_s = (endpoint.get("poll_equipment_delay_ms") or default_delay_ms) / 1000.0
    site_id = str(endpoint["site_id"])
    endpoint_name = endpoint.get("name")

    session = requests.Session()
    session.auth = (endpoint["username"], endpoint["password"])
    session.verify = bool(endpoint["ssl_verify"])

    cycle_ts = datetime.now(timezone.utc)  # one ts across the whole cycle
    total_inserted = 0
    total_unmatched = 0
    total_seen = 0
    cycle_started = time.monotonic()

    for folder, label, expected_points in batches:
        folder_started = time.monotonic()
        try:
            url = _build_polling_url(endpoint["base_url"], folder)
            resp = session.get(url, timeout=request_timeout_sec)
            resp.raise_for_status()
            rows = _parse_bql_html_scan(resp.text)
            inserted, unmatched = _match_and_insert_poll_readings(
                site_id=site_id,
                expected=expected_points,
                rows=rows,
                cycle_ts=cycle_ts,
            )
            total_inserted += inserted
            total_unmatched += unmatched
            total_seen += len(rows)
            _log_poll_row(
                endpoint_id=endpoint_id, endpoint_name=endpoint_name, site_id=site_id,
                folder_ord=folder, status="ok",
                rows_seen=len(rows), rows_inserted=inserted, rows_unmatched=unmatched,
                duration_ms=int((time.monotonic() - folder_started) * 1000),
            )
        except requests.exceptions.Timeout:
            _log_poll_row(
                endpoint_id=endpoint_id, endpoint_name=endpoint_name, site_id=site_id,
                folder_ord=folder, status="timeout",
                duration_ms=int((time.monotonic() - folder_started) * 1000),
                error=f"HTTP timeout after {request_timeout_sec}s",
            )
        except requests.exceptions.RequestException as exc:
            _log_poll_row(
                endpoint_id=endpoint_id, endpoint_name=endpoint_name, site_id=site_id,
                folder_ord=folder, status="http_error",
                duration_ms=int((time.monotonic() - folder_started) * 1000),
                error=str(exc)[:500],
            )
        except Exception as exc:  # parse errors, unexpected shapes
            logger.exception(
                "poll: equipment %s (folder %s) on endpoint %s failed", label, folder, endpoint_id
            )
            _log_poll_row(
                endpoint_id=endpoint_id, endpoint_name=endpoint_name, site_id=site_id,
                folder_ord=folder, status="parse_error",
                duration_ms=int((time.monotonic() - folder_started) * 1000),
                error=str(exc)[:500],
            )
        time.sleep(delay_s)

    session.close()

    # Cycle summary row
    _log_poll_row(
        endpoint_id=endpoint_id, endpoint_name=endpoint_name, site_id=site_id,
        folder_ord=None, status="summary",
        rows_seen=total_seen, rows_inserted=total_inserted, rows_unmatched=total_unmatched,
        duration_ms=int((time.monotonic() - cycle_started) * 1000),
    )

    return {
        "ok": True,
        "endpoint_id": endpoint_id,
        "folders": len(batches),
        "rows_seen": total_seen,
        "rows_inserted": total_inserted,
        "rows_unmatched": total_unmatched,
        "duration_ms": int((time.monotonic() - cycle_started) * 1000),
    }


def _get_endpoint_with_polling(endpoint_id: str) -> Optional[dict]:
    """Load a Niagara endpoint including polling-specific columns.

    Kept separate from :func:`_get_endpoint` so the history-sync callers don't
    have to change to pick up the new columns; the poll driver just uses the
    extended query.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, site_id, name, base_url, username, password,
                       ssl_verify, enabled, poll_enabled, poll_equipment_delay_ms
                FROM site_niagara_endpoints
                WHERE id = %s
                """,
                (endpoint_id,),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def _match_and_insert_poll_readings(
    *,
    site_id: str,
    expected: list[dict],
    rows: list[dict],
    cycle_ts: datetime,
) -> tuple[int, int]:
    """Match parsed BQL rows back to point ids by nav ORD and bulk-insert readings.

    Returns ``(inserted, unmatched)``. Unmatched rows (rows the JACE returned
    that don't correspond to a polling point in our DB) are counted and can
    surface via the poll log; they indicate address drift on the station side.
    """
    if not expected or not rows:
        return (0, len(rows) if rows else 0)

    # Key expected points on their normalized nav ORD for O(1) lookup per row.
    by_ord = {_normalize_ord(pt["niagara_nav_ord"]): pt for pt in expected}
    to_insert: list[tuple[datetime, str, str, float]] = []
    unmatched = 0

    for row in rows:
        pt = by_ord.get(_normalize_ord(row.get("point_location")))
        if pt is None:
            unmatched += 1
            continue
        value, status = parse_niagara_poll_value(row.get("value"))
        if value is None or status != "ok":
            continue
        to_insert.append((cycle_ts, site_id, str(pt["id"]), value))

    if not to_insert:
        return (0, unmatched)

    with get_conn() as conn:
        with conn.cursor() as cur:
            execute_values(
                cur,
                """
                INSERT INTO timeseries_readings (ts, site_id, point_id, value)
                VALUES %s
                ON CONFLICT (point_id, ts) DO NOTHING
                """,
                to_insert,
                page_size=500,
            )
            inserted = cur.rowcount if cur.rowcount is not None else len(to_insert)
        conn.commit()
    return (inserted, unmatched)


def list_polling_endpoints() -> list[dict]:
    """All Niagara endpoints currently opted in to live polling.

    Used by :mod:`openfdd_stack.platform.drivers.run_niagara_poll` to fan out
    per cron fire.
    """
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT id, site_id, name
                FROM site_niagara_endpoints
                WHERE enabled = true AND poll_enabled = true
                ORDER BY name
                """
            )
            return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Per-endpoint history sync
# ---------------------------------------------------------------------------

def run_niagara_sync(
    endpoint_id: str,
    time_window: str = "lastweek",
) -> dict:
    """
    Sync historical data from one Niagara endpoint for every point it
    discovered that carries a niagara_history_path.

    Uses a Niagara bqltime window (default 'lastweek') as the BQL range -
    daily runs over `lastweek` overlap intentionally; inserts are idempotent.
    """
    endpoint = _get_endpoint(endpoint_id)
    if not endpoint:
        return {
            "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
            "errors": [f"No Niagara endpoint {endpoint_id}"],
        }
    if not endpoint.get("enabled", True):
        return {
            "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
            "errors": ["Niagara endpoint is disabled"],
        }

    site_uuid = str(endpoint["site_id"])
    base_url = endpoint["base_url"]
    username = endpoint["username"]
    password = endpoint["password"]
    ssl_verify = bool(endpoint["ssl_verify"])

    points_ok = 0
    total_rows = 0
    errors: list[str] = []

    with get_conn() as conn:
        # Fail fast on lock waits / runaway queries instead of hanging forever.
        # Keeps a stuck sync from piling up indefinitely behind a Timescale
        # chunk-creation lock (e.g. while the BACnet scraper is writing).
        with conn.cursor() as cur:
            cur.execute("SET statement_timeout = '60s'")
            cur.execute("SET lock_timeout = '10s'")
        conn.commit()

        with conn.cursor() as cur:
            points = _get_niagara_points_for_endpoint(cur, endpoint_id)

        if not points:
            logger.info("No Niagara points registered for endpoint %s", endpoint_id)
            return {
                "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
                "errors": [],
            }

        logger.info(
            "[niagara.sync] start endpoint=%s site=%s base_url=%s points=%d window=%s",
            endpoint_id, site_uuid, base_url, len(points), time_window,
        )

        # Commit per-point so a hang on one point never strands the earlier
        # ones, and so Timescale locks are released between inserts.
        for idx, pt in enumerate(points, start=1):
            hp = pt["niagara_history_path"]
            logger.info(
                "[niagara.sync] point %d/%d id=%s external_id=%s history=%s",
                idx, len(points), pt["id"], pt.get("external_id"), hp,
            )
            try:
                records = fetch_niagara_history(
                    history_path=hp,
                    base_url=base_url,
                    username=username,
                    password=password,
                    time_window=time_window,
                    ssl_verify=ssl_verify,
                )
                logger.info(
                    "[niagara.sync] point %d/%d fetched=%d records history=%s",
                    idx, len(points), len(records), hp,
                )
                with conn.cursor() as cur:
                    inserted = _store_readings(pt["id"], site_uuid, records, cur)
                conn.commit()
                total_rows += inserted
                points_ok += 1
            except Exception as exc:
                conn.rollback()
                errors.append(f"{hp}: {exc}")
                logger.exception("[niagara.sync] point failed history=%s err=%s", hp, exc)

        logger.info(
            "[niagara.sync] done endpoint=%s site=%s attempted=%d ok=%d rows=%d errors=%d",
            endpoint_id, site_uuid, len(points), points_ok, total_rows, len(errors),
        )

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE site_niagara_endpoints
                SET last_sync_ts = now(), updated_at = now()
                WHERE id = %s
                """,
                (endpoint_id,),
            )
        conn.commit()

    return {
        "points_attempted": len(points),
        "points_ok": points_ok,
        "rows_inserted": total_rows,
        "errors": errors,
    }
