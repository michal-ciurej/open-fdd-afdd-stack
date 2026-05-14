-- Centralized utility rates per site. One row per site replaces the per-row rate
-- fields that lived inside energy_calculations.parameters (electric_rate_per_kwh,
-- therm_rate_usd) so opportunity calcs read rates from a single source of truth.
--
-- A default row is seeded for every existing site so GET never 404s on a newly
-- created or pre-existing site. The cascade matches the rest of the schema:
-- removing a site drops its rates row.

CREATE TABLE IF NOT EXISTS site_energy_rates (
    site_id               uuid PRIMARY KEY REFERENCES sites(id) ON DELETE CASCADE,
    electric_rate_per_kwh numeric NOT NULL DEFAULT 0.12,
    demand_charge_per_kw  numeric NOT NULL DEFAULT 0,
    therm_rate_usd        numeric NOT NULL DEFAULT 1.00,
    currency              text    NOT NULL DEFAULT 'USD',
    updated_at            timestamptz NOT NULL DEFAULT now()
);

INSERT INTO site_energy_rates (site_id)
SELECT id FROM sites
ON CONFLICT DO NOTHING;
