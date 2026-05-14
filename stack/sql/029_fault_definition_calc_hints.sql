-- Seed example calc-type hints into fault_definitions.params so the FDD-loop
-- auto-seed (openfdd_stack/platform/energy_auto_seed.py) creates disabled
-- opportunities when these rules fire.
--
-- Convention added by phase 3:
--   fault_definitions.params.default_calc_type      (text, must be in CALC_TYPE_SPECS)
--   fault_definitions.params.default_measure_family (text, runtime|setpoint_reset|airside_thermal|degradation)
--   fault_definitions.params.default_delta_params   (jsonb, optional starting deltas)
--
-- Rules without these keys are silently skipped by auto-seed. To extend
-- coverage, append more rows below or hand-edit fault_definitions.params via
-- psql. Each UPDATE is a deep-merge into the existing params blob so existing
-- cookbook params (inputs, expression, etc.) are preserved.
--
-- Safe to re-run: rules that don't exist (yet) are no-ops; rules that already
-- have these keys get their hints overwritten with the latest mapping below.

BEGIN;

CREATE TEMP TABLE _calc_hints (
    fault_id        text PRIMARY KEY,
    calc_type       text NOT NULL,
    measure_family  text NOT NULL,
    delta_params    jsonb NOT NULL DEFAULT '{}'::jsonb
);

INSERT INTO _calc_hints (fault_id, calc_type, measure_family, delta_params) VALUES
    -- Chiller plant
    ('chiller_no_load_flag',           'cop_gap_electric',       'degradation',    '{}'::jsonb),
    ('chiller_excessive_runtime_flag', 'runtime_electric_kw',    'runtime',        '{}'::jsonb),
    ('chiller_chws_off_sp_flag',       'chwst_reset_penalty_kw', 'setpoint_reset', '{}'::jsonb),
    ('chiller_cmd_status_mismatch_flag','runtime_electric_kw',   'runtime',        '{}'::jsonb),

    -- Boiler plant
    ('boiler_no_load_flag',            'boiler_standby_mix',     'degradation',    '{}'::jsonb),
    ('boiler_hws_off_sp_flag',         'pressure_ratio_motor_kw','setpoint_reset', '{}'::jsonb),

    -- Pumps
    ('pump_full_speed_extended_flag',  'vfd_affinity_cube',      'setpoint_reset', '{"speed_base_pct": 100, "speed_prop_pct": 70}'::jsonb),
    ('pump_dp_low_at_max_flag',        'pressure_ratio_motor_kw','setpoint_reset', '{}'::jsonb),

    -- Cooling tower
    ('cooling_tower_cws_high_flag',    'vfd_affinity_cube',      'setpoint_reset', '{"speed_base_pct": 100, "speed_prop_pct": 70}'::jsonb),
    ('cooling_tower_no_lift_flag',     'cop_gap_electric',       'degradation',    '{}'::jsonb),

    -- Fan-coil units
    ('fcu_simultaneous_heat_cool_flag','simultaneous_hydronic_btu','degradation',  '{}'::jsonb),
    ('fcu_zone_setpoint_drift_flag',   'runtime_electric_kw',    'runtime',        '{}'::jsonb)
;

UPDATE fault_definitions fd
   SET params = COALESCE(fd.params, '{}'::jsonb) || jsonb_build_object(
       'default_calc_type',      h.calc_type,
       'default_measure_family', h.measure_family,
       'default_delta_params',   h.delta_params
   ),
       updated_at = now()
  FROM _calc_hints h
 WHERE fd.fault_id = h.fault_id;

-- Diagnostic: how many rules now carry hints vs how many we tried to seed.
DO $$
DECLARE
    seeded int;
    tried int;
BEGIN
    SELECT COUNT(*) INTO tried FROM _calc_hints;
    SELECT COUNT(*) INTO seeded FROM fault_definitions
     WHERE params ? 'default_calc_type' AND params ? 'default_measure_family';
    RAISE NOTICE
        '029 hints: % of % attempted mappings now active in fault_definitions.params',
        seeded, tried;
END $$;

DROP TABLE _calc_hints;
COMMIT;
