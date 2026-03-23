# Pre-Overnight Readiness — 2026-03-23

- **Review time:** 2026-03-23 13:55 CDT
- **Reviewer:** OpenClaw
- **Intent:** document what is ready for tonight's long-run test, what still falls short, and what evidence is still missing.

## Bottom line

**Not fully green yet.**

The test bench is in a better place than this morning, especially on backend auth, but it is **not yet fully trustworthy** for tonight's long-term run until the post-auth SPARQL/frontend parity failure is isolated and the FDD/fault-verification path is explicitly revalidated.

## What improved today

### 1) Direct backend auth improved
Evidence gathered today showed:
- authenticated direct `POST /data-model/sparql` returned **200**
- the SPARQL/parity script was patched to load the active Open-FDD auth file from:
  - `C:\Users\ben\.openclaw\workspace\open-fdd\stack\.env`

Interpretation:
- the earlier blanket `401 Missing or invalid Authorization header` problem was largely an **auth/load-path problem in the automated-testing runtime**, not proof that Open-FDD backend auth was fundamentally broken.

### 2) Focused SPARQL/frontend parity got meaningfully farther
After the auth-path fix, the focused rerun no longer immediately died on 401s.

Observed passing signals included:
- graph/DB sync OK
- BACnet address visibility OK for devices `3456789` and `3456790`
- multiple predefined Data Model Testing queries passed parity for at least part of the run:
  - Sites
  - AHUs
  - Zones
  - Building
  - VAV boxes
  - VAVs per AHU
  - Feed topology
  - Chillers

Interpretation:
- this is strong evidence that the biggest morning blocker (direct backend auth in the automated suite runtime) improved materially.

## What still falls short

### 1) SPARQL/frontend parity is still not fully clean
Even after auth improved, the focused parity run still exited non-zero later in the run.

Current classification:
- **automation/parity failure still present**
- **not yet isolated cleanly enough**

What this means:
- the test stack is better than before, but not yet fully trusted
- at least one additional parity/UI/backend mismatch or test-runner issue still exists after auth is loaded correctly

### 2) Full FDD verification is still not explicitly proven today
The desired expert-level chain is:
1. fake BACnet devices produce expected values/fault windows
2. BACnet data is ingested into Open-FDD
3. model/SPARQL context confirms the device/point relationships
4. rule logic and rolling-window expectations are satisfied
5. Open-FDD fault outputs show the expected calculated faults

That full chain is **not yet closed cleanly enough today**.

Current status:
- **fault-calculation verification remains incomplete / not yet fully proven**

### 3) Hot-reload verification is not re-proven yet
The current evidence set does not yet show a fresh clean pass for the hot-reload/FDD verification path after today's auth/parity changes.

Current status:
- **not yet verified cleanly for tonight**

### 4) Browser-driven parity still has at least one remaining rough edge
Because the focused predefined-button parity run still exited non-zero after several passes, there is likely at least one of these still happening:
- later predefined-query mismatch
- UI timing/staleness issue in the Data Model Testing page
- browser/test-runner instability
- a real parity discrepancy between UI and backend for some later query

Current classification:
- **likely UI/API parity rough edge or automation timing issue**
- **not yet sufficiently isolated**

## Open-FDD app components to watch tonight

These are the product/runtime areas that still deserve expert web-testing skepticism tonight:

### Data Model Testing / SPARQL parity
Watch for:
- UI table contents drifting from fresh backend results
- long-running/stale query render states
- later predefined query failures after earlier ones pass
- hidden frontend success masking backend mismatch

### Fault calculation / fault visibility
Watch for:
- fake-device fault windows not producing expected FDD outputs
- fault flags not appearing in `/faults/active`, `/faults/state`, or downloadable fault results when they should
- rolling-window expectations causing apparent lag that could be misread as failure
- plots/fault overlays showing UI evidence without a strong backend evidence chain

### BACnet discovery / graph consistency
Watch for:
- intermittent rediscovery problems for device `3456790`
- model/graph state changing between passes
- graph/DB drift after imports, discovery, or parity runs

### Automation/reporting reliability
Watch for:
- first-failure aborts preventing later evidence capture
- missing or incomplete summary logs
- browser parity paths burning time without giving a decisive verdict

## Recommended overnight stance

### Overnight readiness verdict
**Caution / not fully green yet.**

### Practical meaning
Tonight's long-term run can still be useful, but it should be treated as:
- a **high-signal evidence-gathering pass**, not yet a blindly trusted certification run
- a night to verify whether fault calculations are truly being produced from fake BACnet inputs end-to-end
- a night to capture where parity/testing still falls short, with product-vs-auth-vs-automation classification kept explicit

## Highest-priority things to verify tonight

1. **SPARQL/frontend parity failure after auth fix**
   - isolate the exact later failing query or UI step
2. **End-to-end fault calculation proof**
   - fake BACnet fault window -> ingested telemetry -> rule/rolling-window satisfaction -> Open-FDD fault output
3. **BACnet-side independent check**
   - at least one DIY BACnet RPC/property read correlated with modeled/Open-FDD-side evidence
4. **Hot-reload/FDD path**
   - confirm it still behaves as expected after the auth/runtime fixes

## Operator-style classification for tonight

- **Auth/config drift:** improved, but still worth rechecking at runtime
- **UI/API parity rough edge:** still likely present
- **FDD/fault-verification evidence gap:** still present
- **BACnet discovery/product issue:** possible intermittent rough edge, not yet proven as a stable product bug
- **Overnight trust level:** **caution**
