# Overnight Summary — 2026-03-23

- **Snapshot time:** 2026-03-23 18:30 CDT
- **Window:** Open-FDD dev-testing window (18:00–06:00 CDT)
- **Branch context:** `master` for published docs review; active PR under watch: `develop/v2.0.7` → `master` (PR #83)
- **Reviewer:** OpenClaw

## 1. Executive summary

This evening pass materially clarified the current state:

1. **Direct backend auth is now working from the corrected launch context** for authenticated SPARQL.
2. **The previous blanket 401 auth failure should now be treated as a bench/runtime env-loading issue, not as the primary Open-FDD blocker.**
3. **PR #83 is the only active PR** and looks like a low-risk version-bump release PR with passing CI and CodeRabbit success.
4. **Docker/container log review is still blocked from this host** because Docker Desktop’s Linux engine pipe is unavailable.
5. **Published docs still have the same `llm_workflow` trailing-slash route problem**: trailing slash 404s; no trailing slash works.
6. **DIY BACnet-side read attempts still need endpoint/schema tightening**; the naive POST body to `:8080/client_read_property` returned JSON-RPC `Invalid Request`, which means the gateway is reachable but the request shape used in this pass was wrong.
7. **Fault-calculation proof is still incomplete**: the full fake-BACnet -> ingest -> rule/rolling-window -> Open-FDD fault-output chain was not closed in this pass.

## 2. Active PR review

### PR #83 — `develop/v2.0.7` → `master`
- URL: <https://github.com/bbartling/open-fdd/pull/83>
- Title: `Develop/v2.0.7`
- Status at review time: open, mergeable, not draft
- CI:
  - `test` = success
  - `CodeRabbit` = success
- Scope is small and release-oriented:
  - version bumps in `pyproject.toml`
  - `frontend/package.json`
  - `frontend/package-lock.json`

### Review assessment
- **Overall state:** healthy / low drama
- No meaningful new review risk surfaced from this pass beyond ordinary release hygiene.

### Classification
- **normal release/versioning work**, not a new bug signal

## 3. Docs and README link verification

Checked:
- <https://bbartling.github.io/open-fdd/> → **200**
- <https://bbartling.github.io/open-fdd/modeling/llm_workflow/> → **404**
- <https://bbartling.github.io/open-fdd/modeling/llm_workflow> → **200**
- <https://github.com/bbartling/open-fdd/blob/master/pdf/open-fdd-docs.pdf> → **200**

### Interpretation
- The docs-site route fragility remains real:
  - trailing slash broken
  - non-trailing-slash route works
- PDF link still resolves.

### Classification
- **documentation gap**

## 4. Container-log / runtime evidence

Attempted:
- `docker ps --format "table {{.Names}}\t{{.Status}}\t{{.Image}}"`

Observed:
- Docker Desktop Linux engine pipe unavailable:
  - `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`

### Interpretation
- Current host still cannot inspect expected containers directly:
  - `api`
  - `frontend`
  - `bacnet-scraper`
  - `fdd-loop`
  - `host-stats`
  - `bacnet-server`

### Classification
- **testbench limitation**

## 5. Backend auth / SPARQL integrity

### Current direct backend status
Observed in this pass:
- authenticated `POST /data-model/sparql` → **200**
- returned current site label: `TestBenchSite`

### Interpretation
- The corrected auth path is now working from the bench when the active Open-FDD env file is loaded.
- Earlier blanket `401 Missing or invalid Authorization header` failures should now be interpreted primarily as **automated-testing runtime auth/env loading drift**, not proof that the Open-FDD backend itself cannot serve authenticated SPARQL.

### Classification
- **auth/config drift improved / partially resolved**

## 6. Current model / mode snapshot

### Environment mode
- **Mode:** `TEST BENCH`
- **Mode basis:** current site is still `TestBenchSite`, with fake BACnet devices and testbench-style behavior rather than a live occupied building.
- **Operator alert level:** `warning`
- **Seasonal/time basis:** evening dev-testing window; no live-HVAC operator conclusion attempted.
- **HVAC sanity summary:** focus remains auth, graph integrity, BACnet readability, and expected fake-device behavior.

## 7. BACnet-side verification status

### What we confirmed
- DIY BACnet server endpoint is reachable enough to return structured JSON-RPC responses.

### What failed in this pass
A direct POST to:
- `http://192.168.204.16:8080/client_read_property`

returned:
- **200 with JSON-RPC error `Invalid Request`**
- error details indicate the request schema used in this pass was wrong (missing JSON-RPC `method`, with extra unexpected fields)

### Interpretation
- This is **not** evidence that BACnet reads are dead.
- It **is** evidence that the specific request format used here was wrong for this gateway surface.
- BACnet-side independent verification remains incomplete until the correct JSON-RPC request shape is used.

### Classification
- **testbench/tooling issue**
- **not yet a product bug**

## 8. Frontend/browser evidence vs backend evidence

### Strong frontend evidence already available in logs
Recent automated evidence still supports that the browser path can:
- reset/import the site
- add both BACnet devices to the graph in the UI flow
- show Data Model, Points, Plots, Weather, and Overview pages
- show faults in Plots legend

### Remaining browser/testing rough edge
From prior runs still relevant tonight:
- Data Model Testing smoke sometimes times out waiting for `data-testid=sparql-finished-generation`
- focused SPARQL/frontend parity got much farther after auth fix, but still did not finish fully clean

### Interpretation
- The primary auth blocker improved, but there is still at least one later frontend parity or automation stability issue worth isolating.

### Classification
- **likely UI/API parity rough edge or automation timing issue**

## 9. Fault-calculation / FDD verification status

### Current evidence
The fake-device schedule still defines:
- minute 10–49 UTC → `flatline_flag`
- minute 50–54 UTC → `bad_sensor_flag`

This aligns with the long-run validation strategy and rolling-window expectations.

### What remains missing
This pass did **not** close the full end-to-end proof chain:
1. fake BACnet values observed independently
2. ingestion into Open-FDD confirmed
3. model/rule context confirmed
4. expected fault windows satisfied
5. Open-FDD fault outputs confirmed via API/UI/download

### Verdict
- **Fault-calculation verification status:** **INCONCLUSIVE**

### Classification
- **evidence gap / not yet proven**

## 10. Recommended overnight priorities from here

1. **Keep the 20-minute sweep effectively suppressed** while the richer overnight work is active, unless something materially worsens or recovers.
2. **Isolate the remaining post-auth SPARQL/frontend parity failure** rather than rerunning broad expensive suites blindly.
3. **Correct the DIY BACnet JSON-RPC request shape** and capture at least one clean independent BACnet read for a modeled point.
4. **Close the fake BACnet -> ingest -> fault output chain** so fault calculation can be judged from evidence, not inference.
5. **Continue docs/process hardening** only when it yields durable startup context for future clones.

## 11. Issue classification roll-up

- **Auth/config drift**
  - substantially improved after correcting env loading in the automated-testing runtime
- **Documentation gap**
  - published `llm_workflow/` trailing-slash route still 404s
- **Testbench limitation**
  - Docker unavailable from this host
- **Tooling/automation rough edge**
  - BACnet-side request shape used in this pass was wrong for the JSON-RPC surface
  - frontend parity path still has at least one later failure after auth
- **FDD/fault-verification evidence gap**
  - full proof chain still not closed tonight

## 12. Current bottom line

- **Good news:** authenticated backend SPARQL is working from the corrected bench context.
- **Bad news:** the overnight stack is still not fully proven end-to-end because BACnet independent reads and fault-output proof remain incomplete.
- **Practical stance:** keep pushing on high-signal targeted fixes and evidence capture rather than burning hours on a long run that cannot yet decisively prove fault-calculation behavior.
