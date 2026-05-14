-- Typed engineering/sizing values per equipment, consumed by the energy cost
-- calculator. Lifts the subset of values that drive opportunity calculations out
-- of equipment.metadata.engineering JSONB into a stable shape the calc resolver
-- can read directly. Fields not filled in stay NULL; the resolver falls back to
-- platform defaults at compute time.
--
-- One-to-one with equipment via PK = equipment_id so a row may or may not exist;
-- the API upserts on PUT. Cascade-delete matches the rest of the equipment
-- ownership chain.

CREATE TABLE IF NOT EXISTS equipment_energy_profile (
    equipment_id                uuid PRIMARY KEY REFERENCES equipment(id) ON DELETE CASCADE,
    nameplate_kw                numeric,
    motor_hp                    numeric,
    motor_efficiency            numeric,
    design_cfm                  numeric,
    design_sat_f                numeric,
    design_static_pressure_inwc numeric,
    design_cop                  numeric,
    design_heating_efficiency   numeric,
    occupied_hours_per_year     numeric,
    updated_at                  timestamptz NOT NULL DEFAULT now()
);

-- Backfill design_cfm from existing engineering metadata where the value is a
-- plain numeric string. Other typed columns start NULL until the operator fills
-- them via the UI. The regex guard skips empty strings and any value with units
-- or commas baked in so the cast never raises.
INSERT INTO equipment_energy_profile (equipment_id, design_cfm)
SELECT
    e.id,
    (e.metadata->'engineering'->'mechanical'->>'design_cfm')::numeric
FROM equipment e
WHERE e.metadata->'engineering'->'mechanical'->>'design_cfm' ~ '^[0-9]+(\.[0-9]+)?$'
ON CONFLICT (equipment_id) DO NOTHING;
