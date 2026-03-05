-- Migration: Shipment proof-of-shipment photos
-- Photos taken at time of carrier handoff, OCR'd to match tracking numbers

-- Storage bucket (created via API, not SQL — this is documentation)
-- Bucket: shipment-photos
-- Public: false (signed URLs only)

CREATE TABLE shipment_photos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id     UUID REFERENCES shipments(id) ON DELETE CASCADE,
    tracking_number TEXT,                    -- OCR'd tracking number
    storage_path    TEXT NOT NULL,           -- Supabase Storage path
    storage_url     TEXT,                    -- Signed or public URL
    ocr_raw         TEXT,                    -- Full OCR text from image
    ocr_confidence  NUMERIC(5,2),           -- OCR confidence score
    photo_taken_at  TIMESTAMPTZ,            -- When photo was taken (EXIF or Drive metadata)
    drive_file_id   TEXT,                    -- Google Drive file ID (source)
    file_size_bytes INTEGER,
    mime_type       TEXT DEFAULT 'image/jpeg',
    matched         BOOLEAN DEFAULT FALSE,  -- Whether tracking was matched to a shipment
    match_method    TEXT,                    -- 'exact', 'fuzzy', 'manual'
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_photos_shipment ON shipment_photos(shipment_id);
CREATE INDEX idx_photos_tracking ON shipment_photos(tracking_number);
CREATE INDEX idx_photos_drive ON shipment_photos(drive_file_id);
CREATE INDEX idx_photos_unmatched ON shipment_photos(matched) WHERE matched = FALSE;

-- RLS
ALTER TABLE shipment_photos ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access on shipment_photos"
    ON shipment_photos FOR ALL
    USING (current_setting('role') = 'service_role');
