-- Niagara live-value polling: per-endpoint enable + politeness delay.
--
-- Live polling is opt-in per endpoint. `enabled` (existing) gates history sync and
-- other endpoint-level operations; `poll_enabled` is a distinct switch so an
-- operator can leave history sync running while temporarily quiescing polling
-- on a fragile JACE, or the reverse.
--
-- `poll_equipment_delay_ms` overrides the platform-level default from
-- OFDD_NIAGARA_POLL_EQUIPMENT_DELAY_MS on a per-endpoint basis. NULL falls back
-- to the platform setting. Increase for stations that struggle under the
-- default cadence; decrease when the station is beefy and points are many.
--
-- `points.niagara_nav_ord` (already exists as of migration 033) is the address
-- polling uses to build the per-equipment BQL scope. `points.polling`
-- (from migration 011) still gates individual points within a polled endpoint.

ALTER TABLE site_niagara_endpoints
  ADD COLUMN IF NOT EXISTS poll_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE site_niagara_endpoints
  ADD COLUMN IF NOT EXISTS poll_equipment_delay_ms integer;

COMMENT ON COLUMN site_niagara_endpoints.poll_enabled IS
  'Master switch for live-value polling on this Niagara endpoint. Default off; must be flipped on explicitly. Independent of `enabled` (which gates history sync).';
COMMENT ON COLUMN site_niagara_endpoints.poll_equipment_delay_ms IS
  'Sleep between successive BQL requests to this JACE, in ms. NULL = fall back to OFDD_NIAGARA_POLL_EQUIPMENT_DELAY_MS.';

-- Partial index: only rows where polling is actually turned on. Poll driver's
-- endpoint enumeration scans by this predicate.
CREATE INDEX IF NOT EXISTS idx_site_niagara_endpoints_poll_enabled
  ON site_niagara_endpoints (id)
  WHERE poll_enabled = true;
