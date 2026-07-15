"""Derived equipment 'attention score' — pure, tunable, no DB or HTTP.

The Issues page ranks equipment by how badly it needs a maintenance visit,
rather than by raw fault-row counts (which are dominated by how often the FDD
loop happened to run). The score combines two signals that already live in
``fault_results`` + ``fault_definitions``:

  * **severity** of each active fault  -> a fixed weight
  * **persistence** = share of FDD checks the fault actually failed, in [0, 1]

    contribution(fault) = weight(severity) x persistence
    score(equipment)    = sum of contributions over its active faults

Summing rewards breadth (a unit tripping several persistent rules outranks one
tripping a single rule). Equipment is then bucketed into three plain bands and
given a direction-of-travel trend from the least-squares slope of its dominant
fault's per-bucket persistence.

Everything here is deliberately constant-driven so the thresholds can be
recalibrated against real data without touching the query or the endpoint.
"""

from __future__ import annotations

from typing import Iterable, Optional, Sequence

# --- Tunable constants ------------------------------------------------------
# Severity -> weight. critical dominates; warnings rarely escalate a unit alone.
SEVERITY_WEIGHT: dict[str, float] = {
    "critical": 10.0,
    "high": 5.0,
    "error": 5.0,
    "warning": 2.0,
    "info": 1.0,
}
DEFAULT_WEIGHT: float = 2.0  # unknown / missing severity -> treat as warning

# Severities that can escalate a unit to "attention" on their own when persistent.
SERIOUS_SEVERITIES: frozenset[str] = frozenset({"critical", "high", "error"})

# Band thresholds (see band()).
ATTENTION_SCORE: float = 8.0        # score at/above this -> attention
DEGRADED_SCORE: float = 2.0         # score at/above this -> degraded
ATTENTION_PERSISTENCE: float = 0.40  # a serious fault this persistent -> attention

# Trend deadband: predicted end-to-end change in persistence across the window
# (slope x span) smaller than this in magnitude reads as "stable".
TREND_DEADBAND: float = 0.10
MIN_TREND_POINTS: int = 3  # fewer buckets than this -> not enough to call a slope

Band = str  # "attention" | "degraded" | "healthy"
Trend = str  # "worsening" | "stable" | "improving"


def weight_for(severity: Optional[str]) -> float:
    """Numeric weight for a fault-definition severity (case-insensitive)."""
    return SEVERITY_WEIGHT.get((severity or "").strip().lower(), DEFAULT_WEIGHT)


def contribution(severity: Optional[str], persistence: float) -> float:
    """A single fault's contribution to its unit's score: weight x persistence."""
    return weight_for(severity) * float(persistence)


def equipment_score(faults: Iterable[dict]) -> float:
    """Sum of contributions over a unit's active faults.

    Each fault dict needs ``severity`` and ``persistence`` keys.
    """
    return round(
        sum(contribution(f.get("severity"), f.get("persistence", 0.0)) for f in faults),
        3,
    )


def band(score: float, faults: Iterable[dict]) -> Band:
    """Bucket a unit: attention / degraded / healthy.

    A serious (critical/high) fault firing in >= ATTENTION_PERSISTENCE of checks
    escalates on its own, so a chronic serious fault is never hidden behind a low
    breadth score; otherwise the total score decides.
    """
    faults = list(faults)
    serious_persistent = any(
        (f.get("severity") or "").strip().lower() in SERIOUS_SEVERITIES
        and float(f.get("persistence", 0.0)) >= ATTENTION_PERSISTENCE
        for f in faults
    )
    if serious_persistent or score >= ATTENTION_SCORE:
        return "attention"
    if score >= DEGRADED_SCORE:
        return "degraded"
    return "healthy"


def trend(persistence_series: Sequence[Optional[float]]) -> Trend:
    """Direction of travel from the least-squares slope of a persistence series.

    ``persistence_series`` is the dominant fault's per-bucket persistence in
    chronological order (day buckets, or hour buckets for very short windows).
    Fewer than MIN_TREND_POINTS real points -> "stable" (can't call a slope).
    """
    pts = [float(p) for p in persistence_series if p is not None]
    n = len(pts)
    if n < MIN_TREND_POINTS:
        return "stable"
    mean_x = (n - 1) / 2.0
    mean_y = sum(pts) / n
    denom = sum((x - mean_x) ** 2 for x in range(n))
    if denom == 0:
        return "stable"
    slope = sum((x - mean_x) * (y - mean_y) for x, y in zip(range(n), pts)) / denom
    predicted_change = slope * (n - 1)  # fitted change from first to last bucket
    if predicted_change > TREND_DEADBAND:
        return "worsening"
    if predicted_change < -TREND_DEADBAND:
        return "improving"
    return "stable"


def dominant_fault(faults: Sequence[dict]) -> Optional[dict]:
    """The fault carrying the largest contribution (drives the plain-language line)."""
    if not faults:
        return None
    return max(
        faults,
        key=lambda f: contribution(f.get("severity"), f.get("persistence", 0.0)),
    )
