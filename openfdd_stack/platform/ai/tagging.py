"""AI-assisted Brick tagging — the ENTIRE auto-tagger lives in this one module.

This file is intentionally self-contained so the whole flow can be audited in a
single read: every prompt, every byte that leaves the platform for Anthropic,
and every transformation on the way back is defined here and only here. The HTTP
endpoint in ``api/data_model.py`` does nothing but build the export and call
:func:`run_tagging` — it holds no tagging logic, no prompts, and never talks to
Anthropic directly.

Flow (top to bottom in this file):

    StructuredExport (GET /data-model/export?shape=structured)
        │
        ├─ SYSTEM_PROMPT          the canonical tagging instructions (verbatim)
        ├─ _vocabulary_block()    the Brick 1.4 allowlist the model may use
        ├─ _job_context_block()   operator pre-flight (faults, rules YAML, units…)
        ├─ _chunk_points()        split large exports by BACnet device grouping
        │
        ▼
    _tag_chunk()  ──►  Anthropic Messages API (forced tool call)
        │                 - prompt caching on the static system blocks
        │                 - validate the tool output against DataModelImportBody
        │                 - on failure: prompt-chain the error back and retry
        ▼
    _merge_chunks()  ──►  TaggingProposal {points, equipment, warnings, usage}

The proposal carries an extra ``confidence`` / ``rationale`` on each row purely
for the human review UI. Those two fields are NEVER part of the import contract
(``DataModelImportBody`` is ``extra="forbid"``); :meth:`TaggingProposal.to_import_body`
strips them, so what the operator approves round-trips cleanly through the
existing ``PUT /data-model/import`` write path. This module never writes to the
database — it only proposes.
"""

from __future__ import annotations

import json
import logging
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Callable, Optional

from pydantic import BaseModel, Field

from openfdd_stack.platform.brick_vocabulary import (
    BRICK_14_ALIASES,
    BRICK_14_EQUIPMENT_CLASSES,
)
from openfdd_stack.platform.config import get_platform_settings

logger = logging.getLogger(__name__)

# Topic for streaming progress to the Data model UI over the realtime WebSocket.
TOPIC_AI_TAG = "ai.tag"


class AiTaggingError(RuntimeError):
    """Raised for any auto-tagger failure (no key, SDK missing, model error,
    or output that never validated after all retries). The endpoint maps this
    to a clean HTTP error — callers never see a half-written data model because
    this module does not write to the database."""


# ---------------------------------------------------------------------------
# 1. System prompt — STAGE 1 of the data-modeling flow: structure only.
#
# Stage 1 organises scanned points into structured equipment and assigns Brick
# types to both. It deliberately does NOT decide polling (everything stays
# unpolled), does NOT set rule_input, and does NOT assign feeds/fed_by — those
# belong to later stages (rules/polling and topology). The prompt is embedded
# verbatim here so an auditor sees the exact instructions the model is given;
# the model returns its result by calling the emit_tagging_proposal tool, which
# guarantees a structurally valid payload. tests/ asserts this stays in sync.
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """\
You are STAGE 1 of the Open-FDD data-modeling flow. Your only job is to organise
scanned points into structured equipment and assign Brick types. You do NOT
decide polling, you do NOT set rule_input, and you do NOT assign feeds/fed-by
relationships — those are later stages.

You receive JSON shaped like GET /data-model/export?shape=structured:
{ "equipment": [...], "points": [...] }

Return your result by calling the emit_tagging_proposal tool exactly once with
{ "points": [...], "equipment": [...] }. Do not return prose or markdown.

--------------------------------------------------
POINT RULES (for each row in points)
--------------------------------------------------
1. KEEP every identity field exactly as provided, character-for-character:
   point_id, bacnet_device_id, object_identifier, object_name, external_id,
   site_id, site_name, equipment_id. Never replace site_id with a site name.
2. brick_type: the best matching Brick POINT class as a bare local name, e.g.
   Supply_Air_Temperature_Sensor, Return_Air_Temperature_Sensor,
   Mixed_Air_Temperature_Sensor, Zone_Air_Temperature_Sensor,
   Damper_Position_Command, Supply_Air_Flow_Sensor, Static_Pressure_Sensor,
   Occupancy_Command. No "brick:" prefix. null if genuinely unclear.
3. equipment_name: assign the point to ONE equipment by NAME (never a UUID),
   based on BACnet device grouping and consistent object_name / external_id
   patterns. If you cannot confidently group a point, leave equipment_name null
   — it stays "Unassigned" for the operator to place during review. Better to
   leave a point Unassigned than to invent or mis-assign an equipment.
4. unit: units are METRIC. Use degC for temperature, percent (or %) for
   percentage, the metric airflow convention, "0/1" for binary, W for power,
   "W/m2" for irradiance. Use null when unknown; do not guess ambiguous
   power/flow/energy units.

--------------------------------------------------
EQUIPMENT RULES (the equipment array — one entry per equipment you reference)
--------------------------------------------------
For each equipment_name you assign to points, return an equipment row:
  { "equipment_name": "AHU-1", "equipment_type": "Air_Handling_Unit",
    "site_id": "<same site_id as its points>" }
- equipment_type: the most specific defensible Brick 1.4 EQUIPMENT class as a
  bare local name, chosen ONLY from the allowlist in the system context. Use the
  generic fallback "Equipment" when unclear — never mis-type a VAV as a Chiller.
- Names only, never UUIDs. Preserve the exact site_id from the points.

--------------------------------------------------
CONFIDENCE & RATIONALE (proposal only — for human review)
--------------------------------------------------
On every point and equipment row, also set:
- confidence: a number from 0.0 to 1.0 for how sure you are of this row's
  brick_type / equipment_type / equipment_name assignment.
- rationale: one short sentence (max ~140 chars) explaining the evidence you
  used (object_name pattern, device grouping, member brick types). Be honest:
  low confidence + "ambiguous name, best guess" beats a confident fabrication.
  These two fields are for the review screen only and are stripped before write.

--------------------------------------------------
HARD CONSTRAINTS
--------------------------------------------------
- Do NOT emit polling, rule_input, feeds, or fed_by — they are not part of
  stage 1 (the platform keeps every point unpolled until a later stage).
- Do NOT invent equipment, devices, points, or engineering values that are not
  present in the export. When unsure, prefer null / Unassigned over fabrication.
- Saying "cannot determine X from export" in the rationale is always better than
  guessing X.
"""


# ---------------------------------------------------------------------------
# 2. The tool the model must call. Its input_schema is the proposal contract:
#    the tagging-relevant subset of PointImportRow / EquipmentImportRow PLUS the
#    review-only confidence/rationale. additionalProperties:false keeps the model
#    from inventing keys that PUT /data-model/import would reject.
# ---------------------------------------------------------------------------
_POINT_PROPERTIES: dict[str, Any] = {
    "point_id": {"type": ["string", "null"], "description": "Existing point UUID; keep verbatim. Null/omit for unimported BACnet rows (create)."},
    "site_id": {"type": ["string", "null"], "description": "Site UUID from the export. Keep verbatim. NEVER replace with a site name."},
    "site_name": {"type": ["string", "null"]},
    "equipment_id": {"type": ["string", "null"], "description": "Keep verbatim if present; assign new equipment by equipment_name, not by UUID."},
    "equipment_name": {"type": ["string", "null"]},
    "equipment_type": {"type": ["string", "null"], "description": "Brick 1.4 equipment class (bare local name) from the allowlist."},
    "external_id": {"type": ["string", "null"], "description": "Time-series key. Keep verbatim; required for new points."},
    "bacnet_device_id": {"type": ["string", "null"], "description": "Keep verbatim."},
    "object_identifier": {"type": ["string", "null"], "description": "Keep verbatim."},
    "object_name": {"type": ["string", "null"], "description": "Keep verbatim."},
    "brick_type": {"type": ["string", "null"], "description": "Brick point class, bare local name (e.g. Supply_Air_Temperature_Sensor)."},
    "unit": {"type": ["string", "null"], "description": "Metric unit (degC, percent, W, …) or null."},
    "confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1, "description": "Review-only: confidence 0..1. Stripped before import."},
    "rationale": {"type": ["string", "null"], "description": "Review-only: one short sentence of evidence. Stripped before import."},
}

# Stage 1 is structure-only: no polling, no rule_input, no feeds/fed_by.
_EQUIPMENT_PROPERTIES: dict[str, Any] = {
    "equipment_id": {"type": ["string", "null"], "description": "Keep verbatim if present; otherwise resolve/create by equipment_name + site_id."},
    "equipment_name": {"type": ["string", "null"]},
    "equipment_type": {"type": ["string", "null"], "description": "Brick 1.4 equipment class (bare local name) from the allowlist."},
    "site_id": {"type": ["string", "null"], "description": "Site UUID from the export. Keep verbatim."},
    "confidence": {"type": ["number", "null"], "minimum": 0, "maximum": 1, "description": "Review-only. Stripped before import."},
    "rationale": {"type": ["string", "null"], "description": "Review-only. Stripped before import."},
}

TAGGING_TOOL: dict[str, Any] = {
    "name": "emit_tagging_proposal",
    "description": (
        "Emit the Brick tagging proposal for the supplied export. Call exactly "
        "once with the full points and equipment arrays."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "points": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": _POINT_PROPERTIES,
                    "additionalProperties": False,
                },
            },
            "equipment": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": _EQUIPMENT_PROPERTIES,
                    "additionalProperties": False,
                },
            },
        },
        "required": ["points", "equipment"],
        "additionalProperties": False,
    },
}

# Keys that exist only on the proposal for the review UI and must be removed
# before the payload is handed to the import contract.
_REVIEW_ONLY_KEYS = ("confidence", "rationale")


# ---------------------------------------------------------------------------
# 3. Request / response models (what the endpoint passes in and gets back).
# ---------------------------------------------------------------------------
class JobContext(BaseModel):
    """Stage 1 operator input. Faults, units mode, and polling were deliberately
    removed: stage 1 is structure-only (metric units, all points unpolled). The
    only steering input is a free-text brief with naming/grouping hints, rendered
    into the user message by :func:`_job_context_block`."""

    notes: Optional[str] = Field(
        None, description="Free-text brief: equipment naming conventions, grouping hints."
    )


class TokenUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_input_tokens: int = 0
    cache_creation_input_tokens: int = 0


class TaggingProposal(BaseModel):
    """The ephemeral result handed to the review UI. NOT a DB write. Call
    :meth:`to_import_body` to get the strict ``DataModelImportBody``-shaped dict
    the operator approves through ``PUT /data-model/import``."""

    points: list[dict[str, Any]] = Field(default_factory=list)
    equipment: list[dict[str, Any]] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    model: str = ""
    chunks: int = 1
    usage: TokenUsage = Field(default_factory=TokenUsage)

    def to_import_body(self) -> dict[str, Any]:
        """Strip the review-only fields and return a payload validated against
        the real import contract. Raises :class:`AiTaggingError` if it does not
        validate (should not happen — every chunk is validated before merge)."""
        body = {
            "points": [_strip_review_fields(p) for p in self.points],
            "equipment": [_strip_review_fields(e) for e in self.equipment],
        }
        err = _validate_import_body(body)
        if err is not None:
            raise AiTaggingError(f"merged proposal failed import validation: {err}")
        return body


# ---------------------------------------------------------------------------
# 4. Prompt assembly — everything the model sees, built here so it is auditable.
# ---------------------------------------------------------------------------
def _vocabulary_block() -> str:
    """The Brick 1.4 equipment allowlist + aliases, in-process from the single
    source of truth (brick_vocabulary.py). Sent as a cached system block so the
    model can only choose equipment_type values the import endpoint accepts."""
    classes = ", ".join(sorted(BRICK_14_EQUIPMENT_CLASSES))
    aliases = ", ".join(f"{k}->{v}" for k, v in sorted(BRICK_14_ALIASES.items()))
    return (
        "BRICK 1.4 EQUIPMENT CLASS ALLOWLIST (use bare local names; choose "
        "equipment_type ONLY from this list, else use Equipment):\n"
        f"{classes}\n\n"
        "Accepted aliases (case-insensitive, normalized on import):\n"
        f"{aliases}"
    )


def _job_context_block(ctx: JobContext | None) -> str:
    """Render the stage-1 operator brief into the user message. There is no
    polling/units context to convey (stage 1 is structure-only); the only input
    is an optional free-text brief with naming/grouping hints."""
    notes = (ctx.notes or "").strip() if ctx else ""
    if notes:
        return (
            "OPERATOR BRIEF (equipment naming conventions / grouping hints):\n"
            f"{notes}"
        )
    return (
        "No operator brief provided — group strictly from BACnet device grouping "
        "and object_name / external_id patterns; leave unclear points Unassigned."
    )


def _user_message(export_chunk: dict[str, Any], ctx: JobContext | None) -> str:
    """The per-chunk user message: job context, then the export JSON. The export
    JSON is intentionally NOT cached (it varies per chunk); the static system
    blocks are."""
    return (
        f"{_job_context_block(ctx)}\n\n"
        "EXPORT JSON to tag (shape=structured):\n"
        f"{json.dumps(export_chunk, ensure_ascii=False)}"
    )


# ---------------------------------------------------------------------------
# 5. Chunking — keep payloads small enough to tag reliably. Points are grouped
#    by BACnet device so an equipment's points stay together in one chunk; the
#    full (small) equipment array rides along with every chunk for context.
# ---------------------------------------------------------------------------
def _chunk_points(
    export: dict[str, Any], chunk_size: int
) -> list[dict[str, Any]]:
    points: list[dict[str, Any]] = list(export.get("points") or [])
    equipment: list[dict[str, Any]] = list(export.get("equipment") or [])
    if chunk_size <= 0 or len(points) <= chunk_size:
        return [{"equipment": equipment, "points": points}]

    # Group by device so a device's objects are never split across chunks.
    by_device: dict[str, list[dict[str, Any]]] = {}
    order: list[str] = []
    for p in points:
        key = str(p.get("bacnet_device_id") or f"_nodev_{p.get('point_id') or p.get('external_id')}")
        if key not in by_device:
            by_device[key] = []
            order.append(key)
        by_device[key].append(p)

    chunks: list[dict[str, Any]] = []
    current: list[dict[str, Any]] = []
    for key in order:
        group = by_device[key]
        if current and len(current) + len(group) > chunk_size:
            chunks.append({"equipment": equipment, "points": current})
            current = []
        current.extend(group)
    if current:
        chunks.append({"equipment": equipment, "points": current})
    return chunks


# ---------------------------------------------------------------------------
# 6. Validation against the real import contract (lazy import avoids a circular
#    dependency with api/data_model.py, which imports this module).
# ---------------------------------------------------------------------------
def _strip_review_fields(row: dict[str, Any]) -> dict[str, Any]:
    return {k: v for k, v in row.items() if k not in _REVIEW_ONLY_KEYS}


def _validate_import_body(body: dict[str, Any]) -> str | None:
    """Return None if ``body`` validates against ``DataModelImportBody``, else a
    human/LLM-readable error string (fed back to the model on retry)."""
    try:
        from openfdd_stack.platform.api.data_model import DataModelImportBody

        DataModelImportBody.model_validate(body)
        return None
    except Exception as exc:  # pydantic.ValidationError or anything it raises
        return str(exc)


def _validate_proposal_chunk(tool_input: dict[str, Any]) -> str | None:
    """Validate one chunk's tool output by checking its import-relevant subset.
    confidence/rationale are stripped first because they are not part of the
    import contract."""
    points = tool_input.get("points")
    if not isinstance(points, list):
        return "tool output missing a 'points' array"
    equipment = tool_input.get("equipment") or []
    body = {
        "points": [_strip_review_fields(p) for p in points],
        "equipment": [_strip_review_fields(e) for e in equipment],
    }
    return _validate_import_body(body)


# ---------------------------------------------------------------------------
# 7. The Anthropic call + validate/retry loop for a single chunk.
# ---------------------------------------------------------------------------
def _anthropic_client(api_key: str):
    try:
        from anthropic import Anthropic
    except ImportError as exc:  # pragma: no cover - dependency guard
        raise AiTaggingError(
            "The 'anthropic' package is not installed. Add it to the backend "
            "image (pip install anthropic) to enable AI tagging."
        ) from exc
    return Anthropic(api_key=api_key)


def _tag_chunk(
    client: Any,
    export_chunk: dict[str, Any],
    ctx: JobContext | None,
    *,
    model: str,
    max_tokens: int,
    max_retries: int,
) -> tuple[dict[str, Any], TokenUsage]:
    """Tag one chunk: force the emit_tagging_proposal tool, validate the result
    against the import contract, and on failure prompt-chain the error back to
    the model (the documented retry loop) until it validates or retries run out.

    Returns ``(tool_input, usage)``. Usage is per-chunk so callers can run chunks
    concurrently and sum the deltas without sharing mutable state across threads.
    """
    usage = TokenUsage()
    system = [
        {"type": "text", "text": SYSTEM_PROMPT, "cache_control": {"type": "ephemeral"}},
        {"type": "text", "text": _vocabulary_block(), "cache_control": {"type": "ephemeral"}},
    ]
    messages: list[dict[str, Any]] = [
        {"role": "user", "content": _user_message(export_chunk, ctx)}
    ]

    last_error = "no response"
    for attempt in range(max_retries + 1):
        try:
            resp = client.messages.create(
                model=model,
                max_tokens=max_tokens,
                system=system,
                tools=[TAGGING_TOOL],
                tool_choice={"type": "tool", "name": TAGGING_TOOL["name"]},
                messages=messages,
            )
        except Exception as exc:
            raise AiTaggingError(f"Anthropic request failed: {exc}") from exc

        # Accumulate token usage across every attempt and chunk.
        u = getattr(resp, "usage", None)
        if u is not None:
            usage.input_tokens += getattr(u, "input_tokens", 0) or 0
            usage.output_tokens += getattr(u, "output_tokens", 0) or 0
            usage.cache_read_input_tokens += getattr(u, "cache_read_input_tokens", 0) or 0
            usage.cache_creation_input_tokens += getattr(u, "cache_creation_input_tokens", 0) or 0

        # Truncation is deterministic — the tool-call JSON was cut off mid-array,
        # so the result is unusable and retrying the same chunk won't help. Fail
        # fast with an actionable message instead of bouncing through retries and
        # surfacing a misleading "missing 'points' array".
        if getattr(resp, "stop_reason", None) == "max_tokens":
            n = len(export_chunk.get("points") or [])
            raise AiTaggingError(
                f"Model output was truncated at max_tokens={max_tokens} for a "
                f"{n}-point chunk (the tool call was cut off before finishing). "
                "Lower OFDD_AI_TAG_CHUNK_SIZE or raise OFDD_AI_TAG_MAX_TOKENS."
            )

        tool_use = next(
            (b for b in resp.content if getattr(b, "type", None) == "tool_use"
             and getattr(b, "name", None) == TAGGING_TOOL["name"]),
            None,
        )
        if tool_use is None:
            last_error = "model did not call emit_tagging_proposal"
        else:
            tool_input = tool_use.input if isinstance(tool_use.input, dict) else {}
            err = _validate_proposal_chunk(tool_input)
            if err is None:
                return tool_input, usage
            last_error = err

        if attempt >= max_retries:
            break

        # Prompt-chain: feed the assistant turn back plus a tool_result carrying
        # the validation error so the model can correct its own output.
        messages.append({"role": "assistant", "content": resp.content})
        if tool_use is not None:
            messages.append({
                "role": "user",
                "content": [{
                    "type": "tool_result",
                    "tool_use_id": tool_use.id,
                    "is_error": True,
                    "content": (
                        f"The proposal failed Open-FDD import validation: {last_error}\n"
                        "Fix ONLY the invalid fields (keep all identity fields verbatim) "
                        "and call emit_tagging_proposal again."
                    ),
                }],
            })
        else:
            messages.append({
                "role": "user",
                "content": "You must call the emit_tagging_proposal tool. Try again.",
            })

    raise AiTaggingError(
        f"AI tagging did not produce valid import JSON after {max_retries + 1} "
        f"attempt(s). Last error: {last_error}"
    )


# ---------------------------------------------------------------------------
# 8. Merge chunk results into one proposal (dedupe equipment by name/UUID).
# ---------------------------------------------------------------------------
def _equipment_key(row: dict[str, Any]) -> str:
    name = (row.get("equipment_name") or "").strip().casefold()
    if name:
        return f"name:{name}"
    eid = (row.get("equipment_id") or "").strip()
    return f"id:{eid}" if eid else f"anon:{id(row)}"


def _merge_chunks(chunk_outputs: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    points: list[dict[str, Any]] = []
    equipment_by_key: dict[str, dict[str, Any]] = {}
    for out in chunk_outputs:
        points.extend(out.get("points") or [])
        for eq in out.get("equipment") or []:
            key = _equipment_key(eq)
            prev = equipment_by_key.get(key)
            if prev is None:
                equipment_by_key[key] = eq
                continue
            # Keep the row with a concrete equipment_type, then higher confidence.
            prev_typed = bool(prev.get("equipment_type"))
            eq_typed = bool(eq.get("equipment_type"))
            if eq_typed and not prev_typed:
                equipment_by_key[key] = eq
            elif eq_typed == prev_typed and (eq.get("confidence") or 0) > (prev.get("confidence") or 0):
                equipment_by_key[key] = eq
    return points, list(equipment_by_key.values())


# ---------------------------------------------------------------------------
# 9. Public entrypoint — the ONLY thing the endpoint calls.
# ---------------------------------------------------------------------------
def ai_tagging_available() -> bool:
    """True when an Anthropic key is configured (OFDD_ANTHROPIC_API_KEY)."""
    return bool((getattr(get_platform_settings(), "anthropic_api_key", None) or "").strip())


def run_tagging(
    structured_export: Any,
    ctx: JobContext | None = None,
    *,
    model: str | None = None,
    correlation_id: str | None = None,
    progress_cb: Callable[[dict[str, Any]], None] | None = None,
) -> TaggingProposal:
    """Tag a structured export and return an ephemeral proposal for human review.

    ``structured_export`` may be a ``StructuredExport`` pydantic model or a plain
    ``{"equipment": [...], "points": [...]}`` dict. This function performs NO
    database writes — it only proposes. Chunks are tagged concurrently (up to
    ``OFDD_AI_TAG_CONCURRENCY`` at a time) so a 500-point site finishes in a few
    waves rather than dozens of serial calls. Progress is reported via
    ``progress_cb`` (for the run store) and emitted on TOPIC_AI_TAG.
    """
    settings = get_platform_settings()
    api_key = (getattr(settings, "anthropic_api_key", None) or "").strip()
    if not api_key:
        raise AiTaggingError(
            "AI tagging is not configured. Set ANTHROPIC_API_KEY on the "
            "backend to enable it."
        )

    model = model or getattr(settings, "ai_tag_model", "claude-sonnet-4-6")
    max_tokens = int(getattr(settings, "ai_tag_max_tokens", 20000))
    chunk_size = int(getattr(settings, "ai_tag_chunk_size", 20))
    max_retries = int(getattr(settings, "ai_tag_max_retries", 2))
    concurrency = max(1, int(getattr(settings, "ai_tag_concurrency", 5)))

    # Accept either a pydantic model or a dict; normalize to a plain dict.
    if hasattr(structured_export, "model_dump"):
        export = structured_export.model_dump()
    elif isinstance(structured_export, dict):
        export = structured_export
    else:
        raise AiTaggingError("structured_export must be a StructuredExport or dict")

    n_points = len(export.get("points") or [])
    if n_points == 0:
        return TaggingProposal(
            model=model,
            warnings=["Export contained no points to tag."],
        )

    chunks = _chunk_points(export, chunk_size)
    total = len(chunks)
    warnings: list[str] = []
    client = _anthropic_client(api_key)

    _progress(correlation_id, progress_cb,
              {"phase": "start", "points": n_points, "chunks": total, "model": model})

    # Tag chunks concurrently. Each _tag_chunk returns its own usage so there is
    # no shared mutable state between workers; we sum deltas as results land.
    usage = TokenUsage()
    results: list[dict[str, Any] | None] = [None] * total
    done = 0
    done_lock = threading.Lock()

    def work(i: int) -> tuple[int, dict[str, Any], TokenUsage]:
        out, u = _tag_chunk(
            client, chunks[i], ctx,
            model=model, max_tokens=max_tokens, max_retries=max_retries,
        )
        return i, out, u

    def record(i: int, out: dict[str, Any], u: TokenUsage) -> None:
        nonlocal done
        results[i] = out
        usage.input_tokens += u.input_tokens
        usage.output_tokens += u.output_tokens
        usage.cache_read_input_tokens += u.cache_read_input_tokens
        usage.cache_creation_input_tokens += u.cache_creation_input_tokens
        with done_lock:
            done += 1
            d = done
        _progress(correlation_id, progress_cb,
                  {"phase": "tagging", "chunk": d, "chunks": total})

    if total == 1 or concurrency == 1:
        for i in range(total):
            _, out, u = work(i)
            record(i, out, u)
    else:
        with ThreadPoolExecutor(max_workers=min(concurrency, total)) as ex:
            futures = [ex.submit(work, i) for i in range(total)]
            for fut in as_completed(futures):
                # .result() re-raises a chunk's AiTaggingError (truncation /
                # never-validated); it propagates out and marks the run failed.
                i, out, u = fut.result()
                record(i, out, u)

    chunk_outputs = [r for r in results if r is not None]
    points, equipment = _merge_chunks(chunk_outputs)

    # Stage 1 is structure-only: enforce the invariant in code, not just the
    # prompt. Every proposed point is unpolled and carries no rule_input; polling
    # and rule inputs are decided in a later stage. (On import, an explicit
    # polling=false also overrides the create-time default of true.)
    for p in points:
        p["polling"] = False
        p.pop("rule_input", None)

    # Sanity: the model should return one proposal row per input point.
    if len(points) != n_points:
        warnings.append(
            f"Proposal has {len(points)} point rows for {n_points} exported points; "
            "review for dropped or duplicated points before onboarding."
        )

    proposal = TaggingProposal(
        points=points,
        equipment=equipment,
        warnings=warnings,
        model=model,
        chunks=len(chunks),
        usage=usage,
    )

    # Final guard: confirm the whole merged proposal still satisfies the import
    # contract (raises AiTaggingError if not — the endpoint surfaces it).
    proposal.to_import_body()

    _progress(correlation_id, progress_cb, {
        "phase": "done",
        "points": len(points),
        "equipment": len(equipment),
        "warnings": len(warnings),
        "usage": usage.model_dump(),
    })
    return proposal


def _progress(
    correlation_id: str | None,
    cb: Callable[[dict[str, Any]], None] | None,
    data: dict[str, Any],
) -> None:
    """Report progress to the run store (cb) and the realtime WS (emit). Both are
    best-effort — telemetry must never break a run."""
    if cb is not None:
        try:
            cb(data)
        except Exception:  # pragma: no cover
            logger.debug("ai-tag progress callback failed", exc_info=True)
    _emit(correlation_id, data)


def _emit(correlation_id: str | None, data: dict[str, Any]) -> None:
    """Best-effort progress broadcast; never let telemetry break tagging."""
    try:
        from openfdd_stack.platform.realtime import emit

        emit(TOPIC_AI_TAG, data, correlation_id=correlation_id)
    except Exception:  # pragma: no cover - telemetry must not fail the run
        logger.debug("ai-tag progress emit failed", exc_info=True)


# ---------------------------------------------------------------------------
# 10. Background run store — so the HTTP request returns immediately and the UI
#     polls for progress/result. A multi-minute synchronous request cannot
#     survive the SWA→ACA gateway timeout, so POST /ai-tag starts a run here and
#     GET /ai-tag/runs/{id} reads it. Runs are held in memory: this assumes the
#     API runs a SINGLE replica (poll must hit the same process that started the
#     run). If predmain-api ever scales >1 replica, back this with a table.
# ---------------------------------------------------------------------------
_RUNS: dict[str, dict[str, Any]] = {}
_RUNS_LOCK = threading.Lock()
_RUN_TTL_SEC = 3600  # forget finished runs after an hour
_RUN_MAX = 50  # hard cap on retained runs


def _prune_runs() -> None:
    now = time.time()
    with _RUNS_LOCK:
        for k in [k for k, v in _RUNS.items() if now - v.get("_ts", now) > _RUN_TTL_SEC]:
            _RUNS.pop(k, None)
        if len(_RUNS) > _RUN_MAX:
            for k in sorted(_RUNS, key=lambda k: _RUNS[k].get("_ts", 0.0))[: len(_RUNS) - _RUN_MAX]:
                _RUNS.pop(k, None)


def _set_run(run_id: str, **fields: Any) -> None:
    with _RUNS_LOCK:
        st = _RUNS.get(run_id, {})
        st.update(fields)
        st["run_id"] = run_id
        st["_ts"] = time.time()
        _RUNS[run_id] = st


def get_run(run_id: str) -> dict[str, Any] | None:
    """Return a copy of the run state (status, progress, proposal|error) or None."""
    with _RUNS_LOCK:
        st = _RUNS.get(run_id)
        return {k: v for k, v in st.items() if k != "_ts"} if st else None


def start_run(
    structured_export: Any,
    ctx: JobContext | None = None,
    *,
    model: str | None = None,
) -> dict[str, Any]:
    """Kick off a tagging run in a background thread and return its id immediately.
    Raises AiTaggingError synchronously only when tagging is not configured (so
    the endpoint can map that to 503); all other failures are recorded on the run
    and surfaced via GET /ai-tag/runs/{id}."""
    if not ai_tagging_available():
        raise AiTaggingError(
            "AI tagging is not configured. Set ANTHROPIC_API_KEY on the backend "
            "to enable it."
        )

    export = (
        structured_export.model_dump()
        if hasattr(structured_export, "model_dump")
        else dict(structured_export)
    )
    n_points = len(export.get("points") or [])
    chunk_size = int(getattr(get_platform_settings(), "ai_tag_chunk_size", 20))
    total_chunks = len(_chunk_points(export, chunk_size)) if n_points else 0

    run_id = uuid.uuid4().hex
    _prune_runs()
    _set_run(
        run_id,
        status="running",
        points=n_points,
        progress={"phase": "queued", "chunks": total_chunks},
        proposal=None,
        error=None,
    )

    def _execute() -> None:
        try:
            proposal = run_tagging(
                export, ctx, model=model, correlation_id=run_id,
                progress_cb=lambda data: _set_run(run_id, progress=data),
            )
            _set_run(run_id, status="done", proposal=proposal.model_dump(), error=None)
        except AiTaggingError as exc:
            _set_run(run_id, status="error", error=str(exc))
        except Exception as exc:  # pragma: no cover - defensive
            logger.exception("ai-tag run %s failed", run_id)
            _set_run(run_id, status="error", error=f"{type(exc).__name__}: {exc}")

    threading.Thread(target=_execute, name=f"ai-tag-{run_id}", daemon=True).start()
    return {"run_id": run_id, "status": "running", "points": n_points, "chunks": total_chunks}
