-- Migration 011: Add unique constraint on tracking_events to prevent duplicates
-- Natural key: (shipment_id, status, occurred_at) — one event per status per timestamp

-- Dedup existing rows (keep oldest created_at per natural key)
DELETE FROM tracking_events
WHERE id NOT IN (
    SELECT DISTINCT ON (shipment_id, status, occurred_at) id
    FROM tracking_events
    ORDER BY shipment_id, status, occurred_at, created_at ASC
);

-- Add unique constraint for upsert support
ALTER TABLE tracking_events
ADD CONSTRAINT tracking_events_unique_event
UNIQUE (shipment_id, status, occurred_at);
