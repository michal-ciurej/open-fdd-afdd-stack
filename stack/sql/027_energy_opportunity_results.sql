-- Cached computed result per opportunity. Refreshed on every PATCH/POST and on
-- demand via /energy-opportunities/{id}/recompute. Phase 3 adds nightly refresh
-- driven by the FDD loop tick so trailing-365d fault_hours_observed stays current
-- without operator action.
--
-- One-to-one with energy_opportunities via PK = opportunity_id. Cascade-delete
-- matches the parent.

CREATE TABLE IF NOT EXISTS energy_opportunity_results (
    opportunity_id            uuid PRIMARY KEY REFERENCES energy_opportunities(id) ON DELETE CASCADE,
    baseline_annual_cost_usd  numeric,
    projected_annual_cost_usd numeric,
    annual_savings_usd        numeric,
    annual_kwh_saved          numeric,
    annual_therms_saved       numeric,
    peak_kw_reduced           numeric,
    simple_payback_years      numeric,
    npv_5yr_usd               numeric,
    fault_hours_observed      numeric,
    data_quality              text NOT NULL DEFAULT 'assumed'
        CHECK (data_quality IN ('observed','partial','assumed')),
    missing_inputs            jsonb NOT NULL DEFAULT '[]'::jsonb,
    notes                     text,
    computed_at               timestamptz NOT NULL DEFAULT now()
);
