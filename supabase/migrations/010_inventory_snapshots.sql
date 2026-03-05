-- ============================================================================
-- Inventory Snapshots — Daily stock level recording
-- ============================================================================
-- Records point-in-time inventory per variant per warehouse for
-- sell-through analysis, stockout detection, and demand forecasting.
-- ============================================================================

CREATE TABLE inventory_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id      UUID REFERENCES product_variants(id),
    sku             TEXT NOT NULL,
    warehouse_id    UUID,
    quantity         INTEGER NOT NULL,
    snapshot_date   DATE NOT NULL DEFAULT CURRENT_DATE,
    data_source     TEXT DEFAULT 'veeqo',
    created_at      TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(variant_id, warehouse_id, snapshot_date)
);

-- Indexes for common query patterns
CREATE INDEX idx_snapshots_sku_date ON inventory_snapshots(sku, snapshot_date);
CREATE INDEX idx_snapshots_variant_date ON inventory_snapshots(variant_id, snapshot_date);
CREATE INDEX idx_snapshots_date ON inventory_snapshots(snapshot_date);

-- RLS: service_role only (sync scripts)
ALTER TABLE inventory_snapshots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role_all" ON inventory_snapshots FOR ALL TO service_role USING (true);
