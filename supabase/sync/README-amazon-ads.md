# Amazon Advertising API Setup

## Current Status

**The Amazon Advertising API requires separate registration** from the SP-API.
Until this is set up, the `amazon-ads.mjs` script will:
1. Attempt the Advertising API (and gracefully fail)
2. Scan settlement reports for any ad-related fees (none found — Amazon bills ad spend to credit card, not settlements)
3. Report what's needed

## What's Needed

### 1. Register for Amazon Advertising API Access

Go to: https://advertising.amazon.com/API/docs/en-us/setting-up/overview

Steps:
1. **Log into Amazon Advertising Console**: https://advertising.amazon.com
   - Use the same seller account that runs Sponsored Products campaigns
2. **Register your application** (or update existing SP-API app):
   - Go to https://advertising.amazon.com/developer/
   - Register a new API client (or request access for your existing LWA app)
   - The LWA client ID from SP-API may work if you add Advertising API scope
3. **Get an Advertising API profile ID**:
   - Once authorized, call `GET /v2/profiles` to list your advertising profiles
   - The US marketplace seller profile ID is what you need

### 2. Store Credentials in 1Password

Add to `Agents Service Accounts` vault, item `Amazon SP-API Credentials`:
- `AdvertisingProfileId` — from step 1.3 above

Or create a new item `Amazon Advertising API Credentials` with:
- `ProfileId` — your advertising profile ID
- (The LWA credentials are shared with SP-API)

### 3. Verify Access

```bash
cd supabase/sync
node amazon-ads.mjs --dry-run
```

## How Ad Spend Data Flows in Amazon

| Data Source | Contains Ad Spend? | Notes |
|---|---|---|
| Settlement Reports (V2) | ❌ No | Only contains order fees, commissions, refunds |
| Advertising API | ✅ Yes | Sponsored Products/Brands/Display campaign data |
| Credit Card Statement | ✅ Yes | Amazon charges ad spend to seller's card |
| Business Reports (SP-API) | ❌ No | Sales metrics only |

## Settlement Report Fee Types (for reference)

From our data, settlement reports contain these `amount-type | amount-description` combos:
- `Order | ItemFees | Commission`
- `Order | ItemPrice | Principal`
- `Order | ItemPrice | Tax`
- `Order | ItemWithheldTax | MarketplaceFacilitatorTax-Principal`
- `Order | Promotion | Principal`
- `Refund | ItemFees | Commission`
- `Refund | ItemFees | RefundCommission`
- `Refund | ItemPrice | Principal / Tax`
- `Refund | ItemWithheldTax | MarketplaceFacilitatorTax-Principal`

**None** of these are advertising-related.

## Data Schema

When working, ad spend is stored in `channel_fees`:

| Column | Value |
|---|---|
| `channel_id` | `7f84462f-86c8-4e09-abb6-285631db0d83` (Amazon) |
| `fee_type` | `advertising` |
| `description` | `SP: {campaign name}` |
| `amount` | Daily spend in USD |
| `external_ref` | `ads-sp-{campaignId}-{YYYYMMDD}` (for dedup) |
| `metadata` | `{ campaign_id, impressions, clicks, cost, profile_id }` |

## Manual Workaround

Until the API is set up, you can manually export ad data:
1. Go to Amazon Advertising Console → Campaigns → Sponsored Products
2. Download campaign performance report (daily granularity)
3. The CSV can be imported with a small script if needed
