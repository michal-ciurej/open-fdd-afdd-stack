# Overnight Summary — 2026-03-23 evening seed

- **Snapshot time:** 2026-03-23 18:48 CDT
- **Window:** Open-FDD dev-testing window (18:00–06:00 CDT)
- **Reviewer:** OpenClaw

## Executive summary

Early overnight checks show a mixed but improved state:

- direct authenticated backend SPARQL is working from this host now
- Docker/container log review is still blocked from this host because Docker Desktop Linux engine pipe is unavailable
- published docs home still loads, but the trailing-slash `llm_workflow/` route still 404s while the no-trailing-slash variant works
- the active PR target changed since the morning review: the currently active PR is now **#83 `develop/v2.0.7` -> `master`**
- a first DIY BACnet gateway read attempt failed because the request shape used was not the API’s expected JSON-RPC shape, which is a tooling/API-contract gap rather than proof of BACnet failure

## Active PR status

### open-fdd PR #83
- URL: <https://github.com/bbartling/open-fdd/pull/83>
- Title: `Develop/v2.0.7`
- Base: `master`
- Updated: 2026-03-23T14:13:08Z
- Status: open, not draft

### Interpretation
- The active PR under review is no longer the earlier `develop/v2.0.6` PR referenced in older notes.
- Future overnight docs/review should use PR #83 as the active dev-branch context unless a newer PR supersedes it.

## Backend auth / graph checks

### Direct backend checks
- authenticated `POST /data-model/sparql` returned **200**
- sample site query returned one site binding:
  - `http://openfdd.local/site#site_c6fd9156_7591_4840_ad23_15e78588dfe5`

### Interpretation
- The daytime auth-path fix appears to be holding for direct backend SPARQL access.
- This materially improves overnight trust compared with the earlier blanket-401 state.

### Classification
- **improved auth/config state**

## Docs link check

### Checked
- docs home: <https://bbartling.github.io/open-fdd/> -> 200
- LLM workflow trailing slash: <https://bbartling.github.io/open-fdd/modeling/llm_workflow/> -> 404
- LLM workflow no trailing slash: <https://bbartling.github.io/open-fdd/modeling/llm_workflow> -> 200
- docs PDF link: <https://github.com/bbartling/open-fdd/blob/master/pdf/open-fdd-docs.pdf> -> 200

### Interpretation
- The published docs route fragility for `llm_workflow` still exists.
- This remains a **documentation gap / route inconsistency**.

## Container/runtime evidence

### Docker access from this host
Attempted:
- `docker ps --format ...`

Observed:
- Docker Desktop Linux engine pipe unavailable:
  - `open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified`

### Interpretation
- Live container log review for `api`, `frontend`, `bacnet-scraper`, `fdd-loop`, `host-stats`, `bacnet-server` is still blocked from this host.

### Classification
- **testbench limitation**

## BACnet / gateway note

### First read attempt
A first POST to the DIY BACnet gateway `client_read_property` route returned JSON-RPC validation errors indicating the request body shape was wrong.

Interpretation:
- this does **not** yet prove BACnet read failure
- it shows the current tool-side request contract being used here is wrong for that endpoint
- next overnight step should inspect the gateway API contract and issue a correctly shaped JSON-RPC request before making any BACnet-side judgment

### Classification
- **tooling / API-contract mismatch**

## Current overnight stance

### Improved
- backend auth/SPARQL access is in a better place than earlier today

### Still weak
- container evidence unavailable from this host
- BACnet-side independent read not yet re-established with the correct request contract
- docs route inconsistency still present

## Highest-value next steps tonight

1. inspect the DIY BACnet gateway API contract and re-run one correct live BACnet read
2. continue targeted SPARQL/frontend parity isolation after the auth improvement
3. verify fault outputs against fake-device schedules once BACnet-side independent evidence is in hand
4. keep using PR #83 as the active dev-branch review context
