# Snatch-It Hub Context

## Project
E-commerce business database in Supabase (PostgreSQL) syncing from Veeqo, Amazon SP-API, Walmart, ShipStation, SellerSnap.

## Supabase
- URL: `https://skgzcllomhsmpbkdnqqc.supabase.co`
- Service role key: in `.env.local` as `SUPABASE_SERVICE_ROLE_KEY`
- API URL: in `.env.local` as `SUPABASE_API_URL`
- Direct DB: `db.skgzcllomhsmpbkdnqqc.supabase.co:5432` (IPv6 only)
- Management API token: `op://Agents Service Accounts/SupabaseAccessToken/credential`

## 1Password Service Account
All scripts MUST use the service account token from `.env.local`:
```
OP_SERVICE_ACCOUNT_TOKEN=<token in .env.local>
```
When calling `op read`, pass env: `{ ...process.env }` so the token is inherited.

## Credentials (via op read)
- Amazon SP-API: `op://Agents Service Accounts/Amazon SP-API Credentials/{LWACredentials,ClientSecret,SellerRefreshToken,MarketplaceId}`
- Walmart: `op://Agents Service Accounts/Walmart API Credentials/{username,credential}`
- Veeqo: `op://Agents Service Accounts/Veeqo API Credentials/credential`
- ShipStation V1: `op://Agents Service Accounts/Shipstation v1 API Credential/{API Key,API Secret}`
- SellerSnap: `op://Agents Service Accounts/SellerSnap API Credentials/{api_key,api_secret}`

## Key Files
- Sync scripts: `supabase/sync/*.mjs`
- Env file: `supabase/.env.local`
- Migrations: `supabase/migrations/*.sql`
- Lock/cursor files: `supabase/.locks/`
- Cron runner: `supabase/sync/cron.mjs`
- LaunchAgent plist: `~/Library/LaunchAgents/com.snatchit.sync.plist`

## Env Loading Pattern (no dotenv dependency)
```javascript
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(resolve(__dirname, '../.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
```

## Channel IDs
- Amazon: `7f84462f-86c8-4e09-abb6-285631db0d83`
- Walmart: `2da7e1e0-579e-4968-bdef-fa18492a6a86`
- eBay: `ae7560c4-0c84-4b81-8b7e-137d12d64101`

## Metabase
- URL: `https://metabase.jdchoi.net`
- Admin: `johanndchoi@snatched-it.com` / `e1-6-DDYjZXxjxQrkPpcP`
- Database ID: 2
- Collection "Snatch-It" ID: 5

## Rules
- Node.js ESM (.mjs) for all scripts
- Use Supabase REST API (not direct DB) for sync scripts
- Use `op read` with service account for credentials
- Incremental syncs with cursors after first run
- If data not found in Veeqo, cross-check ShipStation V1 API
- ShipStation V1 base URL: `https://ssapi.shipstation.com`
- ShipStation auth: Basic auth with API Key:Secret base64
