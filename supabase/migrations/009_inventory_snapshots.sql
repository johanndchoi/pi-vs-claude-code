-- Inventory Snapshots: daily stock levels per variant per warehouse
-- Used for sell-through rate analysis and stockout detection.

CREATE TABLE inventory_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id UUID REFERENCES product_variants(id),
    sku TEXT NOT NULL,
    warehouse_id UUID,
    quantity INTEGER NOT NULL,
    snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
    data_source TEXT DEFAULT 'veeqo',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(variant_id, warehouse_id, snapshot_date)
);

-- Indexes for common queries
CREATE INDEX idx_inventory_snapshots_date ON inventory_snapshots(snapshot_date);
CREATE INDEX idx_inventory_snapshots_sku ON inventory_snapshots(sku);
CREATE INDEX idx_inventory_snapshots_variant_date ON inventory_snapshots(variant_id, snapshot_date);

ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON inventory_snapshots FOR ALL TO service_role USING (true);
