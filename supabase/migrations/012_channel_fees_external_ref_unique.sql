-- Add unique constraint on channel_fees.external_ref for upsert support
-- First dedup existing rows
DELETE FROM channel_fees WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (PARTITION BY external_ref ORDER BY created_at DESC) rn
    FROM channel_fees WHERE external_ref IS NOT NULL
  ) sub WHERE rn > 1
);

-- PostgREST on_conflict requires a real UNIQUE constraint, not a partial index
ALTER TABLE channel_fees ADD CONSTRAINT channel_fees_external_ref_key UNIQUE (external_ref);
