-- Equipment-scoped energy opportunities. Replaces the per-row site-level shape of
-- energy_calculations.parameters: design values move to equipment_energy_profile,
-- utility rates move to site_energy_rates, and only the deltas specific to this
-- opportunity (current value vs design, override hours, etc.) live here.
--
-- Differences from energy_calculations:
--   * equipment_id is NOT NULL — every opportunity belongs to one piece of equipment
--   * fdd_rule_id references fault_definitions(fault_id) so an opportunity can be
--     auto-seeded when an FDD rule fires (phase 3)
--   * measure_family is a typed enum-via-CHECK that drives the UI dialog filter
--   * capex_usd is first-class, not buried in JSONB
--
-- The old energy_calculations table is left in place during phase 2-4 and dropped
-- in phase 5 after the data migration.

CREATE TABLE IF NOT EXISTS energy_opportunities (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_id    uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    external_id     text NOT NULL,
    name            text NOT NULL,
    description     text,
    measure_family  text NOT NULL
        CHECK (measure_family IN ('runtime','setpoint_reset','airside_thermal','degradation')),
    calc_type       text NOT NULL,
    fdd_rule_id     text REFERENCES fault_definitions(fault_id) ON DELETE SET NULL,
    delta_params    jsonb NOT NULL DEFAULT '{}'::jsonb,
    capex_usd       numeric NOT NULL DEFAULT 0,
    enabled         boolean NOT NULL DEFAULT true,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT energy_opportunities_equipment_external_unique UNIQUE (equipment_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_energy_opportunities_equipment
    ON energy_opportunities(equipment_id);
CREATE INDEX IF NOT EXISTS idx_energy_opportunities_rule
    ON energy_opportunities(fdd_rule_id) WHERE fdd_rule_id IS NOT NULL;
