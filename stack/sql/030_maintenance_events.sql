-- Maintenance event log. Append-only history of operator actions against
-- equipment under observation. Current state ("scheduled?", "last maintained")
-- is derived from the most recent row per (equipment_id, event_type), which
-- preserves the full audit trail for the Maintenance dashboard timeline.

CREATE TABLE IF NOT EXISTS maintenance_events (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    equipment_id  uuid NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
    event_type    text NOT NULL CHECK (event_type IN ('scheduled','maintained','cancelled')),
    ts            timestamptz NOT NULL DEFAULT now(),
    actor_email   text,
    notes         text
);

CREATE INDEX IF NOT EXISTS idx_maint_events_eq_ts
    ON maintenance_events(equipment_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_maint_events_type_ts
    ON maintenance_events(event_type, ts DESC);
