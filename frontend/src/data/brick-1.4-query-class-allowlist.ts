/**
 * Brick RDF **class** local names (no `brick:` prefix) used by predefined Data Model Testing SPARQL.
 *
 * Single source of truth: `openfdd_stack/platform/brick_vocabulary.py`. This file mirrors the
 * Python `BRICK_14_QUERY_CLASS_ALLOWLIST` constant so the UI can render selects without a
 * round-trip — keep them in sync when adding a class. The API exposes the same list at
 * `GET /data-model/vocabulary` for clients that prefer to fetch it.
 *
 * Brick 1.4 long-form is canonical: `Fan_Coil_Unit` (not `FCU`), `Variable_Air_Volume_Box`
 * (not `VAV`). Legacy short-forms are accepted on import via case-insensitive aliases on the
 * server, but selects/displays should always render the long-form.
 *
 * Predicate names (`feeds`, `isPointOf`, …) are **not** classes and must not appear here.
 */
export const BRICK_14_QUERY_CLASS_ALLOWLIST = new Set<string>([
  // Top-level / non-equipment
  "Site",
  "Building",
  "Floor",
  "HVAC_Equipment",
  "HVAC_Zone",
  "Equipment",
  "Point",
  // HVAC equipment (long-form)
  "Air_Handling_Unit",
  "Boiler",
  "Chiller",
  "Cooling_Tower",
  "Fan_Coil_Unit",
  "Heat_Exchanger",
  "Pump",
  "Variable_Air_Volume_Box",
  "Variable_Air_Volume_Box_With_Reheat",
  "Water_Pump",
  // HVAC subsystems / virtual equipment
  "Chilled_Water_System",
  "Condenser_Water_System",
  "Hot_Water_System",
  "Weather_Service",
  // Electrical
  "Building_Electrical_Meter",
  "Electrical_Energy_Usage_Sensor",
]);

/** Predicates in the Brick namespace that appear as `brick:local` but are not classes. */
export const BRICK_PREDICATE_LOCAL_NAMES = new Set<string>([
  "feeds",
  "isFedBy",
  "isPointOf",
  "isPartOf",
]);
