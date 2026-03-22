# Testing Plan

This is the evolving engineering plan for Open-FDD automated testing.

## Near-term priorities

### 1. Restore authenticated backend graph checks

Problem:
- `POST /data-model/sparql` currently returns `401 Missing or invalid Authorization header` from this test bench.

Action:
- ensure `OFDD_API_KEY` is available to the automated testing environment
- verify the SPARQL suite and parity suite can run unattended

Why it matters:
- without authenticated SPARQL/API access, BACnet graph validation is incomplete

### 2. Promote BACnet addressing to a first-class validation target

We need to explicitly validate:
- BACnet devices in the graph
- device instance and address visibility
- object identifiers for polling points
- semantic equipment type for those points

This is no longer optional background metadata. It is core operational context.

### 3. Prove fault calculation from end to end

The target standard is:
- fake BACnet device fault schedule is known
- BACnet gateway confirms source values
- Open-FDD scrape path receives those values
- YAML rules + rolling windows predict an expected fault
- Open-FDD fault outputs show that exact fault

### 4. Preserve reusable context for future clones

The repo should keep visible documentation for:
- the operational states
- overnight review discipline
- BACnet graph context
- portability assumptions
- future optimization intent

## Future role in live HVAC systems

In a live HVAC deployment, the same testing and validation assets should support:

- confidence in FDD outputs
- confidence in model/rule applicability
- future optimization and supervisory logic
- operator- or facility-manager-facing monitoring summaries

The repo is not only a test harness. It is becoming a reproducible engineering context pack.
