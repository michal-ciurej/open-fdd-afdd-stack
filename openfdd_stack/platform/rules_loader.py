"""
Rules loader with hot-reload: check YAML mtime/hash, reload when changed.

Used by FDD loop to pick up rule tuning without restart.

Rule storage is a single directory (``rules_dir``). On Azure it is the shared
``predmain-config`` Azure Files mount (``config/rules``), so the API container
and the fdd-loop/nightly-sync jobs read and write **one** physical copy -
edits made in the UI or on the share are exactly what the engine runs and the
Faults UI displays. Locally / in CI it defaults to the repo's ``stack/rules``.
The baked-in ``stack/rules`` in each image is a dev default and a one-time seed
for an empty share (see :func:`ensure_rules_dir_seeded`), never the runtime
source of truth once the share is populated.
"""

from __future__ import annotations

import hashlib
import logging
import shutil
from pathlib import Path
from typing import Optional

from open_fdd.engine.runner import load_rules_from_dir

from openfdd_stack.platform.config import get_platform_settings

_log = logging.getLogger(__name__)

# Repo root == /app in the container: rules_loader.py is at
# openfdd_stack/platform/rules_loader.py, so parents[2] is the app root.
_REPO_ROOT = Path(__file__).resolve().parents[2]
# Baked-in default rules shipped in every image (COPY stack/rules in the Dockerfiles).
_BAKED_RULES_DIR = _REPO_ROOT / "stack" / "rules"


def resolve_rules_dir() -> Path:
    """Resolve the configured ``rules_dir`` to an absolute path.

    Single source of truth for the rules location, shared by the FDD loop
    (``run_fdd_loop``) and the rules API (``GET/POST /rules``) so they always
    agree. ``rules_dir`` comes from platform config (env ``OFDD_RULES_DIR`` or
    the RDF overlay); relative paths resolve against the app root, so the Azure
    value ``config/rules`` lands on the mounted share at ``/app/config/rules``.
    """
    raw = getattr(get_platform_settings(), "rules_dir", None) or "stack/rules"
    path = Path(raw)
    if not path.is_absolute():
        path = (_REPO_ROOT / path).resolve()
    return path


def ensure_rules_dir_seeded(rules_path: Path) -> None:
    """Seed an empty mounted rules dir once from the baked-in ``stack/rules``.

    Makes the shared-mount rollout self-healing: on first boot after pointing a
    container at ``config/rules`` (or any dir other than the baked-in default),
    copy the image's default rule YAML in so the API can serve/edit them and the
    engine has rules to run. Idempotent and non-destructive: seeds **only** when
    the destination has no ``*.yaml`` yet, so an already-populated (authoritative)
    share is never touched. A no-op when ``rules_path`` is the baked-in dir itself
    (local/dev), when the baked-in source is missing, or when writes fail.
    """
    try:
        if rules_path.resolve() == _BAKED_RULES_DIR.resolve():
            return  # dev/default: the repo dir is already the source of truth
    except OSError:
        pass
    if not _BAKED_RULES_DIR.is_dir():
        return
    if rules_path.is_dir() and any(rules_path.glob("*.yaml")):
        return  # already populated -> authoritative, leave it alone
    try:
        rules_path.mkdir(parents=True, exist_ok=True)
        count = 0
        for src in sorted(_BAKED_RULES_DIR.glob("*.yaml")):
            shutil.copy2(src, rules_path / src.name)
            count += 1
        _log.info(
            "Seeded %d rule file(s) into %s from baked-in %s",
            count,
            rules_path,
            _BAKED_RULES_DIR,
        )
    except OSError as e:
        _log.warning(
            "Could not seed rules dir %s from %s: %s", rules_path, _BAKED_RULES_DIR, e
        )


def _rules_dir_hash(rules_dir: Path) -> str:
    """Hash of all YAML file mtimes + contents for change detection."""
    if not rules_dir.exists():
        return ""
    paths = sorted(rules_dir.glob("*.yaml"))
    if not paths:
        return ""
    hasher = hashlib.sha256()
    for p in paths:
        st = p.stat()
        hasher.update(f"{p.name}:{st.st_mtime}:{st.st_size}".encode())
        hasher.update(p.read_bytes())
    return hasher.hexdigest()


class HotReloadRules:
    """Cache rules and reload when YAML dir changes."""

    def __init__(self, rules_dir: Path, datalake_override: Optional[Path] = None):
        self.rules_dir = Path(rules_dir)
        self.datalake_override = Path(datalake_override) if datalake_override else None
        self._hash = ""
        self._rules: list = []
        self._column_map: dict = {}
        self._equipment_types: list = []

    def _effective_dir(self) -> Path:
        if self.datalake_override and self.datalake_override.exists():
            return self.datalake_override
        return self.rules_dir

    def _check_reload(self) -> None:
        eff = self._effective_dir()
        h = _rules_dir_hash(eff)
        if h != self._hash:
            self._hash = h
            self._rules = load_rules_from_dir(eff)
            try:
                from openfdd_stack.platform.brick_ttl_resolver import (
                    get_equipment_types_from_ttl,
                    resolve_from_ttl,
                )

                ttl = eff.parent / "data" / "data_model.ttl"
                if ttl.exists():
                    self._column_map = resolve_from_ttl(str(ttl))
                    self._equipment_types = get_equipment_types_from_ttl(str(ttl))
                else:
                    self._column_map = {}
                    self._equipment_types = []
            except Exception:
                self._column_map = {}
                self._equipment_types = []

    @property
    def rules(self) -> list:
        self._check_reload()
        return self._rules

    @property
    def column_map(self) -> dict:
        self._check_reload()
        return self._column_map

    @property
    def equipment_types(self) -> list:
        self._check_reload()
        return self._equipment_types
