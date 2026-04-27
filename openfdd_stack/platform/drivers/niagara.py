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

# Valid Niagara "bqltime" windows that a caller can pass to run_niagara_sync.
# The string is substituted directly into the BQL query (e.g. bqltime.lastweek).
_VALID_BQL_WINDOWS = {
    "today",
    "yesterday",
    "lasthour",
    "last24hours",
    "last7days",
    "lastweek",
    "lastmonth",
    "thisweek",
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
    if time_window not in _VALID_BQL_WINDOWS:
        raise ValueError(
            f"Unsupported bqltime window '{time_window}'. Allowed: {sorted(_VALID_BQL_WINDOWS)}"
        )
    path = history_path if history_path.startswith("/") else f"/{history_path}"
    bql = f"select timestamp,value from * where timestamp in bqltime.{time_window}"
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
    Parse a numeric Niagara value cell, tolerating trailing units.

    Niagara's BQL table renders values with their display unit appended
    (e.g. "16.5 °C", "0.0 %", "1.23e-2 kW"). We take the first numeric
    literal we find and discard the rest. Returns None for empty / non-numeric
    cells (e.g. "null", "{null}").
    """
    if raw is None:
        return None
    s = raw.strip()
    if not s:
        return None
    try:
        return float(s)
    except ValueError:
        pass
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


def _parse_bql_html_scan(html: str) -> list[dict[str, str]]:
    """
    Parse the station-scan HTML table.

    Expected columns (case-insensitive): Device, PointLocation, Point, Tags.
    Returns one dict per row with normalised keys: device, point_location, point, tags.
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

    if None in (device_idx, loc_idx, point_idx, tags_idx):
        logger.warning(
            "Scan result missing expected columns. Got: %s", parser.headers
        )
        return []

    rows: list[dict[str, str]] = []
    for row in parser.rows:
        if len(row) <= max(device_idx, loc_idx, point_idx, tags_idx):
            continue
        rows.append({
            "device": row[device_idx].strip(),
            "point_location": row[loc_idx].strip(),
            "point": row[point_idx].strip(),
            "tags": row[tags_idx].strip(),
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

def _get_endpoint_for_site(site_id: str) -> Optional[dict]:
    """Load the Niagara endpoint row for a site (UUID or name)."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT e.site_id, e.base_url, e.username, e.password,
                       e.ssl_verify, e.enabled
                FROM site_niagara_endpoints e
                JOIN sites s ON s.id = e.site_id
                WHERE (s.id::text = %s OR s.name = %s)
                """,
                (site_id, site_id),
            )
            row = cur.fetchone()
    return dict(row) if row else None


def _upsert_equipment(cur, site_id: str, name: str) -> str:
    """Upsert equipment by (site_id, name); return its id."""
    cur.execute(
        """
        INSERT INTO equipment (site_id, name)
        VALUES (%s, %s)
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
) -> str:
    """Upsert a point by (site_id, external_id); fills the Niagara metadata columns.

    `object_name` carries the BQL `Point` displayName so the data-model export
    surfaces a human-readable identifier alongside BACnet-discovered points.
    """
    cur.execute(
        """
        INSERT INTO points (
            site_id, external_id, equipment_id, description, object_name,
            niagara_nav_ord, niagara_tags, niagara_history_path
        )
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (site_id, external_id) DO UPDATE SET
            equipment_id        = EXCLUDED.equipment_id,
            description         = COALESCE(EXCLUDED.description, points.description),
            object_name         = COALESCE(EXCLUDED.object_name, points.object_name),
            niagara_nav_ord     = EXCLUDED.niagara_nav_ord,
            niagara_tags        = EXCLUDED.niagara_tags,
            niagara_history_path = COALESCE(EXCLUDED.niagara_history_path, points.niagara_history_path)
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
            ON CONFLICT DO NOTHING
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


def _get_niagara_points_for_site(cur, site_id: str) -> list[dict]:
    """Points on this site that have a niagara_history_path set."""
    # Diagnostic: total points on site vs points with a history path.
    cur.execute("SELECT count(*) AS n FROM points WHERE site_id = %s", (site_id,))
    total = cur.fetchone()["n"]
    cur.execute(
        """
        SELECT count(*) AS n
        FROM points
        WHERE site_id = %s
          AND niagara_history_path IS NOT NULL
          AND niagara_history_path <> ''
        """,
        (site_id,),
    )
    with_hist = cur.fetchone()["n"]
    logger.info(
        "[niagara.select] site=%s points_total=%d points_with_history_path=%d",
        site_id, total, with_hist,
    )
    cur.execute(
        """
        SELECT id, site_id, external_id, niagara_history_path
        FROM points
        WHERE site_id = %s
          AND niagara_history_path IS NOT NULL
          AND niagara_history_path <> ''
        ORDER BY niagara_history_path
        """,
        (site_id,),
    )
    return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Station scan
# ---------------------------------------------------------------------------

def scan_niagara_station(site_id: str) -> dict:
    """
    Run the ControlPoint BQL query against the site's Niagara station, parse the
    HTML response, and upsert equipment + points.

    Grouping:
      equipment = `nav_ord` folder twice removed (parent of `points` folder),
      falling back to the BQL Device column when the nav ORD doesn't match
      the `/<device>/points/<point>` convention.

    Returns a summary dict for UI / job results.
    """
    endpoint = _get_endpoint_for_site(site_id)
    if not endpoint:
        return {
            "ok": False,
            "error": f"No Niagara endpoint configured for site {site_id}",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }
    if not endpoint.get("enabled", True):
        return {
            "ok": False,
            "error": "Niagara endpoint is disabled",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }

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
        logger.exception("Niagara scan HTTP error for site %s", site_id)
        return {
            "ok": False,
            "error": f"HTTP error: {exc}",
            "rows_seen": 0, "points_upserted": 0, "equipment_upserted": 0,
        }

    rows = _parse_bql_html_scan(resp.text)
    logger.info("Niagara scan: site=%s parsed_rows=%d", site_id, len(rows))

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

                # A point's external_id needs to be stable and unique per site.
                # Use the full nav ORD — it is the most specific identifier the
                # scan gives us and survives renaming of the displayName.
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
                )
                points_upserted += 1

            cur.execute(
                """
                UPDATE site_niagara_endpoints
                SET last_scan_ts = now(), updated_at = now()
                WHERE site_id = %s
                """,
                (site_id,),
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
# Per-site history sync
# ---------------------------------------------------------------------------

def run_niagara_sync(
    site_id: str,
    time_window: str = "lastweek",
) -> dict:
    """
    Sync historical data from the site's Niagara station for every point on
    that site that carries a niagara_history_path.

    Uses a Niagara bqltime window (default 'lastweek') as the BQL range —
    daily runs over `lastweek` overlap intentionally; inserts are idempotent.
    """
    endpoint = _get_endpoint_for_site(site_id)
    if not endpoint:
        return {
            "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
            "errors": [f"No Niagara endpoint configured for site {site_id}"],
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
            points = _get_niagara_points_for_site(cur, site_uuid)

        if not points:
            logger.info("No Niagara points registered for site %s", site_uuid)
            return {
                "points_attempted": 0, "points_ok": 0, "rows_inserted": 0,
                "errors": [],
            }

        logger.info(
            "[niagara.sync] start site=%s base_url=%s points=%d window=%s",
            site_uuid, base_url, len(points), time_window,
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
            "[niagara.sync] done site=%s attempted=%d ok=%d rows=%d errors=%d",
            site_uuid, len(points), points_ok, total_rows, len(errors),
        )

        with conn.cursor() as cur:
            cur.execute(
                """
                UPDATE site_niagara_endpoints
                SET last_sync_ts = now(), updated_at = now()
                WHERE site_id = %s
                """,
                (site_uuid,),
            )
        conn.commit()

    return {
        "points_attempted": len(points),
        "points_ok": points_ok,
        "rows_inserted": total_rows,
        "errors": errors,
    }
