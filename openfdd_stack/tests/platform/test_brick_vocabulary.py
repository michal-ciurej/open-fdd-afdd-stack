"""Brick 1.4 vocabulary helpers — normalization, validation, coercion.

Covers the single source of truth used by API write paths, the TTL writer,
and the rules selector. If these helpers drift, equipment_type values stop
matching across the stack (the original bug that motivated the module).
"""

from __future__ import annotations

import pytest

from openfdd_stack.platform.brick_vocabulary import (
    BRICK_14_ALIASES,
    BRICK_14_EQUIPMENT_CLASSES,
    BRICK_14_NON_EQUIPMENT_CLASSES,
    BRICK_14_QUERY_CLASS_ALLOWLIST,
    coerce_to_brick_class,
    is_valid_equipment_type,
    normalize_equipment_type,
    normalize_or_raise,
)


def test_canonical_classes_present():
    """Sanity: the rule YAMLs reference these specific Brick 1.4 long-form classes;
    if any disappears from the allowlist, FDD silently drops rules again."""
    for required in (
        "Equipment",
        "Fan_Coil_Unit",
        "Pump",
        "Chiller",
        "Boiler",
        "Cooling_Tower",
        "Air_Handling_Unit",
        "Variable_Air_Volume_Box",
        "Weather_Service",
    ):
        assert required in BRICK_14_EQUIPMENT_CLASSES


def test_query_allowlist_is_union():
    assert BRICK_14_QUERY_CLASS_ALLOWLIST == (
        BRICK_14_EQUIPMENT_CLASSES | BRICK_14_NON_EQUIPMENT_CLASSES
    )


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("FCU", "Fan_Coil_Unit"),
        ("fcu", "Fan_Coil_Unit"),
        ("VAV", "Variable_Air_Volume_Box"),
        ("AHU", "Air_Handling_Unit"),
        ("RVAV", "Variable_Air_Volume_Box_With_Reheat"),
        ("Fan Coil Unit", "Fan_Coil_Unit"),
        ("fan coil unit", "Fan_Coil_Unit"),
        ("Cooling Tower", "Cooling_Tower"),
        ("Chilled Water System", "Chilled_Water_System"),
    ],
)
def test_aliases_normalize_to_long_form(raw, expected):
    assert normalize_equipment_type(raw) == expected


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("brick:Fan_Coil_Unit", "Fan_Coil_Unit"),
        ("brick:FCU", "Fan_Coil_Unit"),
        ("brick:Cooling-Tower", "Cooling_Tower"),
        ("Cooling-Tower", "Cooling_Tower"),
        ("  Pump  ", "Pump"),
        ("pump", "Pump"),
    ],
)
def test_normalize_handles_prefix_dash_case_whitespace(raw, expected):
    assert normalize_equipment_type(raw) == expected


def test_normalize_passes_through_canonical():
    for c in BRICK_14_EQUIPMENT_CLASSES:
        assert normalize_equipment_type(c) == c


def test_normalize_returns_none_for_empty():
    assert normalize_equipment_type(None) is None
    assert normalize_equipment_type("") is None
    assert normalize_equipment_type("   ") is None


def test_normalize_passes_through_unknown():
    """Caller decides what to do with unknown values; normalize doesn't reject them."""
    assert normalize_equipment_type("MyMadeUpClass") == "MyMadeUpClass"


def test_is_valid_equipment_type_true_for_canonical():
    assert is_valid_equipment_type("Fan_Coil_Unit") is True
    assert is_valid_equipment_type("Equipment") is True


def test_is_valid_equipment_type_false_for_alias_until_normalized():
    """The validator runs after normalize, but is_valid_equipment_type is the post-normalize check.
    Aliases like 'FCU' are not in the canonical allowlist; only 'Fan_Coil_Unit' is."""
    assert is_valid_equipment_type("FCU") is False
    assert is_valid_equipment_type("MyMadeUpClass") is False


def test_is_valid_equipment_type_accepts_none():
    """None is the 'no change' sentinel for PATCH semantics — must round-trip."""
    assert is_valid_equipment_type(None) is True


def test_normalize_or_raise_aliases_pass():
    assert normalize_or_raise("FCU") == "Fan_Coil_Unit"
    assert normalize_or_raise("brick:Cooling-Tower") == "Cooling_Tower"


def test_normalize_or_raise_canonical_pass():
    assert normalize_or_raise("Fan_Coil_Unit") == "Fan_Coil_Unit"


def test_normalize_or_raise_none_pass():
    assert normalize_or_raise(None) is None


def test_normalize_or_raise_unknown_raises_with_allowlist_in_message():
    with pytest.raises(ValueError) as exc:
        normalize_or_raise("MyMadeUpClass")
    msg = str(exc.value)
    # Error must list the allowlist so a 422 caller (LLM, operator) can self-correct.
    assert "Fan_Coil_Unit" in msg
    assert "Chiller" in msg


def test_coerce_to_brick_class_canonical_passes():
    assert coerce_to_brick_class("Fan_Coil_Unit") == "Fan_Coil_Unit"


def test_coerce_to_brick_class_alias_resolves():
    assert coerce_to_brick_class("FCU") == "Fan_Coil_Unit"


def test_coerce_to_brick_class_unknown_falls_back():
    """The TTL writer uses this so an invalid DB value never produces an
    invalid `brick:Foo` IRI."""
    assert coerce_to_brick_class("MyMadeUpClass") == "Equipment"


def test_coerce_to_brick_class_none_falls_back():
    assert coerce_to_brick_class(None) == "Equipment"


def test_coerce_to_brick_class_custom_fallback():
    assert coerce_to_brick_class("MyMadeUpClass", fallback="HVAC_Equipment") == "HVAC_Equipment"


def test_aliases_all_resolve_to_canonical_classes():
    """Every alias target must itself be a canonical class — guards against typos."""
    for alias, target in BRICK_14_ALIASES.items():
        assert target in BRICK_14_EQUIPMENT_CLASSES, (
            f"alias {alias!r} points at {target!r} which is not in the equipment allowlist"
        )
