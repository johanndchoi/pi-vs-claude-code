# n8n Sync Migration — Agent Instructions

## Overview

Migrate 12 sync jobs from `com.snatchit.sync` LaunchAgent (local Mac cron) to n8n workflows at `https://n8n.snatched-it.com`. Each sync script in `supabase/sync/*.mjs` becomes an n8n workflow.

## Architecture Decision: Code Node Approach

These sync scripts have complex logic (pagination, rate limiting, cursor management, upsert batching) that doesn't map well to pure n8n node chains. **Use n8n Code nodes** containing the core sync logic, with n8n handling:

- **Scheduling** (Cron trigger node)
- **Credentials** (n8n credential store → injected into Code nodes)
- **Error handling** (n8n error workflow / notifications)
- **Execution history** (built-in logging/monitoring)

## Credentials Strategy

n8n can't access system env vars or 1Password. All secrets go into **n8n's built-in credential store** (encrypted at rest).

### Available credential types in n8n:
- `httpHeaderAuth` — for Bearer token APIs (Veeqo, Walmart)
- `httpBasicAuth` — for Basic auth APIs (ShipStation, SellerSnap)
- `supabaseApi` — already configured (host + service role key)
- `httpCustomAuth` — for complex auth (Amazon SP-API OAuth2)

### How to access credentials in Code nodes:
```javascript
// In n8n Code node, credentials are NOT directly accessible.
// Instead, use an HTTP Request node BEFORE the Code node to test auth,
// or restructure to use HTTP Request nodes for API calls with credential injection.
//
// For Code nodes that need raw API keys, pass them via a preceding
// "Set" node that reads from n8n credentials using expressions:
// {{ $credentials.httpHeaderAuth.value }}
```

### Recommended pattern per workflow:
```
[Schedule Trigger] → [Code: Build Config] → [HTTP Request: Fetch Page] →
[Code: Transform & Batch] → [HTTP Request: Upsert to Supabase] → [Loop]
```

For complex scripts, the pragmatic approach:
```
[Schedule Trigger] → [Code: Full Sync Logic] → [Supabase: Write Results]
```

Where the Code node contains the adapted script logic and credentials are passed in via workflow variables or preceding Set nodes.

## n8n API Access

```bash
N8N_URL="https://n8n.snatched-it.com"
N8N_API_KEY=$(op item get 'n8nAPICredential' --vault 'Agents Service Accounts' --reveal --format json | jq -r '.fields[] | select(.label == "credential") | .value')

# Create workflow
curl -X POST "$N8N_URL/api/v1/workflows" \
  -H "X-N8N-API-KEY: $N8N_API_KEY" \
  -H "Content-Type: application/json" \
  -d @workflow.json

# Activate workflow
curl -X PATCH "$N8N_URL/api/v1/workflows/{id}/activate" \
  -H "X-N8N-API-KEY: $N8N_API_KEY"
```

## Credential Sources (1Password)

| Service | 1Password Item | Fields |
|---------|---------------|--------|
| Supabase | (already in n8n) | host, serviceRoleKey |
| Veeqo | `Veeqo API Credentials` | credential |
| ShipStation | `Shipstation v1 API Credential` | API Key, API Secret |
| Amazon SP-API | `Amazon SP-API Credentials` | LWACredentials, ClientSecret, SellerRefreshToken, MarketplaceId |
| Walmart | `Walmart API Credentials` | username, credential |
| SellerSnap | `SellerSnapAPI` | username, password |

## Sync Job Reference

| Job | Script | Interval | API Group | Priority |
|-----|--------|----------|-----------|----------|
| veeqo-orders | veeqo-orders.mjs | 60 min | veeqo | P1 |
| veeqo-tracking | veeqo-tracking.mjs | 2 hours | veeqo | P1 |
| shipstation-shipments | shipstation-shipments.mjs | 6 hours | shipstation | P1 |
| veeqo-products | veeqo-products.mjs | 6 hours | veeqo | P2 |
| walmart-enrich | walmart-enrich.mjs | 6 hours | walmart | P2 |
| amazon-enrich | amazon-enrich.mjs | 6 hours | amazon | P2 |
| returns-sync | returns-sync.mjs | 12 hours | amazon | P2 |
| walmart-fees | walmart-fees.mjs | 12 hours | walmart | P2 |
| amazon-settlements | amazon-settlements.mjs | 12 hours | amazon | P2 |
| inventory-snapshot | inventory-snapshot.mjs | daily | veeqo | P2 |
| sellersnap-costs | sellersnap-costs.mjs | daily | sellersnap | P3 |
| amazon-ads | amazon-ads.mjs | daily | amazon | P3 |

## Workflow Template Structure

Each n8n workflow JSON should follow this structure:

```json
{
  "name": "Sync: <Job Name>",
  "nodes": [
    {
      "name": "Schedule",
      "type": "n8n-nodes-base.scheduleTrigger",
      "parameters": { "rule": { "interval": [{ "field": "minutes", "minutesInterval": 60 }] } }
    },
    {
      "name": "Sync Logic",
      "type": "n8n-nodes-base.code",
      "parameters": { "jsCode": "..." }
    }
  ],
  "settings": { "executionOrder": "v1" }
}
```

## Key Differences from Local Scripts

1. **No `op` CLI** — credentials come from n8n credential store, not 1Password
2. **No filesystem** — no cursor files in `.locks/`; use n8n static data or Supabase for state
3. **No `process.env`** — use `$env` or workflow variables in n8n
4. **Execution limits** — n8n has execution timeout; long-running syncs may need pagination within n8n's limits
5. **Rate limiting** — implement via `await new Promise(r => setTimeout(r, ms))` in Code nodes (same as scripts)
