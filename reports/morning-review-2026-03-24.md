# Morning review — 2026-03-24 06:10 CDT

## Executive summary
This morning’s evidence is mixed but pretty clear:
- **Selenium frontend suite:** PASS
- **BACnet discovery / graph address exposure:** PASS
- **SPARQL/frontend parity:** FAIL
- **BACnet long-run scraping:** INCONCLUSIVE
- **FDD fault verification:** INCONCLUSIVE
- **YAML hot reload:** INCONCLUSIVE
- **Automation/orchestrator reliability:** FAIL because `automated_suite.log` is missing

The main confirmed problem is still the SPARQL/frontend parity failure path. The rest of the overnight objectives did not leave enough durable evidence to call product regressions with confidence.

## Evidence checked
- `C:\Users\ben\OneDrive\Desktop\testing\automated_testing\overnight_bacnet.log`
- `C:\Users\ben\OneDrive\Desktop\testing\automated_testing\automated_suite.log`

## File status
### `overnight_bacnet.log`
- Present
- Last modified: `2026-03-23 18:17:40`
- Contains full frontend + parity evidence

### `automated_suite.log`
- **Missing**

This missing suite log is a serious limitation because it prevents confident morning judgment on the longer-run BACnet/FDD/hot-reload phases.

## Per-area results

### 1) Selenium frontend suite
**Result: PASS**

Evidence from `overnight_bacnet.log`:
- `=== E2E frontend tests passed ===`
- Site creation and payload import succeeded
- Negative import checks behaved correctly
- BACnet discovery via UI succeeded for both fake devices `3456789` and `3456790`
- Data Model, Points, Plots, Weather, and Overview smoke checks all completed without browser-console severe/warning entries

Additional nuance:
- Data Model Testing smoke hit a timeout waiting for the SPARQL-finished marker, but the test continued and the broader Selenium suite still passed.
- That is worth watching as product or timing fragility, but not enough by itself to flip the Selenium verdict to fail.

### 2) BACnet discovery / graph exposure
**Result: PASS**

Evidence from `overnight_bacnet.log`:
- `BACnet discovery: device 3456789 added to graph`
- `BACnet discovery: device 3456790 added to graph`
- `BACnet address check: OK - found devices 3456789 and 3456790.`

This is strong evidence that the fake BACnet devices were discovered into the Open-FDD graph during the overnight run.

### 3) SPARQL CRUD + frontend parity
**Result: FAIL**

Evidence from `overnight_bacnet.log`:
- `SPARQL CRUD + frontend parity failed with exit code 1`
- Earlier in the same log, there were **28 failed queries** in a run contaminated by `401 Missing or invalid Authorization header` during parity API re-fetches
- Later in the log, after auth was healthy, the run still ended with **4 failed queries**

The specific later failures were count-sensitive parity mismatches, including:
- `07_count_triples.sparql`
- `23_orphan_external_references.sparql`

Interpretation:
- There is confirmed parity instability between frontend-visible query results and backend/API reference results.
- Some of the earlier overnight failures were amplified by auth/config drift.
- Even after auth was restored, a smaller but real parity mismatch remained.

That makes the best current classification:
- **confirmed product bug or synchronization issue in frontend/API parity for count-oriented SPARQL results**, with earlier auth drift also present in parts of the run.

### 4) BACnet long-run scraping
**Result: INCONCLUSIVE**

Why:
- The checked log does not prove that the long-run BACnet scraping phase completed successfully end to end.
- `automated_suite.log` is missing, so there is no durable orchestrator-level evidence that the longer BACnet scrape phase finished, ran for the intended duration, or produced expected summaries.

Conclusion:
- No confident PASS
- No confident product FAIL
- Best classification is **automation gap / missing evidence**

### 5) FDD fault verification
**Result: INCONCLUSIVE**

Why:
- The available overnight log proves frontend and graph/BACnet discovery activity, but it does not provide the missing end-to-end evidence chain for:
  1. fake BACnet schedule ran long enough
  2. telemetry landed over the intended window
  3. YAML rule + rolling-window preconditions were satisfied
  4. Open-FDD fault outputs matched the expected faults

Without the suite log or fault-output evidence, this morning review cannot honestly claim PASS or FAIL.

### 6) YAML hot reload
**Result: INCONCLUSIVE**

Why:
- No `automated_suite.log`
- No durable morning evidence that the hot-reload step executed and passed
- No durable morning evidence that it executed and failed either

This remains an overnight workflow coverage gap rather than a confirmed Open-FDD bug.

## Root-cause / classification summary

### Confirmed or likely product bug
1. **SPARQL/frontend parity mismatch on count-sensitive queries**
   - Specifically visible in triple-count and orphan-reference style queries
   - Persisted even after auth was restored later in the overnight context

### Setup drift / auth-config drift
1. **Intermittent backend auth unavailability during parts of the parity run**
   - `401 Missing or invalid Authorization header` appears repeatedly in the log for parity API re-fetches
   - This likely inflated the number of early parity failures

### Automation / testbench limitation
1. **Missing `automated_suite.log`**
   - Prevents confident morning judgment on long-run BACnet scraping, FDD, and hot reload
2. **Incomplete durable evidence chain for end-to-end fault verification**
   - No morning-grade proof of expected fake-device fault windows producing matching Open-FDD fault outputs

## GitHub issue decision
### Existing issues checked on `bbartling/open-fdd`
Open issues already include:
- `#82` Broken README links for LLM workflow docs and canonical prompt file
- other broader docs / security / enhancement issues

### Should a new issue be opened this morning?
**Decision: no new issue posted right now.**

Reason:
- The one strongest product-level finding is the SPARQL/frontend parity mismatch.
- That finding is real, but the morning evidence is still mixed with overnight auth drift and missing orchestrator logs.
- I want a tighter reproduction boundary before posting a fresh bug issue so it does not collapse multiple root causes into one vague report.

If a new issue is later filed, the cleanest scope would be something like:
- frontend Data Model Testing parity mismatch on count-oriented queries (`07_count_triples`, `23_orphan_external_references`) even when backend auth is healthy

That issue should explicitly exclude:
- generic `401` auth drift
- long-run BACnet/FDD coverage gaps caused by missing `automated_suite.log`

## Recommended next actions
1. **Restore reliable suite logging first**
   - Ensure `automated_suite.py` always writes `automated_suite.log`
   - Morning review is too blind without it

2. **Reproduce parity failure in a clean authenticated context**
   - Re-run the SPARQL/frontend parity path with confirmed backend auth present for the full run
   - Focus on:
     - `07_count_triples.sparql`
     - `23_orphan_external_references.sparql`
   - Capture API vs frontend result deltas cleanly

3. **Keep BACnet/FDD claims conservative until long-run evidence is durable**
   - BACnet discovery is proven
   - BACnet long-run scrape and FDD fault outcomes are not yet proven this morning

4. **Treat missing suite log as its own automation bug / bench limitation**
   - Even if the product is healthy, the overnight process is not yet trustworthy enough without durable orchestrator evidence

## Morning verdict table
- **Selenium frontend:** PASS
- **BACnet discovery to graph:** PASS
- **SPARQL parity:** FAIL
- **BACnet scraping (long-run):** INCONCLUSIVE
- **FDD verification:** INCONCLUSIVE
- **Hot reload:** INCONCLUSIVE
- **Automation logging/orchestration:** FAIL
