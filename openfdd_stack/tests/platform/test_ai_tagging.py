"""AI-assisted Brick tagging — the whole flow lives in one module, so these
tests pin its behavior without touching Anthropic, the network, the database,
or auth. A fake Messages client stands in for the SDK.

What is guarded here:
- the proposal round-trips through the REAL import contract (DataModelImportBody)
- review-only fields (confidence/rationale) are stripped before import
- validation failures prompt-chain the error back and retry, then give up cleanly
- token usage accumulates across chunks/retries
- chunking groups points by BACnet device and merges equipment by name
- no key / no SDK is a clear AiTaggingError (never a partial write)
"""

from __future__ import annotations

import pytest

import openfdd_stack.platform.ai.tagging as t


# --- Fakes for the Anthropic SDK -------------------------------------------
class _Blk:
    def __init__(self, **kw):
        self.__dict__.update(kw)


class _Usage:
    input_tokens = 100
    output_tokens = 50
    cache_read_input_tokens = 80
    cache_creation_input_tokens = 20


class _Resp:
    def __init__(self, content, stop_reason="tool_use"):
        self.content = content
        self.usage = _Usage()
        self.stop_reason = stop_reason


def _tool_resp(payload, tool_id="tu"):
    return _Resp([
        _Blk(type="tool_use", name=t.TAGGING_TOOL["name"], id=tool_id, input=payload)
    ])


class _FakeMessages:
    """Returns queued responses in order; records every create() call.
    Thread-safe because chunks are now tagged concurrently."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls: list[dict] = []
        self._lock = __import__("threading").Lock()

    def create(self, **kw):
        with self._lock:
            idx = len(self.calls)
            self.calls.append(kw)
        return self._responses[min(idx, len(self._responses) - 1)]


class _FakeClient:
    def __init__(self, responses):
        self.messages = _FakeMessages(responses)


@pytest.fixture
def with_key(monkeypatch):
    """Make the tagger think a key is configured (bare SDK env name)."""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test-key")
    return monkeypatch


_VALID_UUID = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11"

_GOOD = {
    "points": [{
        "point_id": _VALID_UUID,
        "brick_type": "Supply_Air_Temperature_Sensor",
        "equipment_name": "AHU-1",
        "unit": "degC",
        "confidence": 0.9,
        "rationale": "object_name SA-T matches supply air temp",
    }],
    "equipment": [{
        "equipment_name": "AHU-1",
        "equipment_type": "Air_Handling_Unit",
        "confidence": 0.8,
        "rationale": "fan + heating/cooling valves",
    }],
}

_EXPORT = {
    "equipment": [{"equipment_id": "e1", "equipment_name": "AHU-1"}],
    "points": [{
        "point_id": _VALID_UUID,
        "bacnet_device_id": "1",
        "object_identifier": "analog-input,2",
        "external_id": "SA-T",
    }],
}


def _patch_client(monkeypatch, responses):
    client = _FakeClient(responses)
    monkeypatch.setattr(t, "_anthropic_client", lambda api_key: client)
    return client


# --- Tests ------------------------------------------------------------------
def test_happy_path_round_trips_through_import_contract(with_key):
    client = _patch_client(with_key, [_tool_resp(_GOOD)])
    proposal = t.run_tagging(_EXPORT, t.JobContext(notes="AHU-1 is the rooftop unit"))

    assert len(proposal.points) == 1
    assert len(proposal.equipment) == 1
    # The proposal carries review fields...
    assert proposal.points[0]["confidence"] == 0.9
    assert proposal.points[0]["rationale"]
    # ...but the import body strips them and still validates.
    body = proposal.to_import_body()
    assert set(body.keys()) == {"points", "equipment"}
    assert "confidence" not in body["points"][0]
    assert "rationale" not in body["points"][0]
    assert body["equipment"][0]["equipment_type"] == "Air_Handling_Unit"
    assert client.messages.calls  # the model was actually called


def test_stage1_forces_polling_false_and_drops_rule_input(with_key):
    # Even if the model returns polling=true / a rule_input, stage 1 strips them.
    payload = {
        "points": [{
            "point_id": _VALID_UUID,
            "brick_type": "Supply_Air_Temperature_Sensor",
            "polling": True,
            "rule_input": "sat",
        }],
        "equipment": [],
    }
    _patch_client(with_key, [_tool_resp(payload)])
    proposal = t.run_tagging(_EXPORT, None)
    assert proposal.points[0]["polling"] is False
    assert "rule_input" not in proposal.points[0]
    # And the contract the operator onboards keeps polling explicitly false.
    assert proposal.to_import_body()["points"][0]["polling"] is False


def test_invalid_first_response_is_prompt_chained_then_succeeds(with_key):
    # First response omits 'points' (fails the contract); second is valid.
    client = _patch_client(with_key, [_tool_resp({"equipment": []}), _tool_resp(_GOOD)])
    proposal = t.run_tagging(_EXPORT, None)

    assert len(client.messages.calls) == 2, "should retry once"
    # The retry turn must feed the validation error back as a tool_result.
    retry_msgs = client.messages.calls[1]["messages"]
    tool_results = [
        m for m in retry_msgs
        if isinstance(m.get("content"), list)
        and isinstance(m["content"][0], dict)
        and m["content"][0].get("type") == "tool_result"
    ]
    assert tool_results and tool_results[0]["content"][0]["is_error"] is True
    assert len(proposal.points) == 1


def test_usage_accumulates_across_attempts(with_key):
    _patch_client(with_key, [_tool_resp({"equipment": []}), _tool_resp(_GOOD)])
    proposal = t.run_tagging(_EXPORT, None)
    # Two calls at 100/50 each.
    assert proposal.usage.input_tokens == 200
    assert proposal.usage.output_tokens == 100
    assert proposal.usage.cache_read_input_tokens == 160


def test_truncated_output_fails_fast_with_actionable_message(with_key):
    # stop_reason=max_tokens means the tool call was cut off — fail immediately
    # with guidance, do NOT burn retries or report a misleading "missing points".
    truncated = _Resp(
        [_Blk(type="tool_use", name=t.TAGGING_TOOL["name"], id="tu", input={})],
        stop_reason="max_tokens",
    )
    client = _patch_client(with_key, [truncated])
    with pytest.raises(t.AiTaggingError) as exc:
        t.run_tagging(_EXPORT, None)
    assert "truncated" in str(exc.value).lower()
    assert "CHUNK_SIZE" in str(exc.value) or "MAX_TOKENS" in str(exc.value)
    assert len(client.messages.calls) == 1, "must not retry a truncated chunk"


def test_all_attempts_invalid_raises_and_writes_nothing(with_key):
    _patch_client(with_key, [_tool_resp({"equipment": []})])  # always invalid
    with pytest.raises(t.AiTaggingError) as exc:
        t.run_tagging(_EXPORT, None)
    assert "valid import JSON" in str(exc.value)


def test_missing_key_raises_unavailable(monkeypatch):
    # Clear both the bare SDK name and the OFDD_-prefixed fallback.
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OFDD_ANTHROPIC_API_KEY", raising=False)
    # get_platform_settings reads env each call (not cached), so this is clean.
    assert t.ai_tagging_available() is False
    with pytest.raises(t.AiTaggingError) as exc:
        t.run_tagging(_EXPORT, None)
    assert "not configured" in str(exc.value)


def test_empty_export_returns_warning_not_error(with_key):
    proposal = t.run_tagging({"equipment": [], "points": []}, None)
    assert proposal.points == []
    assert any("no points" in w.lower() for w in proposal.warnings)


def test_chunking_groups_by_device_and_merges_equipment(with_key):
    # 9 points across 3 devices, chunk_size forces multiple calls; same equipment
    # row returned in each chunk must dedupe to one.
    with_key.setenv("OFDD_AI_TAG_CHUNK_SIZE", "3")
    export = {
        "equipment": [{"equipment_id": "e1", "equipment_name": "AHU-1"}],
        "points": [
            {"point_id": f"{i}", "bacnet_device_id": str(i // 3), "external_id": f"p{i}"}
            for i in range(9)
        ],
    }
    chunk_payload = {
        "points": [{"point_id": "0", "brick_type": None, "polling": False}],
        "equipment": [{"equipment_name": "AHU-1", "equipment_type": "Air_Handling_Unit"}],
    }
    client = _patch_client(with_key, [_tool_resp(chunk_payload)])
    proposal = t.run_tagging(export, None)

    assert len(client.messages.calls) == 3, "9 points / chunk_size 3 -> 3 calls"
    # Equipment returned in all three chunks dedupes to a single row.
    assert len(proposal.equipment) == 1
    # Every exported point is preserved (built from originals), not just what the
    # model echoed back; only point "0" carried a (null) tag, so 9 are untagged.
    assert len(proposal.points) == 9
    assert any("untagged" in w for w in proposal.warnings)


# --- Niagara path / device-aware grouping (Stage 1) -------------------------
def test_niagara_device_parsing():
    p = {
        "external_id": "local:|station:|slot:/Drivers/NiagaraNetwork/Floor28/"
        "FS_28_BMS_CP003_2128/points/Comms_Room_Temp/ChwValve"
    }
    dpath, dname = t._niagara_device(p)
    assert dname == "FS_28_BMS_CP003_2128"
    assert dpath == "Drivers/NiagaraNetwork/Floor28/FS_28_BMS_CP003_2128"
    # No path -> no grouping.
    assert t._niagara_device({"external_id": "ZoneTemp"}) == (None, None)
    assert t._niagara_device({}) == (None, None)


def test_path_grouping_is_deterministic_and_overrides_model(with_key):
    # Two points under one Niagara device, one under another. The model tries to
    # regroup them under "AHU-1" — the path grouping must win, and equipment must
    # carry the stable source_ref (full device path), not depend on the name.
    NIA = "local:|station:|slot:/Drivers/NiagaraNetwork/Floor28/"
    export = {
        "equipment": [],
        "points": [
            {"point_id": "p1", "site_id": "s", "external_id": f"{NIA}DEV_A/points/grp/PtA1"},
            {"point_id": "p2", "site_id": "s", "external_id": f"{NIA}DEV_A/points/grp/PtA2"},
            {"point_id": "p3", "site_id": "s", "external_id": f"{NIA}DEV_B/points/grp/PtB1"},
        ],
    }
    # Model returns tags but mislabels equipment_name as "AHU-1" for everything.
    payload = {
        "points": [
            {"point_id": "p1", "brick_type": "Supply_Air_Temperature_Sensor", "equipment_name": "AHU-1"},
            {"point_id": "p2", "brick_type": "Return_Air_Temperature_Sensor", "equipment_name": "AHU-1"},
            {"point_id": "p3", "brick_type": "Zone_Air_Temperature_Sensor", "equipment_name": "AHU-1"},
        ],
        "equipment": [{"equipment_name": "DEV_A", "equipment_type": "Fan_Coil_Unit"}],
    }
    _patch_client(with_key, [_tool_resp(payload)])
    proposal = t.run_tagging(export, None)

    # Points grouped by device path, NOT the model's "AHU-1".
    by_id = {p["point_id"]: p for p in proposal.points}
    assert by_id["p1"]["equipment_name"] == "DEV_A"
    assert by_id["p2"]["equipment_name"] == "DEV_A"
    assert by_id["p3"]["equipment_name"] == "DEV_B"
    # Tags still grafted from the model, identity (external_id) preserved.
    assert by_id["p1"]["brick_type"] == "Supply_Air_Temperature_Sensor"
    assert by_id["p1"]["external_id"].endswith("DEV_A/points/grp/PtA1")
    # equipment_id omitted so the importer links by the path-derived name.
    assert "equipment_id" not in by_id["p1"]
    # Each point carries the stable source_ref link (Step 2: rename-safe identity).
    assert by_id["p1"]["equipment_source_ref"] == "Drivers/NiagaraNetwork/Floor28/DEV_A"
    assert by_id["p3"]["equipment_source_ref"] == "Drivers/NiagaraNetwork/Floor28/DEV_B"

    # Two equipment, each with the stable source_ref (full device path) + site, and
    # the model's equipment_type grafted by name where it matched.
    eq = {e["equipment_name"]: e for e in proposal.equipment}
    assert set(eq) == {"DEV_A", "DEV_B"}
    assert eq["DEV_A"]["source_ref"] == "Drivers/NiagaraNetwork/Floor28/DEV_A"
    assert eq["DEV_A"]["site_id"] == "s"
    assert eq["DEV_A"]["equipment_type"] == "Fan_Coil_Unit"
    # The import body still validates (source_ref is part of the contract now).
    body = proposal.to_import_body()
    assert body["points"][0]["equipment_source_ref"].endswith("DEV_A")
    assert body["equipment"][0]["source_ref"].endswith("DEV_A")


def test_chunk_helper_keeps_device_objects_together():
    export = {
        "equipment": [],
        "points": [
            {"point_id": str(i), "bacnet_device_id": str(i // 4)} for i in range(8)
        ],
    }
    chunks = t._chunk_points(export, 3)
    # Device 0 has 4 objects; they must not be split below the group, so the
    # first chunk holds the whole 4-object device even though it exceeds 3.
    assert [len(c["points"]) for c in chunks] == [4, 4]


def test_strip_review_fields_only_removes_review_keys():
    row = {"point_id": "x", "brick_type": "Y", "confidence": 0.5, "rationale": "z"}
    assert t._strip_review_fields(row) == {"point_id": "x", "brick_type": "Y"}


def test_background_run_lifecycle(with_key):
    # start_run returns immediately with a run id; the run completes in a thread
    # and get_run reports status=done with the proposal.
    import time as _time

    _patch_client(with_key, [_tool_resp(_GOOD)])
    started = t.start_run(_EXPORT, t.JobContext())
    assert started["status"] == "running"
    run_id = started["run_id"]

    deadline = 5.0
    state = None
    while deadline > 0:
        state = t.get_run(run_id)
        if state and state["status"] in ("done", "error"):
            break
        _time.sleep(0.05)
        deadline -= 0.05

    assert state is not None and state["status"] == "done", state
    assert state["proposal"]["points"][0]["polling"] is False
    assert "_ts" not in state  # internal field stripped from the public view


def test_start_run_unconfigured_raises(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OFDD_ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(t.AiTaggingError):
        t.start_run(_EXPORT, None)


def test_get_run_unknown_id_is_none():
    assert t.get_run("does-not-exist") is None


def test_system_prompt_and_tool_are_stable_contract():
    # The tool schema must forbid extra keys so the model cannot emit fields the
    # import endpoint would silently drop, and confidence/rationale must exist.
    props = t.TAGGING_TOOL["input_schema"]["properties"]
    assert props["points"]["items"]["additionalProperties"] is False
    assert props["equipment"]["items"]["additionalProperties"] is False
    for k in ("confidence", "rationale"):
        assert k in t._POINT_PROPERTIES and k in t._EQUIPMENT_PROPERTIES
    # Stage 1 is structure-only: the model is never asked for polling, rule_input,
    # or feeds/fed_by — keeping those out of the schema is the contract.
    assert "polling" not in t._POINT_PROPERTIES
    assert "rule_input" not in t._POINT_PROPERTIES
    assert "feeds" not in t._EQUIPMENT_PROPERTIES
    assert "fed_by" not in t._EQUIPMENT_PROPERTIES
    assert "STAGE 1" in t.SYSTEM_PROMPT
    assert "emit_tagging_proposal" in t.SYSTEM_PROMPT
