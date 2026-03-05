#!/usr/bin/env node
/**
 * Standalone Amazon address enrichment - pulls addresses from SP-API
 * for orders still pointing to the anonymized address record.
 */
import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(resolve(__dirname, '../.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Use 1Password service account (never expires)
const op = (ref) => execSync(`op read "${ref}"`, {
    encoding: 'utf8',
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN }
}).trim();

const AMZ_CLIENT = op('op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials');
const AMZ_SECRET = op('op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret');
const AMZ_REFRESH = op('op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken');
console.log('Credentials loaded via service account');

process.on('uncaughtException', (e) => { console.error('UNCAUGHT:', e); process.exit(1); });
process.on('unhandledRejection', (e) => { console.error('UNHANDLED REJECTION:', e); process.exit(1); });

const ANON_ADDR_ID = '3270763f-4018-4dc7-b778-7854a7a4ff67';
const AMZ_CHANNEL = '7f84462f-86c8-4e09-abb6-285631db0d83';
const sleep = ms => new Promise(r => setTimeout(r, ms));

let accessToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token', refresh_token: AMZ_REFRESH,
            client_id: AMZ_CLIENT, client_secret: AMZ_SECRET
        })
    });
    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

function supa(path, opts = {}) {
    return fetch(`${SUPA_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json', Prefer: opts.prefer || 'return=minimal',
            ...(opts.headers || {})
        },
        body: opts.body ? (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)) : undefined
    });
}

async function main() {
    console.log('=== Amazon Address Enrichment ===');
    
    // Get all Amazon orders still pointing to anonymized address
    let orders = [];
    let offset = 0;
    while (true) {
        const res = await supa(
            `orders?select=id,order_number,customer_id` +
            `&shipping_address_id=eq.${ANON_ADDR_ID}` +
            `&channel_id=eq.${AMZ_CHANNEL}` +
            `&order=ordered_at.asc` +
            `&limit=1000&offset=${offset}`
        );
        const page = await res.json();
        if (!page?.length) break;
        orders.push(...page);
        offset += 1000;
        if (page.length < 1000) break;
    }
    
    console.log(`${orders.length} Amazon orders need addresses`);
    
    let created = 0, skipped = 0, apiErrors = 0;
    
    for (let i = 0; i < orders.length; i++) {
        const order = orders[i];
        try {
            const token = await getToken();
            const res = await fetch(
                `https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${order.order_number}`,
                { headers: { 'x-amz-access-token': token } }
            );
            
            if (res.status === 429) {
                const retry = parseInt(res.headers.get('x-amzn-ratelimit-limit') || '0');
                console.log(`  Rate limited at ${i}/${orders.length} (${created} created so far), sleeping 60s...`);
                await sleep(60000);
                i--; // retry
                continue;
            }
            
            if (!res.ok) {
                apiErrors++;
                if (i < 5) console.log(`  ${order.order_number}: HTTP ${res.status}`);
                await sleep(500);
                continue;
            }
            
            const data = await res.json();
            const addr = data.payload?.ShippingAddress;
            
            if (!addr || !addr.StateOrRegion) {
                skipped++;
                continue;
            }
            
            // Create new address
            const nameParts = (addr.Name || '').split(' ');
            const insertRes = await supa('addresses', {
                method: 'POST',
                prefer: 'return=representation',
                body: {
                    customer_id: order.customer_id || null,
                    address_type: 'shipping',
                    first_name: nameParts[0] || '',
                    last_name: nameParts.slice(1).join(' ') || '',
                    address_line_1: addr.AddressLine1 || null,
                    address_line_2: addr.AddressLine2 || null,
                    city: addr.City || null,
                    state: addr.StateOrRegion,
                    postal_code: addr.PostalCode || null,
                    country: addr.CountryCode || 'US',
                }
            });
            
            if (!insertRes.ok) {
                apiErrors++;
                if (apiErrors <= 5) console.log(`  Insert failed ${order.order_number}: ${insertRes.status} ${await insertRes.text()}`);
                continue;
            }
            
            const [newAddr] = await insertRes.json();
            
            // Update order
            await supa(`orders?id=eq.${order.id}`, {
                method: 'PATCH',
                body: { shipping_address_id: newAddr.id, updated_at: new Date().toISOString() }
            });
            
            created++;
            
            if ((i + 1) % 100 === 0) {
                console.log(`  ${i + 1}/${orders.length}: ${created} created, ${skipped} no-addr, ${apiErrors} errors`);
            }
            
            await sleep(1000); // 1 req/sec to avoid rate limits
        } catch (e) {
            apiErrors++;
            console.error(`  Exception on ${order.order_number}: ${e.message}`);
            if (apiErrors > 100) {
                console.error('  Too many errors, stopping');
                break;
            }
            await sleep(2000);
        }
    }
    
    console.log(`\nDone: ${created} created, ${skipped} no-address, ${apiErrors} errors (of ${orders.length} total)`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
