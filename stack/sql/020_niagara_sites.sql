-- Niagara per-site endpoints and richer point metadata for BQL station scans.
--
-- Existing DBs: apply manually, e.g.
--   psql $OFDD_DB_DSN -f stack/sql/020_niagara_sites.sql

CREATE TABLE IF NOT EXISTS site_niagara_endpoints (
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

CREATE INDEX IF NOT EXISTS idx_site_niagara_endpoints_site
  ON site_niagara_endpoints (site_id);

-- Point-level Niagara metadata captured from station scans.
-- niagara_nav_ord: the full station nav ORD path of the point (for ref + re-scan).
-- niagara_tags:    namespace:key=value tags parsed from the Tags column (jsonb object).
ALTER TABLE points
  ADD COLUMN IF NOT EXISTS niagara_nav_ord text,
  ADD COLUMN IF NOT EXISTS niagara_tags jsonb;

CREATE INDEX IF NOT EXISTS idx_points_niagara_nav_ord
  ON points (niagara_nav_ord)
  WHERE niagara_nav_ord IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_points_niagara_tags_gin
  ON points USING gin (niagara_tags)
  WHERE niagara_tags IS NOT NULL;
