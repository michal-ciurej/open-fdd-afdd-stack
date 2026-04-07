# Where testing lives (OpenClaw vs product)

Use this map so failures land in the right bucket in `issues_log.md` and GitHub issues.

## Model Routing Policy

Classify the task before analyzing it.

### SIMPLE (use primary model)
- Pass/fail test results
- HTTP status code errors (`404`, `500`, timeout)
- Missing UI elements or broken selectors
- Test environment setup failures
- Syntax errors or import failures

### COMPLEX (use thinking model)
- Unexpected behavior that passed but shouldn't have
- Race conditions or timing-dependent failures
- Security vulnerabilities
- Performance degradation patterns
- Failures that span multiple components or files

Rules:
- Default to SIMPLE unless the test result shows ambiguous or multi-layered behavior.
- Always classify first, then process.
- Never use the thinking model for a task that fits the SIMPLE list.

## First split: what access do you have?

### Edge-only access
Use when OpenClaw only has LAN/VPN/frontend reachability.

Start with:
- `openclaw/references/generic_lan_testing.md`
- `openclaw/scripts/probe_openfdd_lan.sh`
- `openclaw/scripts/probe_openfdd_lan.ps1`

### Host-aware access
Use when OpenClaw also has SSH, `.env`, docker logs, or local loopback access.

Add:
- `.env` mode inspection
- `docker ps`
- Caddy/API/frontend logs
- loopback API checks
- bootstrap phase verification

## Primary entrypoint (not under `openclaw/`)

| What | Path / command |
|------|----------------|
| Stack + CI-style matrix | `scripts/bootstrap.sh` — full stack, `--test`, `--mode collector|model|engine`, `--verify`, optional `--with-mcp-rag`. |

OpenClaw usually starts here **when host access exists**.

## Under `open-fdd-afdd-stack/openclaw/`

| Location | Role | When it fails, log as… |
|----------|------|-------------------------|
| `openclaw/scripts/` | Small helpers and generic LAN probes | area: `bootstrap` / `tooling` / `edge-probe` |
| `openclaw/bench/e2e/` | Heavy Python: Selenium, SPARQL, BACnet, hot-reload, AI payload tests | area: `e2e`, `sparql`, `bacnet`, `hot-reload`, `ai-modeling` |
| `openclaw/bench/scripts/` | bench-side helper utilities | area: `bench` / `bacnet` |
| `openclaw/bench/fake_bacnet_devices/` | fake devices and schedules | area: `fake_bacnet` |
| `openclaw/windows/` | Windows bench wrappers | area: `windows_bench` |
| `openclaw/bench/sparql/` | SPARQL fixtures | area: `sparql` / `graph` |
| `openclaw/references/` | stable guidance for OpenClaw sessions | area: `context` |

## AI-assisted data modeling lives here too

When the task is model-centric rather than stack-centric, prioritize:
- `openclaw/bench/e2e/5_ai_data_model_payload_test.py`
- `openclaw/bench/e2e/ai_modeling_pass.py`
- `openclaw/bench/fixtures/`
- `openclaw/bench/sparql/`

Log these as `ai-modeling`, `graph`, or `bacnet-reference` rather than lumping them into generic frontend failure.

## Product / CI backend

| What | Path |
|------|------|
| API/platform tests | `open_fdd/tests/` (+ paths in `pyproject.toml`) |
| Run | `pytest` or `./scripts/bootstrap.sh --test` |

Log as area: `backend` / `platform` with test node id.

## What to write in `issues_log.md`

Each bullet should capture:
- date
- access level: host-aware or edge-only
- area
- symptom
- command/script/prompt used
- log path if any
- suspected cause
- GitHub issue if filed

Separate OpenClaw/operator mistakes from Open-FDD product bugs.

## Current durable lessons

- Do not confuse missing auth with product failure.
- Do not confuse loopback-only direct ports in TLS mode with API outage.
- After bootstrap, wait for the final summary before treating the state as settled.
- In new-building or remote cases, expect OpenClaw to spend more time in AI-assisted data-model review and edge-only probing than in SSH-heavy bench operations.
