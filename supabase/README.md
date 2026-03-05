# Snatch-It — Business Source of Truth

Supabase (PostgreSQL) database that serves as the single source of truth for all business operations.

## Data Sources

| System | API | Purpose | Status |
|--------|-----|---------|--------|
| **Veeqo** | REST API | Primary order management & shipping labels (best rates) | ✅ Connected |
| **Amazon SP-API** | REST API | Marketplace orders, catalog, FBA inventory | ✅ Connected |
| **Walmart Seller API** | REST API | Marketplace orders, inventory | ✅ Connected |
| **ShipStation** | Via Airtable | Historical shipments & labels, occasional use | ✅ Data in Airtable |
| **eBay** | Via Veeqo | Marketplace orders | ✅ Via Veeqo channel |

## Schema Overview (31 tables, 4 views)

### Core Reference
- `channels` — Sales channels (Amazon, Walmart, eBay, Direct, Retail)
- `warehouses` — Fulfillment locations (12th Street, LA)
- `shipping_platforms` — Veeqo (primary), ShipStation (historical), Amazon Buy Shipping
- `suppliers` — Vendors you buy from

### Products & Inventory
- `products` — Master product catalog (supports kits/bundles)
- `product_variants` — SKU-level (with ASIN, UPC, cost, dimensions)
- `kit_components` — Kit composition (e.g., 12-pack = 12x 1-pack)
- `channel_listings` — Per-channel listing data
- `supplier_products` — Supplier pricing per variant
- `inventory_levels` — Current stock (physical, allocated, available)
- `inventory_movements` — Immutable ledger of every stock change

### Orders
- `orders` — Order headers with full address, money, status, data_source tracking
- `order_items` — Line items with COGS for profit calculation

### Shipments & Tracking
- `shipments` — Labels with platform tracking (Veeqo vs ShipStation), zone, savings
- `shipment_items` — Partial shipment support
- `tracking_events` — Every carrier scan

### Returns & Refunds
- `returns` — RMA tracking with inspection details
- `return_items` — Per-item return tracking
- `refunds` — Full/partial refund records

### Financials
- `channel_fees` — Marketplace commissions, FBA fees, etc.
- `financial_transactions` — Full money ledger (revenue, costs, fees, payouts)
- `payouts` — Channel settlement/deposit records

### Purchasing
- `purchase_orders` — POs to suppliers
- `purchase_order_items` — PO line items with received qty tracking

### System & Audit
- `audit_log` — Auto-logged changes to all critical tables
- `sync_cursors` — ETL state per data source
- `import_runs` — Every sync job tracked with counts and errors
- `external_id_map` — Cross-system ID resolution (Veeqo ↔ ShipStation ↔ Amazon)
- `reconciliation_snapshots` — Periodic cross-system checks

### Views
- `order_profitability` — Revenue, COGS, fees, shipping, gross profit per order
- `low_stock_alerts` — Variants below threshold
- `shipping_cost_by_platform` — Veeqo vs ShipStation rate comparison
- `daily_sales_summary` — Orders & revenue by channel by day

## Setup

1. Create a Supabase project at https://supabase.com
2. Run the migration: `supabase db push` or paste into SQL editor
3. Configure sync jobs to pull from Veeqo, Amazon SP-API, Walmart, and ShipStation/Airtable

## Credentials (1Password)

| Credential | 1Password Location |
|-----------|-------------------|
| Airtable API | `op://Agents Service Accounts/Airtable API Credentials/credential` |
| Veeqo API | `op://Agents Service Accounts/Veeqo API Credentials/credential` |
| Amazon SP-API | `op://Agents Service Accounts/Amazon SP-API Credentials/*` |
| Walmart API | `op://Agents Service Accounts/Walmart API Credentials/*` |
| ShipStation | `SHIPSTATION_API_KEY` env var + Airtable base `appn5Ei5njEXDmd92` |
