"""
Brick Schema 1.4 equipment-class vocabulary — single source of truth for the stack.

Why this module exists:
  ``equipment.equipment_type`` flows into the TTL writer, the FDD rule selector
  (``rules_loader`` → ``brick_ttl_resolver``), the frontend allowlist, and the
  AI-assisted tagging workflow. Each consumer used to maintain its own copy of
  the vocabulary — that drift is what produced ``Fan_Coil_Unit`` in the DB and
  ``[FCU]`` in the rule YAMLs (different Brick versions, same intent).

Single rule going forward:
  - Brick 1.4 long-form class IRIs are canonical (``Fan_Coil_Unit`` not ``FCU``).
  - API write paths validate against :data:`BRICK_14_EQUIPMENT_CLASSES`.
  - Aliases (Brick 1.3 short-form, label-with-spaces, brick: prefix, dashes) are
    resolved silently by :func:`normalize_equipment_type` so import payloads
    from older tooling still work.
  - The TTL writer must call :func:`coerce_to_brick_class` so an unknown value
    becomes ``brick:Equipment`` instead of producing an invalid IRI.

This module is intentionally dependency-free so ``rules_loader``, the API, and
test code can all import it without pulling in the database layer.
"""

from __future__ import annotations

from typing import Iterable


# Canonical Brick 1.4 long-form class IRI suffixes (no ``brick:`` prefix).
# Add a class here when a rule YAML references it in ``equipment_type:`` or
# the frontend / SPARQL needs to query it.
BRICK_14_EQUIPMENT_CLASSES: frozenset[str] = frozenset(
    {
        # Top-level fallback when type is unknown/unspecified.
        "Equipment",
        # HVAC equipment
        "Air_Handling_Unit",
        "Boiler",
        "Chiller",
        "Cooling_Tower",
        "Fan_Coil_Unit",
        "Heat_Exchanger",
        "Pump",
        "Variable_Air_Volume_Box",
        "Variable_Air_Volume_Box_With_Reheat",
        "Water_Pump",
        # HVAC subsystems / virtual equipment
        "Chilled_Water_System",
        "Condenser_Water_System",
        "Hot_Water_System",
        "Weather_Service",
        # Electrical (analytics / energy panels)
        "Building_Electrical_Meter",
        "Electrical_Energy_Usage_Sensor",
    }
)

# Top-level Brick 1.4 classes that show up in SPARQL but are not equipment.
# Kept here so the frontend/SPARQL allowlist stays coherent with one source.
BRICK_14_NON_EQUIPMENT_CLASSES: frozenset[str] = frozenset(
    {
        "Site",
        "Building",
        "Floor",
        "HVAC_Equipment",
        "HVAC_Zone",
        "Point",
    }
)

# Full SPARQL/UI allowlist (mirrors the old frontend constant).
BRICK_14_QUERY_CLASS_ALLOWLIST: frozenset[str] = (
    BRICK_14_EQUIPMENT_CLASSES | BRICK_14_NON_EQUIPMENT_CLASSES
)

# Legacy / shorthand → canonical Brick 1.4. Alias keys are matched
# case-insensitively (see :func:`normalize_equipment_type`). Pre-existing data
# tagged with these forms is migrated quietly so neither operators nor the AI
# tagger have to know about the rename.
BRICK_14_ALIASES: dict[str, str] = {
    # Brick 1.3 short-form → 1.4 long-form
    "FCU": "Fan_Coil_Unit",
    "VAV": "Variable_Air_Volume_Box",
    "AHU": "Air_Handling_Unit",
    "RVAV": "Variable_Air_Volume_Box_With_Reheat",
    # Display labels with spaces → underscored Brick IRI suffix
    "Fan Coil Unit": "Fan_Coil_Unit",
    "Variable Air Volume Box": "Variable_Air_Volume_Box",
    "Variable Air Volume Box With Reheat": "Variable_Air_Volume_Box_With_Reheat",
    "Air Handling Unit": "Air_Handling_Unit",
    "Cooling Tower": "Cooling_Tower",
    "Heat Exchanger": "Heat_Exchanger",
    "Water Pump": "Water_Pump",
    "Chilled Water System": "Chilled_Water_System",
    "Condenser Water System": "Condenser_Water_System",
    "Hot Water System": "Hot_Water_System",
    "Weather Service": "Weather_Service",
    "Building Electrical Meter": "Building_Electrical_Meter",
    "Electrical Energy Usage Sensor": "Electrical_Energy_Usage_Sensor",
}


_ALIAS_LOWER: dict[str, str] = {k.casefold(): v for k, v in BRICK_14_ALIASES.items()}
_CLASS_LOWER: dict[str, str] = {
    c.casefold(): c for c in BRICK_14_QUERY_CLASS_ALLOWLIST
}


def normalize_equipment_type(value: str | None) -> str | None:
    """Resolve aliases / case / ``brick:`` prefix / dashes to a canonical class.

    Does **not** validate — unknown values pass through unchanged so callers
    can choose between rejecting (API write paths) and falling back (TTL
    writer). Use :func:`is_valid_equipment_type` afterwards if you need to
    decide.

    >>> normalize_equipment_type("FCU")
    'Fan_Coil_Unit'
    >>> normalize_equipment_type("brick:Cooling-Tower")
    'Cooling_Tower'
    >>> normalize_equipment_type("  fan coil unit  ")
    'Fan_Coil_Unit'
    >>> normalize_equipment_type(None) is None
    True
    """
    if value is None:
        return None
    s = str(value).strip()
    if not s:
        return None
    if s.startswith("brick:"):
        s = s[6:].strip()
    # Allow `Cooling-Tower` to resolve to `Cooling_Tower`.
    s_norm = s.replace("-", "_")
    key = s_norm.casefold()
    # Aliases first so 1.3 short-forms map to 1.4 long-forms even when the
    # short-form happens to equal a different class (it shouldn't, but the
    # alias table is the deliberate intent).
    aliased = _ALIAS_LOWER.get(key)
    if aliased is not None:
        return aliased
    # Case-fix against the canonical allowlist (handles `fan_coil_unit`).
    canon = _CLASS_LOWER.get(key)
    if canon is not None:
        return canon
    # Try alias on the raw (with spaces) too, since some keys have spaces.
    aliased_raw = _ALIAS_LOWER.get(s.casefold())
    if aliased_raw is not None:
        return aliased_raw
    return s_norm


def is_valid_equipment_type(value: str | None) -> bool:
    """``True`` when the (already-normalized) value is in the equipment allowlist.

    ``None`` is accepted because ``equipment.equipment_type`` is nullable and
    "leave unchanged" PATCH semantics rely on None being a valid sentinel.
    """
    if value is None:
        return True
    return value in BRICK_14_EQUIPMENT_CLASSES


def normalize_or_raise(value: str | None) -> str | None:
    """Normalize and validate. Raises ``ValueError`` for unknown values.

    Used by API Pydantic validators. The error message lists the allowlist so
    the operator (or the LLM consuming the 422) can self-correct.
    """
    if value is None:
        return None
    normalized = normalize_equipment_type(value)
    if normalized is None or normalized in BRICK_14_EQUIPMENT_CLASSES:
        return normalized
    allowed = ", ".join(sorted(BRICK_14_EQUIPMENT_CLASSES))
    aliases = ", ".join(f"{k}→{v}" for k, v in sorted(BRICK_14_ALIASES.items()))
    raise ValueError(
        f"equipment_type {value!r} is not a Brick 1.4 equipment class. "
        f"Allowed: {allowed}. Aliases (case-insensitive): {aliases}."
    )


def coerce_to_brick_class(value: str | None, *, fallback: str = "Equipment") -> str:
    """Used by the TTL writer: always returns a valid Brick class IRI suffix.

    Unknown values are coerced to ``fallback`` (default ``Equipment``) so the
    serialized TTL never contains a non-existent ``brick:Foo`` IRI. Caller is
    expected to log when the input differs from the output.
    """
    normalized = normalize_equipment_type(value)
    if normalized and normalized in BRICK_14_EQUIPMENT_CLASSES:
        return normalized
    return fallback


def all_known_aliases() -> Iterable[tuple[str, str]]:
    """Return ``(alias, canonical)`` pairs sorted by alias. Stable for tests / docs."""
    return sorted(BRICK_14_ALIASES.items())
