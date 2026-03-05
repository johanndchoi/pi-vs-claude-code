-- Add missing columns to refunds table for returns sync
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'completed';
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS channel_id UUID REFERENCES channels(id);
ALTER TABLE refunds ADD COLUMN IF NOT EXISTS external_ref TEXT UNIQUE;
