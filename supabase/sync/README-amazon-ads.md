# Amazon Advertising Spend Import

## Overview

`amazon-ads.mjs` imports advertising spend data into `channel_fees` with `fee_type='advertising'`.

It uses two strategies:

1. **Amazon Advertising API** (preferred) — campaign-level spend with impressions/clicks
2. **Settlement report mining** (fallback) — scans settlement TSVs for ad-related fee rows

## Strategy 1: Amazon Advertising API Setup

The Advertising API is **separate from SP-API** and requires its own registration:

### Prerequisites

1. **Amazon Advertising Account** — must be linked to your Seller Central account
2. **Developer Registration** — register at [advertising.amazon.com/developer](https://advertising.amazon.com/developer)
3. **API Access Approval** — request access; Amazon reviews applications (can take days)
4. **Client ID** — same LWA `client_id` used for SP-API works here
5. **Advertising Profile** — each marketplace has a profile; the script auto-discovers via `GET /v2/profiles`

### What's Needed (if not yet set up)

| Step | Action | Status |
|------|--------|--------|
| 1 | Register at [advertising.amazon.com/developer](https://advertising.amazon.com/developer) | ❓ Check |
| 2 | Link your SP-API app to Advertising API access | ❓ Check |
| 3 | Ensure LWA app has `advertising::campaign_management` scope | ❓ Check |
| 4 | Verify refresh token has advertising permissions | ❓ Check |

### Auth Flow

The Advertising API uses the same LWA OAuth tokens as SP-API:
- Same `client_id` / `client_secret`
- Same `refresh_token` (if the app has advertising scope)
- Extra header: `Amazon-Advertising-API-ClientId: <client_id>`
- Profile-scoped: `Amazon-Advertising-API-Scope: <profile_id>`

### Endpoints Used

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/v2/profiles` | List advertising profiles for the account |
| POST | `/reporting/reports` | Request a Sponsored Products campaign report |
| GET | `/reporting/reports/{id}` | Check report status and get download URL |

## Strategy 2: Settlement Report Mining

Settlement reports (`GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2`) may contain advertising fees. The script scans for rows where:

- `amount-type` contains "Advertising" or "Sponsored"
- `amount-description` contains "Advertising", "Sponsored", "CPC"
- `transaction-type` is "other-transaction" with ad-related descriptions

### Important Limitation

Most Sponsored Products charges are billed directly to your credit card and do **not** appear in settlement reports. Settlement mining catches:

- Advertising credits/adjustments
- Ad fees deducted from seller balance
- Promotional advertising charges

For full campaign-level spend data, the Advertising API (Strategy 1) is required.

## Usage

```bash
# Normal run (tries Ads API, then mines settlements)
node amazon-ads.mjs

# Skip Ads API, only mine settlements
node amazon-ads.mjs --settlement-only

# Custom lookback period
node amazon-ads.mjs --days 30
```

## Data Model

Stored in `channel_fees`:

```json
{
  "channel_id": "7f84462f-...",
  "order_id": null,            // null for campaign-level, set if order-linked
  "fee_type": "advertising",
  "description": "Sponsored Products: Campaign Name",
  "amount": 12.50,
  "currency_code": "USD",
  "incurred_at": "2025-01-15",
  "external_ref": "ads-{profileId}-{campaignId}-{date}",
  "metadata": {
    "source": "ads_api",       // or "settlement"
    "campaign_id": "...",
    "campaign_name": "...",
    "impressions": 1234,
    "clicks": 56,
    "profile_id": "..."
  }
}
```

## Cron

Added to `cron.mjs` as `amazon-ads`, runs daily (1440 min interval), in the `amazon` API group.
