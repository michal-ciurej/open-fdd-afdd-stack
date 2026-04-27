-- IQVision per-site endpoints. The station scan / history sync use the same
-- ORD-embedded BQL shape as Niagara, so we reuse the existing point metadata
-- columns (niagara_nav_ord, niagara_tags, niagara_history_path). Only the
-- equipment-grouping rule differs: IQVision groups by the BQL Device column
-- (proxyExt.device.displayName) instead of the nav ORD folder twice removed.
--
-- A site may have one Niagara endpoint and/or one IQVision endpoint.
--
-- Existing DBs: apply manually, e.g.
--   psql $OFDD_DB_DSN -f stack/sql/021_iqvision_sites.sql

CREATE TABLE IF NOT EXISTS site_iqvision_endpoints (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id       uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  base_url      text NOT NULL,
  username      text NOT NULL,
  password      text NOT NULL,
  ssl_verify    boolean NOT NULL DEFAULT true,
  enabled       boolean NOT NULL DEFAULT true,
  last_scan_ts  timestamptz,
  last_sync_ts  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id)
);

CREATE INDEX IF NOT EXISTS idx_site_iqvision_endpoints_site
  ON site_iqvision_endpoints (site_id);
