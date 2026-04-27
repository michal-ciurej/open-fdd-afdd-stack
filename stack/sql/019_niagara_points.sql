-- Niagara 4 history integration
-- niagara_history_path: the history identifier used in BQL FROM clauses,
-- e.g. /StationName/AHU1/SupplyAirTemp  → FROM history:/StationName/AHU1/SupplyAirTemp
ALTER TABLE points
  ADD COLUMN IF NOT EXISTS niagara_history_path text;

CREATE INDEX IF NOT EXISTS idx_points_niagara_path
  ON points (niagara_history_path)
  WHERE niagara_history_path IS NOT NULL;
