---
name: amazon-spapi
description: Amazon Selling Partner API - manage orders, inventory, catalog, and reports. ALWAYS use this when user provides an Amazon order number (3-7-7 digit format like 112-2039414-3228234).
metadata:
  openclaw:
    emoji: "🛒"
---

# Amazon SP-API

Look up Amazon orders, inventory, catalog, and reports. Credentials are already configured.

## CRITICAL: Auto-Detect Amazon Order Numbers

Amazon order numbers always match the pattern `XXX-XXXXXXX-XXXXXXX` (3 digits, hyphen, 7 digits, hyphen, 7 digits).

**When you see this pattern, IMMEDIATELY run the lookup command. Do NOT ask the user what it is. Do NOT say credentials are missing. Just run it.**

This is NOT a shipping tracking number. Tracking numbers look different (UPS: 1Z..., USPS: 94..., FedEx: 12+ digits).

## Output Formatting

**Do NOT use markdown tables.** They render poorly on Matrix/Element.

Format order details as a clean list:

```
**Order 112-2039414-3228234**
✅ Shipped — Jan 28, 2026

**Item:** GasOne Butane Fuel Canister (12 Pack)
**Price:** $28.99
**Total:** $30.73
**Shipped:** 1 unit
**Carrier:** OnTrac Ground
**Delivery Window:** Feb 2–3, 2026
**Destination:** Nazareth, PA

Delivered via your own shipping, not FBA.
```

## Quick Order Lookup

```bash
{baseDir}/scripts/spapi.sh order 112-2039414-3228234
```

Returns both order details and line items in one call.

## Other Commands

```bash
{baseDir}/scripts/spapi.sh orders list                    # Recent orders (last 7 days)
{baseDir}/scripts/spapi.sh orders list --since 2026-01-01 # Since specific date
{baseDir}/scripts/spapi.sh orders pending                 # Unshipped orders
{baseDir}/scripts/spapi.sh orders get <order-id>          # Order details only
{baseDir}/scripts/spapi.sh orders items <order-id>        # Line items only
{baseDir}/scripts/spapi.sh inventory summary              # FBA inventory
{baseDir}/scripts/spapi.sh inventory check <SKU>          # Check specific SKU
{baseDir}/scripts/spapi.sh inventory low                  # Low stock (<10 units)
{baseDir}/scripts/spapi.sh catalog search "query"         # Search catalog
{baseDir}/scripts/spapi.sh catalog get <ASIN>             # ASIN details
{baseDir}/scripts/spapi.sh pricing get <ASIN>             # Competitive pricing
{baseDir}/scripts/spapi.sh auth test                      # Test auth
```

## Examples

**User: "112-2039414-3228234"** → `{baseDir}/scripts/spapi.sh order 112-2039414-3228234`
**User: "look up order 114-0593702-9613051"** → `{baseDir}/scripts/spapi.sh order 114-0593702-9613051`
**User: "recent Amazon orders"** → `{baseDir}/scripts/spapi.sh orders list`
**User: "unshipped orders"** → `{baseDir}/scripts/spapi.sh orders pending`
