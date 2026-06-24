-- Multiple station endpoints per site (Niagara / IQVision).
--
-- Before: a site could have at most ONE Niagara and ONE IQVision endpoint
-- (UNIQUE(site_id) on each endpoint table), and every point on the site was
-- synced from that single endpoint. This blocked multi-controller sites
-- (e.g. several Niagara JACEs in one building).
--
-- After:
--   * Endpoints are named and a site may own many per driver
--     (UNIQUE(site_id, name) instead of UNIQUE(site_id)).
--   * Each point records which endpoint discovered it
--     (points.niagara_endpoint_id / points.iqvision_endpoint_id).
--   * Point uniqueness becomes endpoint-aware via a generated `endpoint_key`
--     so two controllers exposing identical nav ORDs no longer collide on
--     (site_id, external_id). external_id itself is left untouched, so all
--     downstream references (Brick TTL, FDD input maps, energy) are preserved.
--
-- Requires PostgreSQL 12+ (STORED generated columns).
--
-- Existing DBs: apply manually, e.g.
--   psql $OFDD_DB_DSN -f stack/sql/033_multi_station_endpoints.sql

-- ---------------------------------------------------------------------------
-- 1. Endpoint tables: drop the one-per-site constraint, add a name.
-- ---------------------------------------------------------------------------

-- Niagara
ALTER TABLE site_niagara_endpoints
  DROP CONSTRAINT IF EXISTS site_niagara_endpoints_site_id_key;
ALTER TABLE site_niagara_endpoints
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'default';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_site_niagara_endpoints_site_name'
  ) THEN
    ALTER TABLE site_niagara_endpoints
      ADD CONSTRAINT uq_site_niagara_endpoints_site_name UNIQUE (site_id, name);
  END IF;
END $$;

-- IQVision
ALTER TABLE site_iqvision_endpoints
  DROP CONSTRAINT IF EXISTS site_iqvision_endpoints_site_id_key;
ALTER TABLE site_iqvision_endpoints
  ADD COLUMN IF NOT EXISTS name text NOT NULL DEFAULT 'default';
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_site_iqvision_endpoints_site_name'
  ) THEN
    ALTER TABLE site_iqvision_endpoints
      ADD CONSTRAINT uq_site_iqvision_endpoints_site_name UNIQUE (site_id, name);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Points: link each point to the endpoint that discovered it.
--    A point belongs to at most one station endpoint; BACnet / Modbus /
--    weather points leave both columns NULL.
-- ---------------------------------------------------------------------------

ALTER TABLE points
  ADD COLUMN IF NOT EXISTS niagara_endpoint_id uuid
    REFERENCES site_niagara_endpoints(id) ON DELETE CASCADE;
ALTER TABLE points
  ADD COLUMN IF NOT EXISTS iqvision_endpoint_id uuid
    REFERENCES site_iqvision_endpoints(id) ON DELETE CASCADE;

-- Generated discriminator used in the uniqueness key. Non-station points all
-- collapse to the all-zeros sentinel so (site_id, external_id) stays unique
-- for them exactly as before; station points key on their endpoint id.
ALTER TABLE points
  ADD COLUMN IF NOT EXISTS endpoint_key uuid
  GENERATED ALWAYS AS (
    COALESCE(niagara_endpoint_id, iqvision_endpoint_id,
             '00000000-0000-0000-0000-000000000000'::uuid)
  ) STORED;

CREATE INDEX IF NOT EXISTS idx_points_niagara_endpoint
  ON points (niagara_endpoint_id) WHERE niagara_endpoint_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_points_iqvision_endpoint
  ON points (iqvision_endpoint_id) WHERE iqvision_endpoint_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Backfill: attach existing station points to their site's single
--    endpoint. Sites with BOTH a Niagara and an IQVision endpoint cannot be
--    disambiguated automatically (both drivers share the niagara_* columns),
--    so their points are attached to the Niagara endpoint; re-scan each
--    endpoint afterwards to settle ownership precisely.
-- ---------------------------------------------------------------------------

UPDATE points p
SET niagara_endpoint_id = e.id
FROM site_niagara_endpoints e
WHERE e.site_id = p.site_id
  AND p.niagara_endpoint_id IS NULL
  AND p.iqvision_endpoint_id IS NULL
  AND (p.niagara_nav_ord IS NOT NULL OR p.niagara_history_path IS NOT NULL);

UPDATE points p
SET iqvision_endpoint_id = e.id
FROM site_iqvision_endpoints e
WHERE e.site_id = p.site_id
  AND p.niagara_endpoint_id IS NULL
  AND p.iqvision_endpoint_id IS NULL
  AND (p.niagara_nav_ord IS NOT NULL OR p.niagara_history_path IS NOT NULL);

-- ---------------------------------------------------------------------------
-- 4. Swap the point-uniqueness constraint for the endpoint-aware key.
--    Done after backfill so endpoint_key is fully populated; the old
--    (site_id, external_id) uniqueness implies the new one is satisfiable.
-- ---------------------------------------------------------------------------

-- Drop ANY unique constraint on exactly (site_id, external_id), regardless of
-- the auto-generated name — leaving the old 2-column constraint in place would
-- silently defeat multi-endpoint support.
DO $$
DECLARE
  r record;
  target int[];
BEGIN
  SELECT array_agg(attnum::int ORDER BY attnum) INTO target
  FROM pg_attribute
  WHERE attrelid = 'points'::regclass
    AND attname IN ('site_id', 'external_id')
    AND NOT attisdropped;

  FOR r IN
    SELECT conname, conkey
    FROM pg_constraint
    WHERE conrelid = 'points'::regclass AND contype = 'u'
  LOOP
    IF (SELECT array_agg(k::int ORDER BY k) FROM unnest(r.conkey) AS k) = target THEN
      EXECUTE format('ALTER TABLE points DROP CONSTRAINT %I', r.conname);
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'points_site_extid_endpoint_uq'
  ) THEN
    ALTER TABLE points
      ADD CONSTRAINT points_site_extid_endpoint_uq
      UNIQUE (site_id, external_id, endpoint_key);
  END IF;
END $$;
