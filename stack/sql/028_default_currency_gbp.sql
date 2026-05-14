-- Default site_energy_rates.currency to GBP; this is a UK deployment.
-- The seed insert from migration 024 created rows tagged 'USD' before this
-- preference was known, so flip those over too. Sites that have manually been
-- set to anything other than 'USD' are left alone.

ALTER TABLE site_energy_rates ALTER COLUMN currency SET DEFAULT 'GBP';

UPDATE site_energy_rates SET currency = 'GBP' WHERE currency = 'USD';
