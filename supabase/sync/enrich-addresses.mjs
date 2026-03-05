#!/usr/bin/env node
/**
 * enrich-addresses.mjs
 * 
 * Backfills anonymized shipping addresses from:
 * 1. ShipStation V1 API (primary - has 22k+ shipments with full addresses)
 * 2. Amazon SP-API GetOrder (fallback for orders not in ShipStation)
 * 3. Walmart API (fallback for Walmart orders)
 * 
 * Matches by channel_order_id (Amazon order number) → ShipStation orderNumber
 * Updates the addresses table in-place with real city/state/zip/country.
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const envFile = readFileSync(resolve(__dirname, '../.env.local'), 'utf8');
for (const line of envFile.split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}

// --- Credentials ---
const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials in .env.local'); process.exit(1); }

const op = (ref) => execSync(`op read "${ref}"`, { encoding: 'utf8' }).trim();
const SS_KEY = op('op://Agents Service Accounts/Shipstation v1 API Credential/API Key');
const SS_SECRET = op('op://Agents Service Accounts/Shipstation v1 API Credential/API Secret');
const SS_AUTH = 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

const AMZ_CLIENT = op('op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials');
const AMZ_SECRET = op('op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret');
const AMZ_REFRESH = op('op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken');

const WM_CLIENT = op('op://Agents Service Accounts/Walmart API Credentials/username');
const WM_SECRET = op('op://Agents Service Accounts/Walmart API Credentials/credential');

// --- Helpers ---
function supa(path, opts = {}) {
    return fetch(`${SUPA_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal',
            ...(opts.headers || {})
        }
    });
}

async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'count=exact'
        }
    });
    const count = res.headers.get('content-range')?.split('/')?.[1];
    return { data: await res.json(), count: count ? parseInt(count) : null };
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// --- ShipStation ---
let ssRateRemaining = 40;
async function ssGet(path) {
    if (ssRateRemaining < 3) { console.log('  ShipStation rate limit, sleeping 30s...'); await sleep(30000); }
    const res = await fetch(`https://ssapi.shipstation.com${path}`, {
        headers: { Authorization: SS_AUTH }
    });
    ssRateRemaining = parseInt(res.headers.get('x-rate-limit-remaining') || '40');
    if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
    return res.json();
}

// --- Amazon SP-API ---
let amzToken = null;
let amzTokenExpiry = 0;
async function getAmzToken() {
    if (amzToken && Date.now() < amzTokenExpiry) return amzToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: AMZ_REFRESH,
            client_id: AMZ_CLIENT,
            client_secret: AMZ_SECRET
        })
    });
    const data = await res.json();
    amzToken = data.access_token;
    amzTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return amzToken;
}

async function amzGetOrder(orderId) {
    const token = await getAmzToken();
    const res = await fetch(`https://sellingpartnerapi-na.amazon.com/orders/v0/orders/${orderId}`, {
        headers: { 'x-amz-access-token': token }
    });
    if (res.status === 429) { await sleep(5000); return amzGetOrder(orderId); }
    if (!res.ok) throw new Error(`Amazon ${res.status}`);
    const data = await res.json();
    return data.payload?.ShippingAddress || null;
}

// --- Walmart ---
let wmToken = null;
let wmTokenExpiry = 0;
async function getWmToken() {
    if (wmToken && Date.now() < wmTokenExpiry) return wmToken;
    const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Authorization: 'Basic ' + Buffer.from(`${WM_CLIENT}:${WM_SECRET}`).toString('base64'),
            'WM_SVC.NAME': 'Walmart Marketplace', 'WM_QOS.CORRELATION_ID': Date.now().toString()
        },
        body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    wmToken = data.access_token;
    wmTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return wmToken;
}

async function wmGetOrder(purchaseOrderId) {
    const token = await getWmToken();
    const res = await fetch(`https://marketplace.walmartapis.com/v3/orders/${purchaseOrderId}`, {
        headers: {
            'WM_SEC.ACCESS_TOKEN': token,
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': Date.now().toString(),
            Accept: 'application/json'
        }
    });
    if (res.status === 429) { await sleep(5000); return wmGetOrder(purchaseOrderId); }
    if (!res.ok) return null;
    const data = await res.json();
    return data.order?.shippingInfo?.postalAddress || null;
}

// --- Main ---
async function main() {
    const source = process.argv[2] || 'shipstation'; // shipstation, amazon, walmart, all
    
    console.log('=== Address Enrichment ===');
    console.log(`Source: ${source}`);
    
    // Get anonymized address IDs
    const { data: anonAddrs } = await supaGet(
        "addresses?select=id&or=(country.eq.Anonymized by Amazon,state.eq.Anonymized by Amazon)&limit=50000"
    );
    const anonIds = new Set(anonAddrs.map(a => a.id));
    console.log(`Found ${anonIds.size} anonymized addresses`);
    
    // Get orders with those addresses (paginate - Supabase default limit is 1000)
    let allOrders = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
        const { data: page } = await supaGet(
            `orders?select=id,order_number,shipping_address_id,channel_id,customer_id` +
            `&shipping_address_id=not.is.null&order=ordered_at.desc` +
            `&limit=${pageSize}&offset=${offset}`
        );
        if (!page?.length) break;
        allOrders.push(...page);
        offset += pageSize;
        if (page.length < pageSize) break;
    }
    
    const anonOrders = allOrders.filter(o => anonIds.has(o.shipping_address_id));
    console.log(`Found ${anonOrders.length} orders with anonymized addresses (of ${allOrders.length} total)`);
    
    if (source === 'shipstation' || source === 'all') {
        await enrichFromShipStation(anonOrders);
    }
    if (source === 'amazon' || source === 'all') {
        // Re-query orders still pointing to the anonymized address
        const ANON_ADDR_ID = '3270763f-4018-4dc7-b778-7854a7a4ff67';
        const amzChannelId = '7f84462f-86c8-4e09-abb6-285631db0d83';
        let amzOrders = [];
        let off = 0;
        while (true) {
            const { data: page } = await supaGet(
                `orders?select=id,order_number,shipping_address_id,channel_id,customer_id` +
                `&shipping_address_id=eq.${ANON_ADDR_ID}&channel_id=eq.${amzChannelId}` +
                `&limit=1000&offset=${off}`
            );
            if (!page?.length) break;
            amzOrders.push(...page);
            off += 1000;
            if (page.length < 1000) break;
        }
        console.log(`Found ${amzOrders.length} Amazon orders still anonymized`);
        await enrichFromAmazon(amzOrders);
    }
    if (source === 'walmart' || source === 'all') {
        const ANON_ADDR_ID = '3270763f-4018-4dc7-b778-7854a7a4ff67';
        const wmChannelId = '2da7e1e0-579e-4968-bdef-fa18492a6a86';
        let wmOrders = [];
        let off = 0;
        while (true) {
            const { data: page } = await supaGet(
                `orders?select=id,order_number,shipping_address_id,channel_id,customer_id` +
                `&shipping_address_id=eq.${ANON_ADDR_ID}&channel_id=eq.${wmChannelId}` +
                `&limit=1000&offset=${off}`
            );
            if (!page?.length) break;
            wmOrders.push(...page);
            off += 1000;
            if (page.length < 1000) break;
        }
        console.log(`Found ${wmOrders.length} Walmart orders still anonymized`);
        await enrichFromWalmart(wmOrders);
    }
}

async function enrichFromShipStation(anonOrders) {
    console.log('\n--- ShipStation Address Enrichment ---');
    
    // Build lookup: order_number -> order(s)
    const orderLookup = new Map();
    for (const o of anonOrders) {
        if (o.order_number) {
            if (!orderLookup.has(o.order_number)) orderLookup.set(o.order_number, []);
            orderLookup.get(o.order_number).push(o);
        }
    }
    console.log(`  ${orderLookup.size} unique order numbers to match`);
    
    let page = 1;
    let matched = 0;
    let created = 0;
    let totalPages = 1;
    const processed = new Set(); // track order IDs already done
    
    while (page <= totalPages) {
        const data = await ssGet(`/shipments?pageSize=500&page=${page}&sortBy=CreateDate&sortDir=DESC`);
        totalPages = Math.ceil((data.total || 0) / 500);
        
        if (!data.shipments?.length) break;
        
        // Batch: collect address inserts and order updates
        const addrInserts = [];
        const orderUpdates = []; // {orderId, addrTempIndex}
        
        for (const ship of data.shipments) {
            const orderNum = ship.orderNumber;
            if (!orderNum || !ship.shipTo) continue;
            
            const orders = orderLookup.get(orderNum);
            if (!orders) continue;
            
            const to = ship.shipTo;
            if (!to.state && !to.city) continue;
            
            for (const order of orders) {
                if (processed.has(order.id)) continue;
                processed.add(order.id);
                matched++;
                
                // Parse name into first/last
                const nameParts = (to.name || '').split(' ');
                const firstName = nameParts[0] || '';
                const lastName = nameParts.slice(1).join(' ') || '';
                
                // Create a new address record for this order
                const addr = {
                    customer_id: order.customer_id || null,
                    address_type: 'shipping',
                    first_name: firstName,
                    last_name: lastName,
                    company: to.company || null,
                    address_line_1: to.street1 || null,
                    address_line_2: to.street2 || null,
                    city: to.city || null,
                    state: to.state || null,
                    country: to.country || 'US',
                    postal_code: to.postalCode || null,
                    phone: to.phone || null,
                    is_residential: to.residential ?? null,
                };
                
                // Insert address and get back ID
                const res = await supa('addresses', {
                    method: 'POST',
                    headers: { Prefer: 'return=representation' },
                    body: JSON.stringify(addr)
                });
                
                if (!res.ok) {
                    console.error(`  Failed to insert address for order ${order.id}: ${res.status}`);
                    continue;
                }
                
                const [newAddr] = await res.json();
                
                // Update order to point to new address
                const updateRes = await supa(`orders?id=eq.${order.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ shipping_address_id: newAddr.id, updated_at: new Date().toISOString() })
                });
                
                if (updateRes.ok) {
                    created++;
                } else {
                    console.error(`  Failed to update order ${order.id}: ${updateRes.status}`);
                }
            }
        }
        
        if (page % 5 === 0 || page === totalPages) {
            console.log(`  Page ${page}/${totalPages}: ${matched} matched, ${created} addresses created`);
        }
        page++;
    }
    
    console.log(`ShipStation complete: ${matched} matched, ${created} new addresses created`);
}

async function enrichFromAmazon(amzOrders) {
    console.log(`\n--- Amazon SP-API Address Enrichment (${amzOrders.length} orders) ---`);
    
    let created = 0;
    let skipped = 0;
    let apiErrors = 0;
    
    for (let i = 0; i < amzOrders.length; i++) {
        const order = amzOrders[i];
        try {
            const addr = await amzGetOrder(order.order_number);
            if (!addr || !addr.StateOrRegion) { skipped++; continue; }
            
            const nameParts = (addr.Name || '').split(' ');
            const newAddr = {
                customer_id: order.customer_id || null,
                address_type: 'shipping',
                first_name: nameParts[0] || '',
                last_name: nameParts.slice(1).join(' ') || '',
                address_line_1: addr.AddressLine1 || null,
                address_line_2: addr.AddressLine2 || null,
                city: addr.City || null,
                state: addr.StateOrRegion || null,
                postal_code: addr.PostalCode || null,
                country: addr.CountryCode || 'US',
            };
            
            const res = await supa('addresses', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify(newAddr)
            });
            
            if (!res.ok) { apiErrors++; continue; }
            const [inserted] = await res.json();
            
            await supa(`orders?id=eq.${order.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ shipping_address_id: inserted.id, updated_at: new Date().toISOString() })
            });
            created++;
            
            if ((i + 1) % 100 === 0) console.log(`  Amazon: ${i + 1}/${amzOrders.length}, ${created} created, ${skipped} no-addr, ${apiErrors} api-errors`);
            await sleep(200); // Amazon GetOrder burst rate is 15 req/sec
        } catch (e) {
            apiErrors++;
            console.error(`  API error on ${order.order_number}: ${e.message}`);
            if (apiErrors > 50) { console.error('  Too many API errors, stopping'); break; }
            await sleep(2000);
        }
    }
    
    console.log(`Amazon complete: ${created} created, ${skipped} no-address, ${apiErrors} api-errors`);
}

async function enrichFromWalmart(wmOrders) {
    console.log(`\n--- Walmart Address Enrichment (${wmOrders.length} orders) ---`);
    
    let created = 0;
    let errors = 0;
    
    for (let i = 0; i < wmOrders.length; i++) {
        const order = wmOrders[i];
        try {
            const addr = await wmGetOrder(order.order_number);
            if (!addr || !addr.state) { errors++; continue; }
            
            const nameParts = (addr.name || '').split(' ');
            const newAddr = {
                customer_id: order.customer_id || null,
                address_type: 'shipping',
                first_name: nameParts[0] || '',
                last_name: nameParts.slice(1).join(' ') || '',
                address_line_1: addr.address1 || null,
                address_line_2: addr.address2 || null,
                city: addr.city || null,
                state: addr.state || null,
                postal_code: addr.postalCode || null,
                country: addr.country || 'US',
            };
            
            const res = await supa('addresses', {
                method: 'POST',
                headers: { Prefer: 'return=representation' },
                body: JSON.stringify(newAddr)
            });
            
            if (!res.ok) { errors++; continue; }
            const [inserted] = await res.json();
            
            await supa(`orders?id=eq.${order.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ shipping_address_id: inserted.id, updated_at: new Date().toISOString() })
            });
            created++;
            
            if ((i + 1) % 20 === 0) console.log(`  Walmart: ${i + 1}/${wmOrders.length}, ${created} created`);
            await sleep(500);
        } catch (e) {
            errors++;
        }
    }
    
    console.log(`Walmart complete: ${created} created, ${errors} errors`);
}

main().catch(e => { console.error(e); process.exit(1); });
