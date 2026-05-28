-- Per-site weekly operating schedule. Defines "in-hours" for compliance
-- analytics (in-hours schedule compliance %, average ΔT during operation,
-- average supply/flow temperatures during operation). Out-of-hours runtime
-- analytics also derive from this table.
--
-- dow uses ISO numbering (0=Mon..6=Sun) to match Postgres EXTRACT(isodow) - 1.
-- start_local / end_local are LOCAL wall-clock times in the site's tz; the
-- analytics layer applies the tz when filtering UTC-stored timeseries.

CREATE TABLE IF NOT EXISTS site_schedules (
    site_id      text NOT NULL,
    dow          smallint NOT NULL CHECK (dow BETWEEN 0 AND 6),
    start_local  time NOT NULL,
    end_local    time NOT NULL,
    tz           text NOT NULL DEFAULT 'Europe/London',
    PRIMARY KEY (site_id, dow)
);
