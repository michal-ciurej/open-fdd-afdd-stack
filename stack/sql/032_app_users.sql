-- Login-derived roster of Entra-authenticated users.
--
-- The SWA principal only forwards the Entra object id (oid), preferred_username
-- (email), and App Roles — there is no Graph integration to enumerate the whole
-- directory. We capture identity on every /auth/me call so the admin "User access"
-- page has a roster to assign sites against. A user therefore appears here once
-- they have signed in at least once.
--
-- Role tier (admin/engineer/user) still comes from Entra App Roles via the SWA
-- principal at request time; the `roles` column here is a cached snapshot for
-- display only and is refreshed on each login.
--
-- Per-site grants live in user_site_permissions (023). Machine callers are never
-- recorded here.
--
-- Apply on an existing stack:
--   psql $OFDD_DB_DSN -f stack/sql/032_app_users.sql

CREATE TABLE IF NOT EXISTS app_users (
    oid         TEXT        PRIMARY KEY,        -- Entra object id (stable per user)
    email       TEXT,                           -- preferred_username / userDetails
    roles       TEXT[]      NOT NULL DEFAULT '{}',  -- cached App Roles snapshot (display only)
    first_seen  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS app_users_email_idx ON app_users (email);
