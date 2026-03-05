-- ============================================================================
-- Snatch-It Business Database — Source of Truth
-- ============================================================================
-- Comprehensive schema for multi-channel e-commerce operations
-- Covers: Products, Inventory, Orders, Customers, Shipments, Returns,
--         Financials, Suppliers, Purchase Orders, and Audit Trail
-- ============================================================================

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "pgcrypto" SCHEMA extensions;

-- ============================================================================
-- ENUMS
-- ============================================================================

CREATE TYPE channel_type AS ENUM ('amazon', 'walmart', 'ebay', 'shopify', 'direct', 'retail', 'wholesale', 'tiktok');
CREATE TYPE order_status AS ENUM ('pending', 'awaiting_payment', 'awaiting_fulfillment', 'partially_shipped', 'shipped', 'delivered', 'cancelled', 'refunded', 'on_hold');
CREATE TYPE shipment_status AS ENUM ('created', 'label_printed', 'awaiting_collection', 'in_transit', 'out_for_delivery', 'delivered', 'attempted_delivery', 'returned_to_sender', 'cancelled', 'exception');
CREATE TYPE return_status AS ENUM ('requested', 'approved', 'in_transit', 'received', 'inspected', 'restocked', 'refunded', 'rejected', 'closed');
CREATE TYPE return_reason AS ENUM ('defective', 'wrong_item', 'not_as_described', 'no_longer_needed', 'arrived_late', 'damaged_in_transit', 'missing_parts', 'other');
CREATE TYPE refund_type AS ENUM ('full', 'partial', 'shipping_only', 'replacement', 'goodwill');
CREATE TYPE inventory_movement_type AS ENUM ('purchase_received', 'sale', 'return_restock', 'adjustment_add', 'adjustment_remove', 'transfer_in', 'transfer_out', 'damaged', 'lost', 'count_correction', 'kit_assembly', 'kit_disassembly');
CREATE TYPE po_status AS ENUM ('draft', 'sent', 'confirmed', 'partially_received', 'received', 'cancelled');
CREATE TYPE product_type AS ENUM ('standard', 'kit', 'bundle', 'virtual');
CREATE TYPE fee_type AS ENUM ('marketplace_commission', 'fba_fee', 'shipping_label', 'advertising', 'storage', 'return_processing', 'other');
CREATE TYPE financial_tx_type AS ENUM ('sale', 'refund', 'fee', 'shipping_cost', 'cogs', 'adjustment', 'payout', 'advertising');
CREATE TYPE shipping_platform AS ENUM ('veeqo', 'shipstation', 'amazon_buy_shipping', 'manual');
CREATE TYPE data_source AS ENUM ('veeqo', 'shipstation', 'amazon_sp_api', 'walmart_api', 'ebay_api', 'manual', 'airtable_import');

-- ============================================================================
-- CORE REFERENCE TABLES
-- ============================================================================

-- Sales channels (Amazon, Walmart, eBay, Direct, etc.)
CREATE TABLE channels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    channel_type    channel_type NOT NULL,
    currency_code   TEXT DEFAULT 'USD',
    is_active       BOOLEAN DEFAULT true,
    seller_id       TEXT,                -- Amazon seller ID, eBay username, etc.
    marketplace_id  TEXT,                -- Amazon marketplace ID, etc.
    external_id     TEXT,                -- ID in Veeqo or other systems
    settings        JSONB DEFAULT '{}',  -- Channel-specific config
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Warehouses / fulfillment locations
CREATE TABLE warehouses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    trading_name    TEXT,                -- DBA name (e.g., "Snatch-It")
    address_line_1  TEXT,
    address_line_2  TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT DEFAULT 'US',
    postal_code     TEXT,
    phone           TEXT,
    is_active       BOOLEAN DEFAULT true,
    is_default      BOOLEAN DEFAULT false,
    timezone        TEXT DEFAULT 'America/Los_Angeles',
    cut_off_times   JSONB DEFAULT '{}', -- Per-day shipping cutoff times
    external_id     TEXT,               -- Veeqo warehouse ID
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Shipping platforms (Veeqo, ShipStation, etc.)
CREATE TABLE shipping_platforms (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    platform_type   shipping_platform NOT NULL,
    is_active       BOOLEAN DEFAULT true,
    is_primary      BOOLEAN DEFAULT false,  -- Primary label-buying platform
    api_base_url    TEXT,
    account_id      TEXT,                   -- ShipStation store ID, Veeqo user ID, etc.
    notes           TEXT,                   -- e.g., "Better rates", "Historical only"
    settings        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Suppliers / vendors
CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name            TEXT NOT NULL,
    contact_name    TEXT,
    email           TEXT,
    phone           TEXT,
    website         TEXT,
    address_line_1  TEXT,
    address_line_2  TEXT,
    city            TEXT,
    state           TEXT,
    country         TEXT DEFAULT 'US',
    postal_code     TEXT,
    payment_terms   TEXT,               -- e.g., "Net 30"
    lead_time_days  INT,                -- Average days from PO to delivery
    notes           TEXT,
    is_active       BOOLEAN DEFAULT true,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- PRODUCTS & INVENTORY
-- ============================================================================

-- Master product catalog
CREATE TABLE products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title           TEXT NOT NULL,
    description     TEXT,
    brand           TEXT,
    product_type    product_type DEFAULT 'standard',
    category        TEXT,
    tags            TEXT[] DEFAULT '{}',
    main_image_url  TEXT,
    origin_country  TEXT DEFAULT 'US',
    hs_tariff_code  TEXT,               -- For customs/international
    is_hazmat       BOOLEAN DEFAULT false,
    is_active       BOOLEAN DEFAULT true,
    external_ids    JSONB DEFAULT '{}', -- {"veeqo": "123", "amazon": "456"}
    metadata        JSONB DEFAULT '{}', -- Flexible extra data
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- SKU-level variants (a product can have multiple SKUs/variants)
CREATE TABLE product_variants (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    product_id      UUID NOT NULL REFERENCES products(id),
    sku             TEXT NOT NULL UNIQUE,
    title           TEXT,                -- Variant-specific title (e.g., "Pack of 12")
    asin            TEXT,                -- Amazon ASIN
    upc             TEXT,                -- UPC barcode
    ean             TEXT,                -- EAN barcode
    fnsku           TEXT,                -- Amazon FBA FNSKU
    price           NUMERIC(10,2) DEFAULT 0,
    cost_price      NUMERIC(10,2) DEFAULT 0,
    map_price       NUMERIC(10,2),       -- Minimum advertised price
    weight_oz       NUMERIC(10,2),
    length_in       NUMERIC(8,2),
    width_in        NUMERIC(8,2),
    height_in       NUMERIC(8,2),
    is_active       BOOLEAN DEFAULT true,
    low_stock_threshold INT DEFAULT 10,
    reorder_quantity    INT DEFAULT 0,
    customs_description TEXT,
    external_ids    JSONB DEFAULT '{}',  -- {"veeqo_id": "516416307"}
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_variants_sku ON product_variants(sku);
CREATE INDEX idx_variants_asin ON product_variants(asin) WHERE asin IS NOT NULL;
CREATE INDEX idx_variants_product ON product_variants(product_id);

-- Kit/bundle composition (which variants make up a kit)
CREATE TABLE kit_components (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kit_variant_id  UUID NOT NULL REFERENCES product_variants(id),  -- The kit SKU
    component_variant_id UUID NOT NULL REFERENCES product_variants(id),  -- Component SKU
    quantity        INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(kit_variant_id, component_variant_id)
);

-- Channel-specific listings (maps a variant to a channel with channel-specific data)
CREATE TABLE channel_listings (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    channel_id      UUID NOT NULL REFERENCES channels(id),
    remote_id       TEXT,                -- Listing ID on the channel
    remote_sku      TEXT,                -- SKU as it appears on the channel
    listing_url     TEXT,
    listed_price    NUMERIC(10,2),
    is_active       BOOLEAN DEFAULT true,
    status          TEXT,                -- Channel-specific status
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(variant_id, channel_id)
);

-- Supplier products (which suppliers carry which variants, at what cost)
CREATE TABLE supplier_products (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    supplier_id     UUID NOT NULL REFERENCES suppliers(id),
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    supplier_sku    TEXT,                -- Supplier's part number
    unit_cost       NUMERIC(10,2) NOT NULL,
    min_order_qty   INT DEFAULT 1,
    pack_size       INT DEFAULT 1,       -- Units per case/pack
    is_preferred    BOOLEAN DEFAULT false,
    lead_time_days  INT,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(supplier_id, variant_id)
);

-- Current inventory levels (materialized from movements, one row per variant per warehouse)
CREATE TABLE inventory_levels (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
    physical_qty    INT NOT NULL DEFAULT 0,   -- What's physically on shelves
    allocated_qty   INT NOT NULL DEFAULT 0,   -- Reserved for open orders
    available_qty   INT GENERATED ALWAYS AS (physical_qty - allocated_qty) STORED,
    incoming_qty    INT NOT NULL DEFAULT 0,   -- On open purchase orders
    bin_location    TEXT,                      -- Shelf/bin location in warehouse
    last_counted_at TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(variant_id, warehouse_id)
);

CREATE INDEX idx_inventory_variant ON inventory_levels(variant_id);
CREATE INDEX idx_inventory_low_stock ON inventory_levels(available_qty) WHERE available_qty <= 10;

-- Inventory movement ledger (immutable audit trail of all stock changes)
CREATE TABLE inventory_movements (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
    movement_type   inventory_movement_type NOT NULL,
    quantity        INT NOT NULL,          -- Positive = in, negative = out
    running_total   INT,                   -- Physical qty after this movement
    reference_type  TEXT,                  -- 'order', 'purchase_order', 'return', 'manual'
    reference_id    UUID,                  -- FK to the relevant record
    reason          TEXT,
    performed_by    TEXT,                  -- User/system that made the change
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_movements_variant ON inventory_movements(variant_id, created_at DESC);
CREATE INDEX idx_movements_reference ON inventory_movements(reference_type, reference_id);
CREATE INDEX idx_movements_date ON inventory_movements(created_at DESC);

-- ============================================================================
-- CUSTOMERS
-- ============================================================================

CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    first_name      TEXT,
    last_name       TEXT,
    full_name       TEXT GENERATED ALWAYS AS (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) STORED,
    email           TEXT,
    phone           TEXT,
    company         TEXT,
    customer_type   TEXT DEFAULT 'retail',  -- retail, wholesale, etc.
    channel_customer_ids JSONB DEFAULT '{}', -- {"amazon": "ABCXYZ", "ebay": "123"}
    notes           TEXT,
    tags            TEXT[] DEFAULT '{}',
    total_orders    INT DEFAULT 0,
    total_spent     NUMERIC(12,2) DEFAULT 0,
    first_order_at  TIMESTAMPTZ,
    last_order_at   TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_customers_email ON customers(email) WHERE email IS NOT NULL;
CREATE INDEX idx_customers_name ON customers(last_name, first_name);

-- Customer addresses (shipping + billing)
CREATE TABLE addresses (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    customer_id     UUID REFERENCES customers(id),
    address_type    TEXT DEFAULT 'shipping', -- 'shipping' or 'billing'
    first_name      TEXT,
    last_name       TEXT,
    company         TEXT,
    address_line_1  TEXT NOT NULL,
    address_line_2  TEXT,
    city            TEXT NOT NULL,
    state           TEXT,
    country         TEXT DEFAULT 'US',
    postal_code     TEXT NOT NULL,
    phone           TEXT,
    email           TEXT,
    is_verified     BOOLEAN DEFAULT false,
    is_residential  BOOLEAN DEFAULT true,
    is_default      BOOLEAN DEFAULT false,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_addresses_customer ON addresses(customer_id);

-- ============================================================================
-- ORDERS
-- ============================================================================

CREATE TABLE orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_number    TEXT NOT NULL,          -- Channel order number (e.g., Amazon 3-7-7)
    channel_id      UUID REFERENCES channels(id),
    customer_id     UUID REFERENCES customers(id),
    status          order_status NOT NULL DEFAULT 'pending',

    -- Addresses (denormalized for immutability — address at time of order)
    shipping_address_id UUID REFERENCES addresses(id),
    billing_address_id  UUID REFERENCES addresses(id),

    -- Money
    subtotal        NUMERIC(12,2) DEFAULT 0,
    shipping_cost   NUMERIC(10,2) DEFAULT 0,
    tax_amount      NUMERIC(10,2) DEFAULT 0,
    discount_amount NUMERIC(10,2) DEFAULT 0,
    total           NUMERIC(12,2) DEFAULT 0,
    currency_code   TEXT DEFAULT 'USD',

    -- Dates
    ordered_at      TIMESTAMPTZ NOT NULL,    -- When customer placed order
    paid_at         TIMESTAMPTZ,
    dispatch_by     TIMESTAMPTZ,             -- Ship-by deadline
    shipped_at      TIMESTAMPTZ,
    delivered_at    TIMESTAMPTZ,
    cancelled_at    TIMESTAMPTZ,

    -- Fulfillment
    warehouse_id    UUID REFERENCES warehouses(id),
    delivery_method TEXT,                     -- "Standard", "Expedited", etc.
    is_prime        BOOLEAN DEFAULT false,
    fulfilled_by    TEXT DEFAULT 'merchant',  -- 'merchant', 'fba', 'wfs'

    -- Notes & metadata
    customer_notes  TEXT,
    internal_notes  TEXT,
    tags            TEXT[] DEFAULT '{}',
    cancel_reason   TEXT,

    -- Data lineage
    data_source     data_source NOT NULL DEFAULT 'veeqo',  -- Where this record originated

    -- External references
    external_ids    JSONB DEFAULT '{}',       -- {"veeqo": "1459339016", "amazon": "111-xxx", "shipstation": "se-xxx"}

    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE UNIQUE INDEX idx_orders_number_channel ON orders(order_number, channel_id);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_customer ON orders(customer_id);
CREATE INDEX idx_orders_channel ON orders(channel_id);
CREATE INDEX idx_orders_date ON orders(ordered_at DESC);
CREATE INDEX idx_orders_shipped ON orders(shipped_at DESC) WHERE shipped_at IS NOT NULL;

-- Order line items
CREATE TABLE order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    variant_id      UUID REFERENCES product_variants(id),
    sku             TEXT NOT NULL,
    title           TEXT NOT NULL,
    quantity        INT NOT NULL DEFAULT 1,
    unit_price      NUMERIC(10,2) NOT NULL,
    tax_rate        NUMERIC(6,4) DEFAULT 0,
    tax_amount      NUMERIC(10,2) DEFAULT 0,
    discount_amount NUMERIC(10,2) DEFAULT 0,
    line_total      NUMERIC(12,2) GENERATED ALWAYS AS (quantity * unit_price - discount_amount) STORED,
    cost_price      NUMERIC(10,2) DEFAULT 0,  -- COGS at time of sale
    remote_line_id  TEXT,                       -- Channel's line item ID
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_variant ON order_items(variant_id);
CREATE INDEX idx_order_items_sku ON order_items(sku);

-- ============================================================================
-- SHIPMENTS & TRACKING
-- ============================================================================

CREATE TABLE shipments (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    warehouse_id    UUID REFERENCES warehouses(id),
    status          shipment_status DEFAULT 'created',

    -- Which platform created this label
    shipping_platform_id UUID REFERENCES shipping_platforms(id),
    label_source    shipping_platform NOT NULL DEFAULT 'veeqo',  -- Quick enum ref
    data_source     data_source NOT NULL DEFAULT 'veeqo',        -- Where this record came from

    -- Carrier info
    carrier_name    TEXT,                  -- "UPS", "USPS", "FedEx", "Amazon Shipping"
    carrier_code    TEXT,                  -- Normalized: "ups", "usps", "fedex", "amazon_shipping_v2"
    carrier_service TEXT,                  -- "Ground", "Priority Mail", etc.
    service_code    TEXT,                  -- Platform's service code (e.g., "usps_priority_mail")
    tracking_number TEXT,
    tracking_url    TEXT,

    -- Dates
    label_created_at    TIMESTAMPTZ,
    shipped_at          TIMESTAMPTZ,
    estimated_delivery  TIMESTAMPTZ,
    delivered_at        TIMESTAMPTZ,

    -- Costs
    label_cost      NUMERIC(10,2),         -- Cost of shipping label
    insurance_cost  NUMERIC(10,2),
    total_cost      NUMERIC(10,2),
    retail_rate     NUMERIC(10,2),          -- What it would have cost at retail
    savings         NUMERIC(10,2),          -- retail_rate - label_cost

    -- Package details
    weight_oz       NUMERIC(10,2),
    length_in       NUMERIC(8,2),
    width_in        NUMERIC(8,2),
    height_in       NUMERIC(8,2),
    package_type    TEXT,                   -- "12 x 9 x 9", etc.
    zone            INT,                    -- Shipping zone

    -- Delivery details
    signed_by       TEXT,
    delivery_proof_url TEXT,               -- Photo/signature URL
    confirmation_type TEXT,                -- "none", "delivery", "signature", "adult_signature"

    -- Voiding
    is_voided       BOOLEAN DEFAULT false,
    voided_at       TIMESTAMPTZ,

    -- Cross-references to all systems
    external_ids    JSONB DEFAULT '{}',    -- {"veeqo": "xxx", "shipstation": "se-xxx", "amazon": "xxx"}
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_shipments_order ON shipments(order_id);
CREATE INDEX idx_shipments_tracking ON shipments(tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX idx_shipments_status ON shipments(status);
CREATE INDEX idx_shipments_date ON shipments(shipped_at DESC);

-- Items in each shipment (partial shipments supported)
CREATE TABLE shipment_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id     UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    order_item_id   UUID NOT NULL REFERENCES order_items(id),
    quantity        INT NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Tracking event history (every scan/update from carrier)
CREATE TABLE tracking_events (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    shipment_id     UUID NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
    tracking_number TEXT NOT NULL,
    status          TEXT NOT NULL,          -- Carrier's status code/description
    description     TEXT,
    location        TEXT,                   -- City, State or full address
    occurred_at     TIMESTAMPTZ NOT NULL,
    raw_data        JSONB DEFAULT '{}',     -- Full carrier response
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_tracking_shipment ON tracking_events(shipment_id, occurred_at DESC);
CREATE INDEX idx_tracking_number ON tracking_events(tracking_number);

-- ============================================================================
-- RETURNS & REFUNDS
-- ============================================================================

CREATE TABLE returns (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    customer_id     UUID REFERENCES customers(id),
    status          return_status DEFAULT 'requested',
    reason          return_reason,
    reason_detail   TEXT,                  -- Customer's description

    -- RMA info
    rma_number      TEXT UNIQUE,
    return_label_tracking TEXT,
    return_carrier  TEXT,

    -- Dates
    requested_at    TIMESTAMPTZ DEFAULT NOW(),
    approved_at     TIMESTAMPTZ,
    received_at     TIMESTAMPTZ,
    inspected_at    TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,

    -- Inspection
    condition_on_receipt TEXT,             -- "like_new", "damaged", "opened", etc.
    inspection_notes    TEXT,
    restocked       BOOLEAN DEFAULT false,

    -- Costs
    return_shipping_cost NUMERIC(10,2) DEFAULT 0,
    restocking_fee      NUMERIC(10,2) DEFAULT 0,
    paid_by         TEXT DEFAULT 'seller', -- 'seller', 'buyer', 'channel'

    warehouse_id    UUID REFERENCES warehouses(id),
    external_ids    JSONB DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_returns_order ON returns(order_id);
CREATE INDEX idx_returns_status ON returns(status);
CREATE INDEX idx_returns_rma ON returns(rma_number) WHERE rma_number IS NOT NULL;

-- Items being returned
CREATE TABLE return_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    return_id       UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
    order_item_id   UUID NOT NULL REFERENCES order_items(id),
    variant_id      UUID REFERENCES product_variants(id),
    quantity        INT NOT NULL DEFAULT 1,
    reason          return_reason,
    condition_received TEXT,
    restocked_qty   INT DEFAULT 0,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Refund records (can be linked to returns or standalone)
CREATE TABLE refunds (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID NOT NULL REFERENCES orders(id),
    return_id       UUID REFERENCES returns(id),
    refund_type     refund_type NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,
    tax_refund      NUMERIC(10,2) DEFAULT 0,
    shipping_refund NUMERIC(10,2) DEFAULT 0,
    total_refund    NUMERIC(12,2) NOT NULL,
    currency_code   TEXT DEFAULT 'USD',
    reason          TEXT,
    approved_by     TEXT,
    channel_refund_id TEXT,               -- Channel's refund reference
    refunded_at     TIMESTAMPTZ DEFAULT NOW(),
    external_ids    JSONB DEFAULT '{}',
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_refunds_order ON refunds(order_id);
CREATE INDEX idx_refunds_return ON refunds(return_id) WHERE return_id IS NOT NULL;

-- ============================================================================
-- FINANCIALS
-- ============================================================================

-- Channel fees (marketplace commissions, FBA fees, etc.)
CREATE TABLE channel_fees (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id        UUID REFERENCES orders(id),
    order_item_id   UUID REFERENCES order_items(id),
    channel_id      UUID REFERENCES channels(id),
    fee_type        fee_type NOT NULL,
    description     TEXT,
    amount          NUMERIC(12,2) NOT NULL,  -- Always positive
    currency_code   TEXT DEFAULT 'USD',
    incurred_at     TIMESTAMPTZ DEFAULT NOW(),
    external_ref    TEXT,                     -- Channel's fee reference
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_fees_order ON channel_fees(order_id);
CREATE INDEX idx_fees_channel ON channel_fees(channel_id);
CREATE INDEX idx_fees_date ON channel_fees(incurred_at DESC);

-- Financial transactions ledger (double-entry style, all money in/out)
CREATE TABLE financial_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tx_type         financial_tx_type NOT NULL,
    amount          NUMERIC(12,2) NOT NULL,   -- Positive = money in, negative = money out
    currency_code   TEXT DEFAULT 'USD',
    description     TEXT,

    -- References (nullable — a tx can relate to an order, refund, etc.)
    order_id        UUID REFERENCES orders(id),
    refund_id       UUID REFERENCES refunds(id),
    channel_id      UUID REFERENCES channels(id),
    purchase_order_id UUID,                   -- FK added after PO table

    occurred_at     TIMESTAMPTZ NOT NULL,
    external_ref    TEXT,                     -- Payout ID, settlement ID, etc.
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_financial_tx_type ON financial_transactions(tx_type, occurred_at DESC);
CREATE INDEX idx_financial_tx_order ON financial_transactions(order_id) WHERE order_id IS NOT NULL;
CREATE INDEX idx_financial_tx_date ON financial_transactions(occurred_at DESC);

-- Channel payouts / settlements
CREATE TABLE payouts (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    channel_id      UUID NOT NULL REFERENCES channels(id),
    payout_date     DATE NOT NULL,
    period_start    DATE,
    period_end      DATE,
    gross_amount    NUMERIC(12,2) NOT NULL,
    fees_amount     NUMERIC(12,2) DEFAULT 0,
    refunds_amount  NUMERIC(12,2) DEFAULT 0,
    net_amount      NUMERIC(12,2) NOT NULL,
    currency_code   TEXT DEFAULT 'USD',
    external_ref    TEXT,                  -- Settlement ID from channel
    status          TEXT DEFAULT 'pending', -- pending, deposited, failed
    deposited_at    TIMESTAMPTZ,
    raw_data        JSONB DEFAULT '{}',    -- Full settlement report
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_payouts_channel ON payouts(channel_id, payout_date DESC);

-- ============================================================================
-- PURCHASE ORDERS (buying from suppliers)
-- ============================================================================

CREATE TABLE purchase_orders (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    po_number       TEXT NOT NULL UNIQUE,
    supplier_id     UUID NOT NULL REFERENCES suppliers(id),
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
    status          po_status DEFAULT 'draft',

    subtotal        NUMERIC(12,2) DEFAULT 0,
    shipping_cost   NUMERIC(10,2) DEFAULT 0,
    tax_amount      NUMERIC(10,2) DEFAULT 0,
    total           NUMERIC(12,2) DEFAULT 0,
    currency_code   TEXT DEFAULT 'USD',

    ordered_at      TIMESTAMPTZ,
    expected_at     TIMESTAMPTZ,          -- Expected delivery
    received_at     TIMESTAMPTZ,          -- Fully received

    notes           TEXT,
    payment_terms   TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_po_supplier ON purchase_orders(supplier_id);
CREATE INDEX idx_po_status ON purchase_orders(status);

-- Add FK now that purchase_orders exists
ALTER TABLE financial_transactions
    ADD CONSTRAINT fk_financial_tx_po
    FOREIGN KEY (purchase_order_id) REFERENCES purchase_orders(id);

-- Purchase order line items
CREATE TABLE purchase_order_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    purchase_order_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    quantity_ordered INT NOT NULL,
    quantity_received INT DEFAULT 0,
    unit_cost       NUMERIC(10,2) NOT NULL,
    line_total      NUMERIC(12,2) GENERATED ALWAYS AS (quantity_ordered * unit_cost) STORED,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================================================
-- AUDIT & SYSTEM
-- ============================================================================

-- Immutable audit log for all significant changes
CREATE TABLE audit_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name      TEXT NOT NULL,
    record_id       UUID NOT NULL,
    action          TEXT NOT NULL,         -- 'INSERT', 'UPDATE', 'DELETE'
    old_data        JSONB,
    new_data        JSONB,
    changed_fields  TEXT[],
    performed_by    TEXT DEFAULT 'system',
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_audit_table ON audit_log(table_name, record_id);
CREATE INDEX idx_audit_date ON audit_log(created_at DESC);

-- Sync state tracking (for ETL jobs pulling from Veeqo, Amazon, ShipStation, Walmart, etc.)
CREATE TABLE sync_cursors (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          TEXT NOT NULL,         -- 'veeqo_orders', 'amazon_orders', 'shipstation_shipments', 'walmart_orders', etc.
    cursor_value    TEXT,                  -- Last synced ID, timestamp, page token
    last_synced_at  TIMESTAMPTZ,
    records_synced  INT DEFAULT 0,
    error_message   TEXT,
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(source)
);

-- Import job history (tracks every ETL run for debugging)
CREATE TABLE import_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source          data_source NOT NULL,
    job_name        TEXT NOT NULL,          -- 'veeqo_orders_sync', 'shipstation_historical_import', etc.
    status          TEXT DEFAULT 'running', -- 'running', 'completed', 'failed', 'partial'
    started_at      TIMESTAMPTZ DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    records_fetched INT DEFAULT 0,
    records_created INT DEFAULT 0,
    records_updated INT DEFAULT 0,
    records_skipped INT DEFAULT 0,
    errors          JSONB DEFAULT '[]',     -- Array of error details
    cursor_start    TEXT,                   -- Where this run started
    cursor_end      TEXT,                   -- Where this run ended
    metadata        JSONB DEFAULT '{}',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_import_runs_source ON import_runs(source, started_at DESC);

-- Cross-system ID mapping (resolves the same entity across Veeqo, ShipStation, Amazon, etc.)
CREATE TABLE external_id_map (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_type     TEXT NOT NULL,          -- 'order', 'shipment', 'product', 'customer'
    internal_id     UUID NOT NULL,          -- Our UUID
    source          data_source NOT NULL,
    external_id     TEXT NOT NULL,          -- The ID in that external system
    external_data   JSONB DEFAULT '{}',     -- Snapshot of key fields from source
    last_synced_at  TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(entity_type, source, external_id)
);

CREATE INDEX idx_ext_map_internal ON external_id_map(entity_type, internal_id);
CREATE INDEX idx_ext_map_external ON external_id_map(entity_type, source, external_id);

-- Data reconciliation snapshots (periodic checks between systems)
CREATE TABLE reconciliation_snapshots (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    snapshot_type   TEXT NOT NULL,          -- 'inventory', 'orders', 'financials'
    source_system   TEXT NOT NULL,          -- 'veeqo', 'amazon', 'internal'
    snapshot_date   DATE NOT NULL,
    data            JSONB NOT NULL,         -- The actual snapshot data
    discrepancies   JSONB DEFAULT '{}',     -- Any mismatches found
    resolved        BOOLEAN DEFAULT false,
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_recon_type_date ON reconciliation_snapshots(snapshot_type, snapshot_date DESC);

-- ============================================================================
-- VIEWS — Quick access to common queries
-- ============================================================================

-- Order P&L: revenue, costs, fees, and profit per order
CREATE VIEW order_profitability AS
SELECT
    o.id AS order_id,
    o.order_number,
    o.ordered_at,
    c.name AS channel_name,
    o.total AS revenue,
    COALESCE(SUM(oi.cost_price * oi.quantity), 0) AS cogs,
    COALESCE(SUM(cf.amount), 0) AS total_fees,
    COALESCE(SUM(s.total_cost), 0) AS shipping_cost,
    o.total
        - COALESCE(SUM(oi.cost_price * oi.quantity), 0)
        - COALESCE(SUM(DISTINCT cf_total.total_fees), 0)
        - COALESCE(SUM(DISTINCT s.total_cost), 0)
        AS gross_profit
FROM orders o
LEFT JOIN channels c ON o.channel_id = c.id
LEFT JOIN order_items oi ON oi.order_id = o.id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(amount), 0) AS total_fees
    FROM channel_fees WHERE order_id = o.id
) cf_total ON true
LEFT JOIN channel_fees cf ON cf.order_id = o.id
LEFT JOIN shipments s ON s.order_id = o.id
GROUP BY o.id, o.order_number, o.ordered_at, c.name, o.total, cf_total.total_fees, s.total_cost;

-- Low stock alert
CREATE VIEW low_stock_alerts AS
SELECT
    pv.sku,
    p.title,
    w.name AS warehouse,
    il.physical_qty,
    il.allocated_qty,
    il.available_qty,
    il.incoming_qty,
    pv.low_stock_threshold,
    pv.reorder_quantity
FROM inventory_levels il
JOIN product_variants pv ON il.variant_id = pv.id
JOIN products p ON pv.product_id = p.id
JOIN warehouses w ON il.warehouse_id = w.id
WHERE il.available_qty <= pv.low_stock_threshold
  AND pv.is_active = true;

-- Shipping cost analysis by platform
CREATE VIEW shipping_cost_by_platform AS
SELECT
    s.label_source,
    s.carrier_name,
    s.carrier_service,
    COUNT(*) AS shipment_count,
    ROUND(AVG(s.label_cost), 2) AS avg_label_cost,
    ROUND(AVG(s.weight_oz), 1) AS avg_weight_oz,
    ROUND(AVG(s.zone), 1) AS avg_zone,
    SUM(s.label_cost) AS total_label_spend,
    SUM(s.savings) AS total_savings_vs_retail
FROM shipments s
WHERE s.is_voided = false AND s.label_cost IS NOT NULL
GROUP BY s.label_source, s.carrier_name, s.carrier_service
ORDER BY shipment_count DESC;

-- Daily sales summary
CREATE VIEW daily_sales_summary AS
SELECT
    DATE(o.ordered_at AT TIME ZONE 'America/Los_Angeles') AS sale_date,
    c.name AS channel_name,
    COUNT(DISTINCT o.id) AS order_count,
    SUM(o.total) AS total_revenue,
    SUM(oi_agg.item_count) AS units_sold
FROM orders o
LEFT JOIN channels c ON o.channel_id = c.id
LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(quantity), 0) AS item_count
    FROM order_items WHERE order_id = o.id
) oi_agg ON true
WHERE o.status NOT IN ('cancelled', 'refunded')
GROUP BY DATE(o.ordered_at AT TIME ZONE 'America/Los_Angeles'), c.name
ORDER BY sale_date DESC, c.name;

-- ============================================================================
-- FUNCTIONS & TRIGGERS
-- ============================================================================

-- Auto-update updated_at timestamps
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables with updated_at
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT table_name FROM information_schema.columns
        WHERE column_name = 'updated_at'
          AND table_schema = 'public'
          AND table_name NOT IN ('inventory_movements', 'tracking_events', 'audit_log')
    LOOP
        EXECUTE format(
            'CREATE TRIGGER set_updated_at BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION update_updated_at()',
            t
        );
    END LOOP;
END;
$$;

-- Audit log trigger function
CREATE OR REPLACE FUNCTION audit_trigger_func()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        INSERT INTO audit_log(table_name, record_id, action, new_data, performed_by)
        VALUES (TG_TABLE_NAME, NEW.id, 'INSERT', to_jsonb(NEW), current_setting('app.current_user', true));
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO audit_log(table_name, record_id, action, old_data, new_data, performed_by)
        VALUES (TG_TABLE_NAME, NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), current_setting('app.current_user', true));
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO audit_log(table_name, record_id, action, old_data, performed_by)
        VALUES (TG_TABLE_NAME, OLD.id, 'DELETE', to_jsonb(OLD), current_setting('app.current_user', true));
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- Apply audit triggers to critical tables
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN VALUES
        ('orders'), ('order_items'), ('shipments'), ('returns'),
        ('refunds'), ('inventory_levels'), ('purchase_orders'),
        ('products'), ('product_variants'), ('financial_transactions')
    LOOP
        EXECUTE format(
            'CREATE TRIGGER audit_%s AFTER INSERT OR UPDATE OR DELETE ON %I
             FOR EACH ROW EXECUTE FUNCTION audit_trigger_func()',
            t, t
        );
    END LOOP;
END;
$$;

-- Update customer stats after order changes
CREATE OR REPLACE FUNCTION update_customer_stats()
RETURNS TRIGGER AS $$
BEGIN
    UPDATE customers SET
        total_orders = (SELECT COUNT(*) FROM orders WHERE customer_id = COALESCE(NEW.customer_id, OLD.customer_id) AND status NOT IN ('cancelled')),
        total_spent = (SELECT COALESCE(SUM(total), 0) FROM orders WHERE customer_id = COALESCE(NEW.customer_id, OLD.customer_id) AND status NOT IN ('cancelled', 'refunded')),
        first_order_at = (SELECT MIN(ordered_at) FROM orders WHERE customer_id = COALESCE(NEW.customer_id, OLD.customer_id)),
        last_order_at = (SELECT MAX(ordered_at) FROM orders WHERE customer_id = COALESCE(NEW.customer_id, OLD.customer_id))
    WHERE id = COALESCE(NEW.customer_id, OLD.customer_id);
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_customer_stats_trigger
AFTER INSERT OR UPDATE OR DELETE ON orders
FOR EACH ROW EXECUTE FUNCTION update_customer_stats();

-- ============================================================================
-- SEED DATA (from your actual setup)
-- ============================================================================

-- Channels
INSERT INTO channels (name, channel_type, currency_code, seller_id, marketplace_id, external_id) VALUES
    ('Amazon US Marketplace', 'amazon', 'USD', 'A3F3AMTQJJ4X0S', 'ATVPDKIKX0DER', '219517'),
    ('Walmart', 'walmart', 'USD', NULL, NULL, '788587'),
    ('eBay - Snatch-It', 'ebay', 'USD', NULL, NULL, '788600'),
    ('Snatch-It Direct', 'direct', 'USD', NULL, NULL, '878619'),
    ('Snatch-It Retail', 'retail', 'USD', NULL, NULL, '790478');

-- Warehouses
INSERT INTO warehouses (name, trading_name, address_line_1, city, state, country, postal_code, phone, is_default, timezone, external_id, cut_off_times) VALUES
    ('12th Street', 'Snatch-It', '3133 E 12th St', 'Los Angeles', 'CA', 'US', '90023', '3232075171', true, 'America/Los_Angeles', '73033',
     '{"monday": "14:00", "tuesday": "14:00", "wednesday": "14:00", "thursday": "14:00", "friday": "14:00", "saturday": "12:00", "sunday": null}');

-- Shipping platforms
INSERT INTO shipping_platforms (name, platform_type, is_active, is_primary, api_base_url, notes) VALUES
    ('Veeqo', 'veeqo', true, true, 'https://api.veeqo.com', 'Primary shipping platform — best rates'),
    ('ShipStation', 'shipstation', true, false, 'https://ssapi.shipstation.com', 'Historical orders + occasional use. Data in Airtable base ' || 'appn5Ei5njEXDmd92'),
    ('Amazon Buy Shipping', 'amazon_buy_shipping', true, false, 'https://sellingpartnerapi-na.amazon.com', 'Used via Veeqo for Amazon orders');

-- ============================================================================
-- ROW LEVEL SECURITY (enable for Supabase)
-- ============================================================================

-- Enable RLS on all tables (policies added per-app needs)
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('schema_migrations')
    LOOP
        EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    END LOOP;
END;
$$;

-- Service role bypass (for backend/agent access)
DO $$
DECLARE
    t TEXT;
BEGIN
    FOR t IN
        SELECT tablename FROM pg_tables
        WHERE schemaname = 'public'
          AND tablename NOT IN ('schema_migrations')
    LOOP
        EXECUTE format(
            'CREATE POLICY "Service role full access" ON %I FOR ALL TO service_role USING (true) WITH CHECK (true)',
            t
        );
    END LOOP;
END;
$$;
