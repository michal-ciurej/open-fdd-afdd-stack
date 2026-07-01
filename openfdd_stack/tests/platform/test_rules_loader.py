"""Tests for platform rules loader (hot-reload)."""

from pathlib import Path

import pytest

from openfdd_stack.platform import rules_loader
from openfdd_stack.platform.rules_loader import (
    HotReloadRules,
    _rules_dir_hash,
    ensure_rules_dir_seeded,
    resolve_rules_dir,
)


def test_rules_dir_hash(tmp_path):
    """Hash changes when YAML content changes."""
    (tmp_path / "r1.yaml").write_text("name: foo\n")
    h1 = _rules_dir_hash(tmp_path)
    (tmp_path / "r1.yaml").write_text("name: bar\n")
    h2 = _rules_dir_hash(tmp_path)
    assert h1 != h2


def test_rules_dir_hash_empty(tmp_path):
    """Empty dir returns empty hash."""
    assert _rules_dir_hash(tmp_path) == ""


def test_hot_reload_rules(tmp_path):
    """HotReloadRules returns rules and reloads on change."""
    rule = """
name: test_rule
type: expression
flag: test_flag
inputs:
  x: {column: x}
params: {}
expression: "x > 0"
"""
    (tmp_path / "rule.yaml").write_text(rule)
    loader = HotReloadRules(tmp_path)
    rules = loader.rules
    assert len(rules) >= 1
    assert rules[0].get("name") == "test_rule"

    # Change file
    rule2 = rule.replace("test_rule", "test_rule2")
    (tmp_path / "rule.yaml").write_text(rule2)
    rules2 = loader.rules
    assert rules2[0].get("name") == "test_rule2"


def test_resolve_rules_dir_env(monkeypatch):
    """OFDD_RULES_DIR resolves relative to the app root (e.g. the Azure config/rules mount)."""
    monkeypatch.setenv("OFDD_RULES_DIR", "config/rules")
    got = resolve_rules_dir()
    assert got == (rules_loader._REPO_ROOT / "config" / "rules").resolve()
    assert got.is_absolute()


def test_resolve_rules_dir_absolute(monkeypatch, tmp_path):
    """An absolute rules_dir is returned unchanged."""
    monkeypatch.setenv("OFDD_RULES_DIR", str(tmp_path))
    assert resolve_rules_dir() == tmp_path


def test_seed_populates_empty_dir(tmp_path, monkeypatch):
    """An empty mounted rules dir is seeded from the baked-in defaults."""
    baked = tmp_path / "baked"
    baked.mkdir()
    (baked / "a.yaml").write_text("name: a\n")
    (baked / "b.yaml").write_text("name: b\n")
    monkeypatch.setattr(rules_loader, "_BAKED_RULES_DIR", baked)

    dest = tmp_path / "config" / "rules"
    ensure_rules_dir_seeded(dest)
    assert sorted(p.name for p in dest.glob("*.yaml")) == ["a.yaml", "b.yaml"]


def test_seed_is_non_destructive(tmp_path, monkeypatch):
    """Re-seeding a populated dir never overwrites operator edits."""
    baked = tmp_path / "baked"
    baked.mkdir()
    (baked / "a.yaml").write_text("name: baked-default\n")
    monkeypatch.setattr(rules_loader, "_BAKED_RULES_DIR", baked)

    dest = tmp_path / "rules"
    dest.mkdir()
    (dest / "a.yaml").write_text("name: operator-edit\n")
    ensure_rules_dir_seeded(dest)
    assert (dest / "a.yaml").read_text() == "name: operator-edit\n"


def test_seed_noop_on_baked_dir(tmp_path, monkeypatch):
    """Seeding is a no-op when the target IS the baked-in dir (local/dev)."""
    baked = tmp_path / "baked"
    baked.mkdir()
    (baked / "a.yaml").write_text("name: a\n")
    monkeypatch.setattr(rules_loader, "_BAKED_RULES_DIR", baked)

    before = _rules_dir_hash(baked)
    ensure_rules_dir_seeded(baked)
    assert _rules_dir_hash(baked) == before


def test_seed_graceful_when_source_missing(tmp_path, monkeypatch):
    """Missing baked-in source is a no-op, not an error."""
    monkeypatch.setattr(rules_loader, "_BAKED_RULES_DIR", tmp_path / "nope")
    dest = tmp_path / "rules"
    ensure_rules_dir_seeded(dest)  # must not raise
    assert not (dest.exists() and any(dest.glob("*.yaml")))
