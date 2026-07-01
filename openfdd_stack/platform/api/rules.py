"""Rules API: list, read, upload, delete FDD rule YAML files from the configured rules_dir (GET /config)."""

import os
from pathlib import Path

import yaml
from fastapi import APIRouter, HTTPException
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field

router = APIRouter(prefix="/rules", tags=["rules"])

# Test-only: allow injecting/deleting a rule file for hot-reload tests (e.g. 4_hot_reload_test.py)
_ALLOW_TEST_RULES = os.environ.get("OFDD_ALLOW_TEST_RULES", "").strip().lower() in (
    "1",
    "true",
    "yes",
)


def _rules_dir_resolved() -> Path:
    """Return resolved rules_dir from platform config (RDF-backed).

    Delegates to the shared resolver so GET/POST /rules, the FDD runner, and the
    definitions sync all point at the same directory (on Azure: the ``config/rules``
    shared mount).
    """
    from openfdd_stack.platform.rules_loader import resolve_rules_dir

    return resolve_rules_dir()


def _rule_meta(path: Path) -> dict:
    """Lightweight metadata for one rule file, for grouping/display in the UI.

    Never raises: an unreadable or invalid YAML still yields an entry (with empty
    fields) so the file remains visible in the list rather than vanishing.
    """
    meta = {
        "filename": path.name,
        "name": None,
        "flag": None,
        "equipment_types": [],
        "category": None,
        "severity": None,
        "description": None,
    }
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8"))
    except (OSError, yaml.YAMLError):
        return meta
    if not isinstance(data, dict):
        return meta
    et = data.get("equipment_type")
    if isinstance(et, str):
        equipment_types = [et]
    elif isinstance(et, list):
        equipment_types = [str(x) for x in et if x is not None]
    else:
        equipment_types = []
    meta.update(
        {
            "name": data.get("name"),
            "flag": data.get("flag"),
            "equipment_types": equipment_types,
            "category": data.get("category"),
            "severity": data.get("severity"),
            "description": data.get("description"),
        }
    )
    return meta


@router.get("", summary="List rule YAML files")
def list_rules():
    """Return the configured rules_dir path, the .yaml filenames in it, and parsed
    per-rule metadata (equipment_type, category, severity, …) for UI grouping.
    Path comes from GET /config (RDF)."""
    base = _rules_dir_resolved()
    if not base.is_dir():
        return {
            "rules_dir": str(base),
            "files": [],
            "rules": [],
            "error": "rules_dir is not a directory",
        }
    paths = sorted(base.glob("*.yaml"), key=lambda p: p.name)
    files = [p.name for p in paths]  # kept for backward compat
    rules = [_rule_meta(p) for p in paths]
    return {"rules_dir": str(base), "files": files, "rules": rules}


@router.get(
    "/{filename}", response_class=PlainTextResponse, summary="Get rule file content"
)
def get_rule_file(filename: str):
    """Return the raw content of a single .yaml file in the configured rules_dir. Filename must be a bare name (e.g. sensor_bounds.yaml)."""
    if not filename.endswith(".yaml"):
        raise HTTPException(400, "Only .yaml files are allowed")
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "Invalid filename")
    base = _rules_dir_resolved()
    if not base.is_dir():
        raise HTTPException(404, "rules_dir not found")
    path = (base / filename).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid filename") from None
    if not path.is_file() or not path.name.endswith(".yaml"):
        raise HTTPException(404, "Rule file not found")
    try:
        return PlainTextResponse(content=path.read_text(encoding="utf-8"))
    except OSError as e:
        raise HTTPException(500, f"Cannot read file: {e}") from e


def _validate_rule_yaml(content: str) -> dict:
    """Parse YAML and require at least name or flag. Raises HTTPException if invalid."""
    try:
        data = yaml.safe_load(content)
    except yaml.YAMLError as e:
        raise HTTPException(400, f"Invalid YAML: {e}") from e
    if not isinstance(data, dict):
        raise HTTPException(400, "Rule YAML must be a mapping (dict) with name or flag")
    if "name" not in data and "flag" not in data:
        raise HTTPException(400, "Rule must have 'name' or 'flag'")
    return data


class UploadRuleBody(BaseModel):
    """Body for POST /rules (upload or overwrite a rule file)."""

    filename: str = Field(..., description="Bare filename, e.g. my_rule.yaml")
    content: str = Field(..., description="Full YAML content of the rule")


@router.post("", summary="Upload or overwrite a rule file")
def upload_rule(body: UploadRuleBody):
    """
    Write a YAML rule file into the configured rules_dir. Validates YAML and requires name or flag.
    Next FDD run will pick it up (hot reload). Use POST /rules/sync-definitions to update definitions table immediately.
    """
    if (
        not body.filename.endswith(".yaml")
        or ".." in body.filename
        or "/" in body.filename
        or "\\" in body.filename
    ):
        raise HTTPException(
            400, "Invalid filename (must end in .yaml, no path separators)"
        )
    _validate_rule_yaml(body.content)
    base = _rules_dir_resolved()
    if not base.is_dir():
        raise HTTPException(503, "rules_dir is not a directory")
    path = (base / body.filename).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid filename") from None
    try:
        path.write_text(body.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"Cannot write file: {e}") from e
    return {"ok": True, "path": str(path), "filename": body.filename}


@router.post("/sync-definitions", summary="Sync fault_definitions from rules_dir")
def sync_definitions():
    """
    Load all YAML from rules_dir and upsert/prune fault_definitions so the definitions table
    and Faults matrix update immediately (without waiting for the next FDD run).
    """
    from openfdd_stack.platform.loop import sync_fault_definitions_from_rules_dir

    try:
        sync_fault_definitions_from_rules_dir()
    except Exception as e:
        raise HTTPException(500, str(e)) from e
    return {"ok": True}


@router.delete("/{filename}", summary="Delete a rule file")
def delete_rule(filename: str):
    """
    Remove a YAML rule file from rules_dir. Definition will be pruned on next FDD run or after POST /rules/sync-definitions.
    """
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "Invalid filename")
    if not filename.endswith(".yaml"):
        raise HTTPException(400, "Only .yaml files are allowed")
    base = _rules_dir_resolved()
    if not base.is_dir():
        raise HTTPException(503, "rules_dir is not a directory")
    path = (base / filename).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid filename") from None
    if not path.is_file():
        raise HTTPException(404, "File not found")
    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(500, f"Cannot delete file: {e}") from e
    return {"ok": True, "filename": filename}


# --- Test-only: inject/delete a rule file for hot-reload automation (set OFDD_ALLOW_TEST_RULES=1) ---


class TestInjectRuleBody(BaseModel):
    """Body for POST /rules/test-inject. Only available when OFDD_ALLOW_TEST_RULES=1."""

    filename: str = Field(..., description="Bare filename, e.g. test_hot_reload.yaml")
    content: str = Field(..., description="Full YAML content of the rule")


@router.post("/test-inject", summary="(Test) Write a rule file into rules_dir")
def test_inject_rule(body: TestInjectRuleBody):
    """
    Write a YAML file into the configured rules_dir. For hot-reload testing only.
    Requires OFDD_ALLOW_TEST_RULES=1 (or true/yes). Filename must end in .yaml and must not contain .. or path separators.
    """
    if not _ALLOW_TEST_RULES:
        raise HTTPException(
            403, "Test rule inject is disabled. Set OFDD_ALLOW_TEST_RULES=1 to enable."
        )
    if (
        not body.filename.endswith(".yaml")
        or ".." in body.filename
        or "/" in body.filename
        or "\\" in body.filename
    ):
        raise HTTPException(400, "Invalid filename (must be .yaml, no path)")
    base = _rules_dir_resolved()
    if not base.is_dir():
        raise HTTPException(503, "rules_dir is not a directory")
    path = (base / body.filename).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid filename") from None
    try:
        path.write_text(body.content, encoding="utf-8")
    except OSError as e:
        raise HTTPException(500, f"Cannot write file: {e}") from e
    return {"ok": True, "path": str(path), "filename": body.filename}


@router.delete(
    "/test-inject/{filename}", summary="(Test) Remove a rule file from rules_dir"
)
def test_inject_delete(filename: str):
    """
    Delete a YAML file from rules_dir. For hot-reload test cleanup.
    Requires OFDD_ALLOW_TEST_RULES=1.
    """
    if not _ALLOW_TEST_RULES:
        raise HTTPException(
            403, "Test rule delete is disabled. Set OFDD_ALLOW_TEST_RULES=1 to enable."
        )
    if ".." in filename or "/" in filename or "\\" in filename:
        raise HTTPException(400, "Invalid filename")
    if not filename.endswith(".yaml"):
        raise HTTPException(400, "Only .yaml files are allowed")
    base = _rules_dir_resolved()
    if not base.is_dir():
        raise HTTPException(503, "rules_dir is not a directory")
    path = (base / filename).resolve()
    try:
        path.relative_to(base.resolve())
    except ValueError:
        raise HTTPException(400, "Invalid filename") from None
    if not path.is_file():
        raise HTTPException(404, "File not found")
    try:
        path.unlink()
    except OSError as e:
        raise HTTPException(500, f"Cannot delete file: {e}") from e
    return {"ok": True, "filename": filename}
