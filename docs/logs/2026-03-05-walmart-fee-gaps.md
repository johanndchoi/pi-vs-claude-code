# Walmart Fee Gaps Investigation — 2026-03-05

## Summary

Investigated 26 Walmart orders (channel_id `2da7e1e0-...a86`) with no `channel_fees` records.

## Root Cause

**No format mismatch.** Both the recon CSV "Customer Order #" and our `orders.order_number` use the same 15-digit format (e.g., `200014459287584`). The script's `findOrderId()` matching works correctly.

The 26 missing orders fall into two categories:

### 1. Cancelled/Refunded Orders (7) — No Commission Expected

| Order Number | Date | Status | Reason |
|---|---|---|---|
| 200013992319836 | 2025-11-08 | refunded | Never shipped |
| 200013823890722 | 2025-11-11 | cancelled | Never shipped |
| 200013737093344 | 2025-11-15 | cancelled | Never shipped |
| 200014053227818 | 2025-11-19 | cancelled | Never shipped |
| 200014156905222 | 2026-01-02 | cancelled | Never shipped |
| 200014343730589 | 2026-01-03 | cancelled | Never shipped |
| 200014361772412 | 2026-01-24 | cancelled | Never shipped |

Confirmed via ShipStation: all show `status: cancelled`, `shipDate: null`. Walmart never charged commission on unshipped orders.

### 2. Recent Orders (19) — Pending Next Recon Report

| Order Number | Date | Status |
|---|---|---|
| 200014455696790 | 2026-02-20 | delivered |
| 200014382627783 | 2026-02-21 | shipped |
| 200014385708197 | 2026-02-21 | shipped |
| 200014214370375 | 2026-02-21 | shipped |
| 200014528352868 | 2026-02-21 | shipped |
| 200014365516837 | 2026-02-22 | delivered |
| 200014365517410 | 2026-02-22 | delivered |
| 200014598307232 | 2026-02-22 | shipped |
| 200014328882882 | 2026-02-22 | delivered |
| 200014344954457 | 2026-02-22 | shipped |
| 200014536544490 | 2026-02-22 | shipped |
| 200014365715805 | 2026-02-23 | delivered |
| 200014429714136 | 2026-02-27 | shipped |
| 200014591954896 | 2026-02-27 | shipped |
| 200014500054370 | 2026-02-27 | shipped |
| 200014557182616 | 2026-02-28 | shipped |
| 200014324387224 | 2026-02-28 | shipped |
| 200014409615550 | 2026-02-28 | shipped |
| 200014385561956 | 2026-02-28 | shipped |

The latest recon report (`02242026`) covers period **02/07/2026 – 02/21/2026**. These orders shipped after the period end. Commission fees will appear in the next report (~03/10/2026).

## "7,250 Unmatched Rows" Explanation

Across all 75 recon reports: **8,028 fee-eligible rows** referencing **6,499 unique order numbers**. Only **538 match orders in our DB** — the remaining 5,961 are pre-2025 orders from before we started syncing to Supabase. This is expected, not a bug.

## Current State

A prior process inserted placeholder fees for all 26 orders:
- **Cancelled orders**: `$0.00` fees with `estimated: true` metadata
- **Recent orders**: Estimated at 15% of subtotal with `estimated: true` metadata
- External refs: `wm-estimated-{order_number}`

## Fix Applied

Updated `supabase/sync/walmart-fees.mjs` to:
1. **Auto-remove estimated fees** (`wm-estimated-*`) when actual recon data arrives for an order
2. Uses `removeEstimatedFees(orderId)` before upserting real fees (deduplicated per order)
3. Tracks `estimated_replaced` count in import stats

Created `.locks/walmart-fees.cursor` with all 75 processed report dates so future runs only process new reports.

## Action Items

- [ ] Re-run `walmart-fees.mjs` after the ~03/10/2026 recon report drops to pick up the 19 recent orders' actual commission values
- [ ] The 7 cancelled orders will keep their `$0.00` estimated fees (correct values — no commission was charged)
