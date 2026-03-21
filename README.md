# Open-FDD Automated Testing

A working toolkit for validating **Open-FDD**, **BACnet test-bench integrations**, **SPARQL/data-model flows**, and **OpenClaw-assisted operations**.

Repo: <https://github.com/bbartling/open-fdd-automated-testing>

## What this repo is for

This repo tracks the practical testing harness around Open-FDD:

- Selenium/UI regression checks
- SPARQL/API/frontend parity testing
- BACnet test bench validation with fake devices and scheduled faults
- FDD rule hot-reload verification
- Notes, prompts, and operational playbooks for OpenClaw working with Open-FDD

---

## Core test scripts

- `1_e2e_frontend_selenium.py` — end-to-end frontend smoke/regression
- `2_sparql_crud_and_frontend_test.py` — SPARQL API + frontend parity
- `3_long_term_bacnet_scrape_test.py` — BACnet scrape cadence + expected fault schedule checks
- `4_hot_reload_test.py` — YAML rule upload/sync + FDD verification
- `automated_suite.py` — orchestrator that chains the full suite together

### Example full-suite run

```bash
python automated_suite.py \
  --api-url http://192.168.204.16:8000 \
  --frontend-url http://192.168.204.16 \
  --bacnet-devices 3456789 3456790 \
  --long-run-check-faults
```

---

# Three OpenClaw operating modes

## 1) Open-FDD app testing mode

Use this when validating the application itself.

### Goals

- Selenium/UI regression
- SPARQL/API parity
- BACnet test bench + fake faults
- FDD / hot reload verification

### What OpenClaw should do

- Run `1_`, `2_`, `3_`, `4_`, or `automated_suite.py`
- Compare frontend state vs backend APIs
- Verify fake BACnet devices are producing expected telemetry/fault windows
- Watch for flaky SPARQL/UI timing issues
- Draft GitHub issues for real product bugs only

### Useful context to capture

- Which BACnet devices were used (`3456789`, `3456790` for the fake bench)
- What rule files were active
- Whether FDD faults appeared in `/faults/state`, `/faults/active`, `/download/faults`
- Whether frontend results matched API results

---

## 2) Open-FDD setup / AI-assisted data modeling mode

Use this when setting up a new Open-FDD deployment.

### Goals

- Discover BACnet devices
- Export/import data model JSON
- Brick tagging workflow
- Guided OpenClaw help for turning discovered points into a usable model

### What OpenClaw should do

- Read Open-FDD docs first
- Use `/data-model/export`, `/data-model/import`, `/model-context/docs`
- Assist with Brick tagging and rule_input mapping
- Verify the imported model appears correctly in the UI and SPARQL layer
- Keep notes about site/equipment/point naming conventions

### Suggested OpenClaw prompt for guided setup

```text
You are helping set up Open-FDD on a new system.

Tasks:
1. Inspect the Open-FDD docs and current API state.
2. Discover BACnet devices and summarize what was found.
3. Export the current data model JSON.
4. Propose Brick tagging + rule_input mapping for the discovered points.
5. Prepare a clean import payload.
6. Verify the imported result through the API and the frontend.
7. Note any gaps, ambiguities, or points that still need human review.
```

---

## 3) Live HVAC monitoring / operator-assistant mode

Use this on a real building network where Open-FDD is already running.

### Goals

- Monitor Open-FDD health
- Inspect faults and telemetry
- Optionally use diy-bacnet-server RPC / BACpypes3 context
- Draft work orders / operator summaries / maintenance notes

### What OpenClaw should do

- Check Open-FDD API health and last FDD run
- Review active faults and fault history
- Inspect relevant telemetry around each fault
- Cross-reference BACnet point names/device ids/object identifiers
- Write concise operator-facing summaries
- Draft work-order style next steps, not just technical dumps

### Example operator-assistant prompt

```text
You are acting as an HVAC operator assistant for a live Open-FDD deployment.

Tasks:
1. Check system health, recent FDD runs, and current active faults.
2. Inspect telemetry related to the most important faults.
3. Summarize what appears broken, abnormal, or worth watching.
4. Draft operator-ready work orders with equipment name, issue, likely cause, and next action.
5. If BACnet context is needed, use diy-bacnet-server RPC / known BACnet metadata to explain the issue clearly.
6. Keep the summary concise and useful for building operations.
```

---

# OpenClaw configuration notes

## Preferred local auth: OpenAI Codex OAuth (ChatGPT subscription)

If you are using a ChatGPT/OpenAI subscription and want OpenClaw to use **Codex OAuth** instead of an API key, the key idea is:

- use `openai-codex`
- remove stale `openai` API-key config
- verify the active model is `openai-codex/gpt-5.4`

### Working onboarding flow

```bash
openclaw onboard --auth-choice openai-codex
```

### Important cleanup

OpenClaw may still keep old `openai` provider references around. If that happens, clean the config so only `openai-codex` remains.

Expected good shape:

```json
"auth": {
  "profiles": {
    "openai-codex:default": {
      "provider": "openai-codex",
      "mode": "oauth"
    }
  }
},
"agents": {
  "defaults": {
    "model": {
      "primary": "openai-codex/gpt-5.4"
    },
    "models": {
      "openai-codex/gpt-5.4": {}
    }
  },
  "list": [
    {
      "id": "main",
      "model": "openai-codex/gpt-5.4"
    }
  ]
}
```

### Also clean

```text
~/.openclaw/agents/main/agent/auth-profiles.json
```

Remove stale:

```json
"openai:default"
```

Keep:

```json
"openai-codex:default"
```

### Restart and verify

```bash
openclaw gateway stop
openclaw gateway
openclaw models status --probe
```

Expected:

- `openai-codex/gpt-5.4` works
- no `openai/...` fallback remains
- no API key is required

### Credit

This OAuth cleanup pattern was inspired by notes from **Matthew Berman**:
<https://www.youtube.com/@matthew_berman>

---

# Suggested automation cadence

If this computer is online:

- **6:00 PM–6:00 AM** — run longer BACnet/fault soak testing
- **Midnight** — run `automated_suite.py`
- **Morning** — review results, summarize failures, draft issues if needed

Recommended unattended mode is **headless**. `--headed` is only needed when watching Selenium visually.

---

# Documentation gaps to track

Known gap already filed on Open-FDD:

- Open-FDD issue #80 — missing references for automated-testing rules/SPARQL cookbooks in the docs

Also keep checking:

- online docs links
- README links
- LLM prompt links / documentation PDF links
- parity between docs and what the app/API actually does

---

# Notes for future rebuild / disaster recovery

If this machine dies, recreate the setup by restoring:

1. This repo (`open-fdd-automated-testing`)
2. OpenClaw auth/config
3. Open-FDD repo + docs
4. The BACnet test bench fake devices
5. Scheduled tasks / cron-like jobs for nightly testing

A future addition here should be a dedicated `PROMPTS.md` / `RECOVERY.md` with exact rebuild steps.
