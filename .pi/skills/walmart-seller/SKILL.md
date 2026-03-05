---
name: walmart-seller
description: Walmart Marketplace Seller API - manage orders, inventory, items, returns, and reports. Use for any Walmart seller/marketplace questions, order lookups, CSV exports, or inventory checks.
---

# Walmart Marketplace Seller API

Interact with Walmart's Seller Marketplace API. Credentials are pulled automatically from 1Password:

- **Client ID:** `op://Agents Service Accounts/Walmart API Credentials/username`
- **Client Secret:** `op://Agents Service Accounts/Walmart API Credentials/credential`

Requires `op` (1Password CLI), `curl`, and `jq`.

## Output Formatting

**Do NOT use markdown tables.** Format results as clean lists.

## Quick Start

```bash
# Test authentication
{baseDir}/scripts/walmart.sh auth test
```

## Orders

```bash
{baseDir}/scripts/walmart.sh orders list                           # Last 7 days
{baseDir}/scripts/walmart.sh orders list 30                        # Last 30 days
{baseDir}/scripts/walmart.sh orders list 2025-01-01                # Since specific date
{baseDir}/scripts/walmart.sh orders released                       # Released/created orders
{baseDir}/scripts/walmart.sh orders get <purchaseOrderId>          # Order details
{baseDir}/scripts/walmart.sh orders status Shipped                 # Filter: Created|Acknowledged|Shipped|Delivered|Cancelled
{baseDir}/scripts/walmart.sh orders status Shipped 2025-01-01     # Status + date filter
{baseDir}/scripts/walmart.sh orders all-2025                       # All 2025 orders (JSON, paginated)
{baseDir}/scripts/walmart.sh orders csv 2025                       # Export all 2025 orders to CSV
{baseDir}/scripts/walmart.sh orders csv 2025 my_orders.csv         # Export to specific file
```

### CSV Export

The `orders csv` command fetches all orders for a given year (paginating automatically) and writes a CSV with columns:

`purchaseOrderId, customerOrderId, orderDate, status, customerName, estimatedDeliveryDate, estimatedShipDate, sku, productName, quantity, unitPrice, totalPrice`

## Items / Catalog

```bash
{baseDir}/scripts/walmart.sh items list                   # List items (default: 20)
{baseDir}/scripts/walmart.sh items list 50 0              # With limit and offset
{baseDir}/scripts/walmart.sh items get <sku>              # Get item by SKU
```

## Inventory

```bash
{baseDir}/scripts/walmart.sh inventory get <sku>          # Inventory for specific SKU
{baseDir}/scripts/walmart.sh inventory list               # List all inventory
{baseDir}/scripts/walmart.sh inventory list 100 0         # With limit and offset
```

## Returns

```bash
{baseDir}/scripts/walmart.sh returns list                 # Last 7 days
{baseDir}/scripts/walmart.sh returns list 30              # Last 30 days
{baseDir}/scripts/walmart.sh returns list 2025-01-01      # Since specific date
{baseDir}/scripts/walmart.sh returns get <returnOrderId>  # Return details
```

## Reports

Walmart supports various report types: `item`, `buyBox`, `cpa`, `shippingProgram`, `shippingConfiguration`, `itemPerformance`, `returnOverrides`, `promoPackOffer`.

```bash
{baseDir}/scripts/walmart.sh reports available                        # List report requests
{baseDir}/scripts/walmart.sh reports request item                     # Request an item report
{baseDir}/scripts/walmart.sh reports status <requestId>               # Check report status
{baseDir}/scripts/walmart.sh reports download <requestId>             # Download report CSV
{baseDir}/scripts/walmart.sh reports download <requestId> output.csv  # Download to specific file
```

## Shipping

```bash
{baseDir}/scripts/walmart.sh shipping labels <purchaseOrderId>   # Get shipping labels
```

## Examples

**User: "get all walmart orders for 2025 as CSV"** → `{baseDir}/scripts/walmart.sh orders csv 2025`
**User: "recent walmart orders"** → `{baseDir}/scripts/walmart.sh orders list`
**User: "walmart order 123456789"** → `{baseDir}/scripts/walmart.sh orders get 123456789`
**User: "shipped walmart orders this month"** → `{baseDir}/scripts/walmart.sh orders status Shipped 2026-02-01`
**User: "walmart inventory for SKU ABC123"** → `{baseDir}/scripts/walmart.sh inventory get ABC123`
**User: "walmart returns last 30 days"** → `{baseDir}/scripts/walmart.sh returns list 30`

## API Reference

- [Walmart Marketplace API Docs](https://developer.walmart.com/api/us/mp/orders)
- [Authentication](https://developer.walmart.com/doc/us/mp/us-mp-auth/)
- Order statuses: `Created`, `Acknowledged`, `Shipped`, `Delivered`, `Cancelled`
