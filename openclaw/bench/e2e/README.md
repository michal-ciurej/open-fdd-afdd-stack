# OpenClaw bench E2E test modes

This folder defines bench-oriented test modes for Open-FDD.

Use these modes to validate a running stack without guessing which services should be active.

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

## Access-aware usage

Some OpenClaw runs will have SSH to the Open-FDD host; some will only have LAN/frontend reachability.

- With **host-aware** access, start with `./scripts/bootstrap.sh`, `--verify`, `--test`, and logs.
- With **edge-only** access, use `openclaw/references/generic_lan_testing.md` and the LAN probe scripts before assuming anything about host bindings or `.env`.

## Modes

- **full-stack** — DB + API + frontend + Caddy + BACnet server + BACnet scraper + weather + FDD loop
- **knowledge-graph-only** — DB + API + frontend + Caddy
- **data-ingestion-only** — DB + BACnet server + BACnet scraper
- **engine-only** — DB + FDD loop + weather scraper
- **bench-bacnet** — fake BACnet devices + collector path + graph sync checks
- **ai-modeling** — payload review, import/export validation, topology checks, and model-quality regression around AI-produced data models

## Canonical commands

From repo root:

```bash
./scripts/bootstrap.sh                    # full-stack
./scripts/bootstrap.sh --mode model       # knowledge-graph-only
./scripts/bootstrap.sh --mode collector   # data-ingestion-only
./scripts/bootstrap.sh --mode engine      # engine-only
./scripts/bootstrap.sh --with-mcp-rag     # full-stack plus doc retrieval sidecar
./scripts/bootstrap.sh --test             # CI-style checks
```

## Auth preflight

Most model / parity / hot-reload checks need authenticated backend access when Open-FDD auth is enabled.

Recommended order:
- load the active `stack/.env` into the shell, or set `OFDD_API_KEY`
- for split setups, point `OPENCLAW_STACK_ENV` at the active `.env`
- treat `401` / `403` during preflight as auth/runtime-context drift, not immediate product failure

## AI-assisted data-modeling focus

Expect many OpenClaw sessions to spend more time here than in classic overnight testing.

Focus on:
- payload shape
- site/equipment/point completeness
- BRICK / Standard 223 topology
- BACnet reference plausibility
- import/export parity
- whether the UI/API reflects the model intent after import

## What to test in each mode

- **full-stack**
  - service startup
  - API health
  - BACnet reachability
  - graph sync
  - frontend smoke checks
  - docs/context endpoint

- **knowledge-graph-only**
  - RDF config seed
  - `/mcp/manifest`
  - `/model-context/docs`
  - export/import endpoints
  - SPARQL queries

- **data-ingestion-only**
  - BACnet server startup
  - fake device discovery
  - point scrape ingestion
  - telemetry persistence

- **engine-only**
  - rule execution
  - weather feed
  - fault generation/observation
  - long-run stability

- **ai-modeling**
  - malformed and partial payload handling
  - import validation
  - topology/feeds sanity
  - fresh-site export parity
  - model-linked BACnet sanity where runtime access allows it

## Helper files

- `1_e2e_frontend_selenium.py` — UI smoke path
- `2_sparql_crud_and_frontend_test.py` — graph + CRUD + UI
- `3_long_term_bacnet_scrape_test.py` — persistence / soak test
- `4_hot_reload_test.py` — hot reload and rule upload path
- `5_ai_data_model_payload_test.py` — AI/data-model regression: malformed payloads, partial payloads, engineering metadata, Standard 223 / `s223` topology JSON, and export/import parity on fresh sites
- `ai_modeling_pass.py` — AI-assisted modeling pass
- `automated_suite.py` — orchestrator

## Contributing back upstream

Keep new tools in this folder or under `openclaw/` so they can be reviewed, documented, and reused across buildings and benches without relying on one hardcoded LAN.
