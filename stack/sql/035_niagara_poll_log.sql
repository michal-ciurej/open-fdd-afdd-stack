-- Per-cycle observability log for the Niagara polling driver.
--
-- One row per (endpoint, folder) BQL request, plus one summary row per endpoint
-- cycle. Cheap to read for a "Last Niagara poll" status pill and to answer
-- "why is my equipment silent" support questions. Not a hypertable — retention
-- is expected to be handled by a periodic DELETE (a week or two of history is
-- plenty for a diagnostic log).

CREATE TABLE IF NOT EXISTS niagara_poll_log (
    run_ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    endpoint_id      UUID,
    endpoint_name    TEXT,
    site_id          UUID,
    folder_ord       TEXT,                -- NULL on cycle-summary rows
    status           TEXT NOT NULL,       -- 'ok' | 'http_error' | 'parse_error' | 'timeout' | 'skipped' | 'summary'
    rows_seen        INTEGER,
    rows_inserted    INTEGER,
    rows_unmatched   INTEGER,
    duration_ms      INTEGER,
    error            TEXT
);

CREATE INDEX IF NOT EXISTS idx_niagara_poll_log_run_ts
  ON niagara_poll_log (run_ts DESC);

CREATE INDEX IF NOT EXISTS idx_niagara_poll_log_endpoint
  ON niagara_poll_log (endpoint_id, run_ts DESC);

COMMENT ON TABLE niagara_poll_log IS
  'Diagnostic log for the Niagara polling driver. One row per BQL request and one summary row per endpoint cycle. Reap periodically (e.g. DELETE FROM niagara_poll_log WHERE run_ts < NOW() - INTERVAL ''14 days'').';
