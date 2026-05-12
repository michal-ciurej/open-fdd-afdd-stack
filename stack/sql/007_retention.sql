-- Data retention: drop hypertable chunks older than the configured interval.
-- Default 365 days; override at bootstrap with --retention-days N or OFDD_RETENTION_DAYS in platform/.env.
--
-- IMPORTANT: add_retention_policy() is a TimescaleDB Community (TSL) feature and is
-- NOT available on Azure Database for PostgreSQL Flexible Server (which ships only
-- Apache-licensed Timescale). On Apache deployments this migration is a no-op and
-- retention must be implemented externally — either via pg_cron + drop_chunks, or
-- via a job in the fdd-loop ACA container.
--
-- Each policy call is wrapped in its own DO block so a license failure on one table
-- doesn't roll back the others, and so the whole migration succeeds on both editions.

DO $$
BEGIN
  PERFORM add_retention_policy('timeseries_readings', drop_after => INTERVAL '365 days', if_not_exists => true);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'add_retention_policy(timeseries_readings) skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  PERFORM add_retention_policy('fault_results', drop_after => INTERVAL '365 days', if_not_exists => true);
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'add_retention_policy(fault_results) skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'host_metrics') THEN
    PERFORM add_retention_policy('host_metrics', drop_after => INTERVAL '365 days', if_not_exists => true);
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'add_retention_policy(host_metrics) skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'container_metrics') THEN
    PERFORM add_retention_policy('container_metrics', drop_after => INTERVAL '365 days', if_not_exists => true);
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'add_retention_policy(container_metrics) skipped: %', SQLERRM;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM timescaledb_information.hypertables WHERE hypertable_name = 'disk_metrics') THEN
    PERFORM add_retention_policy('disk_metrics', drop_after => INTERVAL '365 days', if_not_exists => true);
  END IF;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'add_retention_policy(disk_metrics) skipped: %', SQLERRM;
END $$;
