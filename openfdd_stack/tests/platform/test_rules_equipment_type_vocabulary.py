"""Guard: every rule YAML's `equipment_type:` list must use Brick 1.4 long-form.

This test is the CI-side mirror of the API validators added in Phase 3 — it
catches the drift that originally produced the bug (rules tagged ``[FCU]``
while the DB used ``Fan_Coil_Unit``). New rule files copy-pasted from older
open-fdd cookbooks often arrive with Brick 1.3 short-forms; this test fails
loudly the moment such a rule is added so the operator either renames it or
extends ``BRICK_14_EQUIPMENT_CLASSES`` deliberately.
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("yaml")
import yaml

from openfdd_stack.platform.brick_vocabulary import (
    BRICK_14_ALIASES,
    BRICK_14_EQUIPMENT_CLASSES,
)


def _stack_rules_dir() -> Path:
    """Locate ``stack/rules/`` from the repo root regardless of pytest cwd."""
    here = Path(__file__).resolve()
    for parent in here.parents:
        candidate = parent / "stack" / "rules"
        if candidate.is_dir():
            return candidate
    raise FileNotFoundError("could not find stack/rules/ from this test file")


def _rule_files() -> list[Path]:
    return sorted(_stack_rules_dir().glob("*.yaml"))


def test_rules_directory_is_discoverable():
    """Sanity: the test will only catch drift if it actually finds the YAMLs."""
    files = _rule_files()
    assert files, "expected at least one rule YAML under stack/rules/"


@pytest.mark.parametrize("rule_path", _rule_files(), ids=lambda p: p.name)
def test_rule_equipment_type_uses_brick_14_long_form(rule_path: Path):
    """Each ``equipment_type`` value must be in the Brick 1.4 allowlist.

    If a rule legitimately needs a class that isn't in the allowlist yet, add
    it to ``BRICK_14_EQUIPMENT_CLASSES`` in
    ``openfdd_stack/platform/brick_vocabulary.py`` (the validators, TTL writer,
    and frontend allowlist all read from there). If the rule was using a Brick
    1.3 short-form by accident, the error message tells you what to rename it
    to.
    """
    with rule_path.open(encoding="utf-8") as f:
        rule = yaml.safe_load(f)
    if not isinstance(rule, dict):
        pytest.skip(f"{rule_path.name} is not a single rule mapping; skipping")
    equipment_type = rule.get("equipment_type")
    if equipment_type is None:
        # A rule with no equipment_type runs against every site (sensor_bounds,
        # sensor_flatline). That's deliberate and not a vocabulary violation.
        return
    if isinstance(equipment_type, str):
        equipment_type = [equipment_type]
    assert isinstance(equipment_type, list), (
        f"{rule_path.name}: equipment_type must be a list or string, got {type(equipment_type).__name__}"
    )
    for value in equipment_type:
        assert isinstance(value, str), (
            f"{rule_path.name}: equipment_type entries must be strings, got {value!r}"
        )
        if value in BRICK_14_EQUIPMENT_CLASSES:
            continue
        suggestion = BRICK_14_ALIASES.get(value) or BRICK_14_ALIASES.get(value.upper())
        hint = f" Did you mean {suggestion!r}?" if suggestion else ""
        pytest.fail(
            f"{rule_path.name}: equipment_type entry {value!r} is not in the "
            f"Brick 1.4 allowlist (BRICK_14_EQUIPMENT_CLASSES).{hint} "
            f"Either rename to the canonical long-form or add the new class to "
            f"openfdd_stack/platform/brick_vocabulary.py."
        )
