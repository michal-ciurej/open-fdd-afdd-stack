-- Phase 4: align `equipment.equipment_type` to Brick 1.4 long-form so the FDD
-- rule selector (which compares strings between the rule YAML's `equipment_type:`
-- list and the TTL's `ofdd:equipmentType` literals) stops dropping rules on a
-- vocabulary mismatch.
--
-- Why we have to do this in SQL rather than relying on the API validators:
--   - The API validators added in `openfdd_stack/platform/api/models.py` and
--     `api/data_model.py` only fire on writes. Existing rows touched only by
--     reads keep their legacy strings forever.
--   - The TTL writer's `coerce_to_brick_class` falls back to `brick:Equipment`
--     for unknown values at serialization time, but the persisted DB column
--     still carries the legacy string — every downstream SPARQL/lookup that
--     reads `equipment.equipment_type` directly (not via TTL) sees the wrong
--     thing.
--
-- This migration is **idempotent** — running it twice is a no-op. The
-- `IS DISTINCT FROM` guard skips rows already on the canonical form so the
-- migration leaves canonical rows alone and only rewrites the legacy ones.
--
-- Existing DBs: apply manually, e.g.
--   psql $OFDD_DB_DSN -f stack/sql/022_equipment_type_brick_14.sql

BEGIN;

-- 1. Map legacy short-forms / labels-with-spaces / dashed forms to Brick 1.4
--    long-form. Match is case-insensitive and dash-insensitive
--    (`brick:Cooling-Tower` and `cooling tower` both map to `Cooling_Tower`).
--    Keep this list in sync with `BRICK_14_ALIASES` in
--    `openfdd_stack/platform/brick_vocabulary.py`.
WITH alias_map(legacy_lower, canonical) AS (
    VALUES
        -- Brick 1.3 short-forms
        ('fcu', 'Fan_Coil_Unit'),
        ('vav', 'Variable_Air_Volume_Box'),
        ('ahu', 'Air_Handling_Unit'),
        ('rvav', 'Variable_Air_Volume_Box_With_Reheat'),
        -- Display labels with spaces
        ('fan coil unit', 'Fan_Coil_Unit'),
        ('variable air volume box', 'Variable_Air_Volume_Box'),
        ('variable air volume box with reheat', 'Variable_Air_Volume_Box_With_Reheat'),
        ('air handling unit', 'Air_Handling_Unit'),
        ('cooling tower', 'Cooling_Tower'),
        ('heat exchanger', 'Heat_Exchanger'),
        ('water pump', 'Water_Pump'),
        ('chilled water system', 'Chilled_Water_System'),
        ('condenser water system', 'Condenser_Water_System'),
        ('hot water system', 'Hot_Water_System'),
        ('weather service', 'Weather_Service'),
        ('building electrical meter', 'Building_Electrical_Meter'),
        ('electrical energy usage sensor', 'Electrical_Energy_Usage_Sensor'),
        -- Lowercase forms of the canonical (someone forgot the capital)
        ('fan_coil_unit', 'Fan_Coil_Unit'),
        ('variable_air_volume_box', 'Variable_Air_Volume_Box'),
        ('air_handling_unit', 'Air_Handling_Unit'),
        ('cooling_tower', 'Cooling_Tower'),
        ('heat_exchanger', 'Heat_Exchanger'),
        ('water_pump', 'Water_Pump'),
        ('chilled_water_system', 'Chilled_Water_System'),
        ('weather_service', 'Weather_Service')
)
UPDATE equipment e
SET equipment_type = m.canonical
FROM alias_map m
WHERE LOWER(REPLACE(TRIM(e.equipment_type), '-', '_')) = m.legacy_lower
  AND e.equipment_type IS DISTINCT FROM m.canonical;

-- 2. Strip a stray `brick:` prefix that sometimes leaks in from copy-pasted
--    SPARQL examples (e.g. `brick:Fan_Coil_Unit`). Apply after the alias map so
--    the alias map keeps its plain-string form and we don't have to duplicate
--    every entry with a prefix variant.
UPDATE equipment
SET equipment_type = SUBSTRING(equipment_type FROM 7)
WHERE equipment_type LIKE 'brick:%';

-- 3. Default NULLs to Brick 1.4 generic `Equipment` so the TTL writer no
--    longer has to infer one. Matches the new Niagara-discovery default in
--    `openfdd_stack/platform/drivers/niagara.py`.
UPDATE equipment
SET equipment_type = 'Equipment'
WHERE equipment_type IS NULL;

-- 4. Diagnostic: list any rows that are *still* outside the Brick 1.4
--    allowlist after the rewrites above. The TTL writer will coerce these to
--    `brick:Equipment` at serialization time, but the persisted column should
--    really be hand-fixed. The most likely culprit is a row tagged with a
--    structural / aggregating class like `Chilled_Water_System` that should be
--    split into per-device equipment rows (Chiller, Pump, Cooling_Tower, …)
--    rather than just renamed. Surface that here so the operator sees it.
DO $$
DECLARE
    bad_count int;
BEGIN
    SELECT COUNT(*) INTO bad_count FROM equipment
    WHERE equipment_type NOT IN (
        'Equipment',
        'Air_Handling_Unit', 'Boiler', 'Chiller', 'Cooling_Tower',
        'Fan_Coil_Unit', 'Heat_Exchanger', 'Pump',
        'Variable_Air_Volume_Box', 'Variable_Air_Volume_Box_With_Reheat',
        'Water_Pump',
        'Chilled_Water_System', 'Condenser_Water_System', 'Hot_Water_System',
        'Weather_Service',
        'Building_Electrical_Meter', 'Electrical_Energy_Usage_Sensor'
    );
    IF bad_count > 0 THEN
        RAISE NOTICE
            '022 migration: % equipment row(s) still carry a non-Brick-1.4 equipment_type. '
            'TTL writer will coerce these to brick:Equipment but you should fix them by hand. '
            'Run: SELECT id, name, equipment_type FROM equipment WHERE equipment_type NOT IN (...) '
            '— see the allowlist in openfdd_stack/platform/brick_vocabulary.py.',
            bad_count;
    ELSE
        RAISE NOTICE '022 migration: equipment.equipment_type is fully aligned to Brick 1.4.';
    END IF;
END $$;

COMMIT;
