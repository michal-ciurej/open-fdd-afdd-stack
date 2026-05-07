-- Per-user site permissions for Entra-authenticated users.
-- Role tier (admin/engineer/user) comes from Entra App Roles via the SWA principal.
-- Admins bypass this table; engineer/user need explicit grants per site.

CREATE TABLE IF NOT EXISTS user_site_permissions (
    user_oid    TEXT        NOT NULL,           -- Entra object ID (stable per user)
    site_id     TEXT        NOT NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    granted_by  TEXT,                            -- oid of admin who granted
    PRIMARY KEY (user_oid, site_id)
);

CREATE INDEX IF NOT EXISTS user_site_permissions_user_idx
    ON user_site_permissions (user_oid);

CREATE INDEX IF NOT EXISTS user_site_permissions_site_idx
    ON user_site_permissions (site_id);
