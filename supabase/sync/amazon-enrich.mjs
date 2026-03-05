#!/usr/bin/env node

/**
 * Amazon Order Tax Enrichment → Supabase
 * Backfills tax_amount for Amazon orders using SP-API GetOrderItems,
 * with ShipStation V1 fallback when SP-API returns zero tax.
 *
 * Strategy:
 *   1. Query Supabase for Amazon orders with tax_amount=0 (newest first)
 *   2. Batch fetch order-level data via SP-API GetOrders (up to 50 per call)
 *   3. For each order, call GetOrderItems to get line-item tax
 *   4. If SP-API returns 0 tax, cross-check ShipStation V1 API
 *   5. Save cursor so we resume where we left off
 *
 * Usage:
 *   node amazon-enrich.mjs                # Enrich all (resumes from cursor)
 *   node amazon-enrich.mjs --batch 10     # Process only 10 orders
 *   node amazon-enrich.mjs --reset        # Reset cursor, start from newest
 *   node amazon-enrich.mjs --dry-run      # Preview without writing
 *
 * SP-API rate limits:
 *   GetOrders:     0.0167 req/s burst 20 (batches of 50 IDs)
 *   GetOrderItems: 0.5 req/s burst 30
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESET = args.includes('--reset');
const batchArg = args.find((_, i) => args[i - 1] === '--batch');
const BATCH_SIZE = batchArg ? parseInt(batchArg) : null; // null = all

const CURSOR_FILE = join(__dirname, '..', '.locks', 'amazon-enrich.cursor.json');
const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';

// ─── Credentials ─────────────────────────────────────────────────────
function loadEnv() {
    try {
        const content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
        for (const line of content.split('\n')) {
            const m = line.match(/^(\w+)=(.+)$/);
            if (m) process.env[m[1]] = m[2];
        }
    } catch {}
}
loadEnv();

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

function opRead(ref) {
    return execSync(`op read "${ref}"`, { encoding: 'utf8', env: { ...process.env } }).trim();
}

// Amazon SP-API creds
const AMZ_CLIENT_ID = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials');
const AMZ_CLIENT_SECRET = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret');
const AMZ_REFRESH_TOKEN = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken');
const AMZ_MARKETPLACE = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/MarketplaceId');

// ShipStation V1 creds
const SS_KEY = opRead('op://Agents Service Accounts/Shipstation v1 API Credential/API Key');
const SS_SECRET = opRead('op://Agents Service Accounts/Shipstation v1 API Credential/API Secret');
const SS_AUTH = 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    total_pending: 0,
    processed: 0,
    enriched_spapi: 0,
    enriched_shipstation: 0,
    still_zero: 0,
    already_done: 0,
    errors: 0,
    total_tax_found: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Cursor management ──────────────────────────────────────────────
function loadCursor() {
    if (RESET) return null;
    try {
        if (existsSync(CURSOR_FILE)) {
            return JSON.parse(readFileSync(CURSOR_FILE, 'utf8'));
        }
    } catch {}
    return null;
}

function saveCursor(data) {
    if (DRY_RUN) return;
    writeFileSync(CURSOR_FILE, JSON.stringify({
        ...data,
        updated_at: new Date().toISOString()
    }, null, 2));
}

// ─── Amazon SP-API Auth ──────────────────────────────────────────────
let amzAccessToken = null;
let amzTokenExpiry = 0;

async function amzAuth() {
    if (amzAccessToken && Date.now() < amzTokenExpiry) return amzAccessToken;

    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: AMZ_REFRESH_TOKEN,
            client_id: AMZ_CLIENT_ID,
            client_secret: AMZ_CLIENT_SECRET
        })
    });

    if (!res.ok) throw new Error(`Amazon auth failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    amzAccessToken = data.access_token;
    amzTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return amzAccessToken;
}

// ─── SP-API rate-limited fetch ───────────────────────────────────────
async function spApiGet(path, retries = 3) {
    const token = await amzAuth();
    const url = `https://sellingpartnerapi-na.amazon.com${path}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        const res = await fetch(url, {
            headers: {
                'x-amz-access-token': token,
                'Content-Type': 'application/json'
            }
        });

        if (res.status === 429) {
            const wait = Math.min(2 ** attempt * 2, 30);
            log(`  ⏳ SP-API 429, retry ${attempt}/${retries} in ${wait}s...`);
            await sleep(wait * 1000);
            continue;
        }
        if (res.status === 403) {
            // Token might have expired mid-batch
            amzAccessToken = null;
            const newToken = await amzAuth();
            const retry = await fetch(url, {
                headers: { 'x-amz-access-token': newToken, 'Content-Type': 'application/json' }
            });
            if (!retry.ok) throw new Error(`SP-API ${retry.status}: ${await retry.text()}`);
            return retry.json();
        }
        if (!res.ok) {
            const body = await res.text();
            throw new Error(`SP-API ${res.status}: ${body.slice(0, 300)}`);
        }
        return res.json();
    }
    throw new Error('SP-API: max retries exceeded');
}

// ─── SP-API: GetOrderItems ──────────────────────────────────────────
async function getOrderItemsTax(orderId) {
    // GetOrderItems rate: 0.5 req/s, burst 30
    // We pace at ~1.5s between calls to stay safe
    const data = await spApiGet(`/orders/v0/orders/${orderId}/orderItems`);
    const items = data?.payload?.OrderItems || [];

    let totalTax = 0;
    const lineItems = [];

    for (const item of items) {
        const itemTax = parseFloat(item.ItemTax?.Amount || '0');
        const shippingTax = parseFloat(item.ShippingTax?.Amount || '0');
        const lineTax = itemTax + shippingTax;
        totalTax += lineTax;
        lineItems.push({
            asin: item.ASIN,
            sku: item.SellerSKU,
            quantity: item.QuantityOrdered,
            item_tax: itemTax,
            shipping_tax: shippingTax,
            total_tax: +lineTax.toFixed(2)
        });
    }

    return { totalTax: +totalTax.toFixed(2), lineItems };
}

// ─── ShipStation V1 fallback ─────────────────────────────────────────
let ssRateLimitRemaining = 40;

async function ssGet(path) {
    if (ssRateLimitRemaining <= 2) {
        log('  ⏳ ShipStation rate limit pause (11s)...');
        await sleep(11000);
        ssRateLimitRemaining = 40;
    }

    const res = await fetch(`https://ssapi.shipstation.com${path}`, {
        headers: { Authorization: SS_AUTH }
    });

    const remaining = res.headers.get('x-rate-limit-remaining');
    if (remaining != null) ssRateLimitRemaining = parseInt(remaining);

    if (res.status === 429) {
        const reset = parseInt(res.headers.get('x-rate-limit-reset') || '10');
        log(`  ⏳ ShipStation 429, waiting ${reset + 1}s...`);
        await sleep((reset + 1) * 1000);
        ssRateLimitRemaining = 40;
        return ssGet(path);
    }
    if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
    }
    return res.json();
}

async function getShipStationTax(orderNumber) {
    const data = await ssGet(`/orders?orderNumber=${encodeURIComponent(orderNumber)}`);
    if (!data?.orders?.length) return 0;

    // Sum tax from all matching orders (usually 1)
    let totalTax = 0;
    for (const order of data.orders) {
        totalTax += order.taxAmount || 0;
    }
    return +totalTax.toFixed(2);
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaGetWithCount(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            Prefer: 'count=exact'
        }
    });
    const contentRange = res.headers.get('content-range');
    const total = contentRange ? parseInt(contentRange.split('/')[1]) : null;
    const data = await res.json();
    return { data, total };
}

async function supaPatch(table, filter, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`PATCH ${table} ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
}

// ─── Fetch pending orders from Supabase ──────────────────────────────
async function fetchPendingOrders(cursor) {
    // Get total count first
    const { total } = await supaGetWithCount(
        `orders?channel_id=eq.${AMAZON_CHANNEL_ID}&tax_amount=eq.0&select=id&limit=1`
    );
    stats.total_pending = total || 0;

    // Fetch orders newest first, paginated
    // If we have a cursor, skip orders we've already processed
    const limit = BATCH_SIZE || 1000; // Fetch in pages of 1000 max
    let query = `orders?channel_id=eq.${AMAZON_CHANNEL_ID}&tax_amount=eq.0&select=id,order_number,ordered_at,tax_amount,external_ids&order=ordered_at.desc&limit=${limit}`;

    // If cursor has a list of already-processed order IDs, we can't easily
    // filter those via REST. Instead, we track by ordered_at cutoff.
    if (cursor?.last_ordered_at) {
        // Process orders older than cursor (we work newest → oldest)
        query += `&ordered_at=lt.${encodeURIComponent(cursor.last_ordered_at)}`;
    }

    const orders = await supaGet(query);
    return Array.isArray(orders) ? orders : [];
}

// ─── Process one order ───────────────────────────────────────────────
async function enrichOrder(order, index, total) {
    const { id, order_number, ordered_at } = order;

    // Progress logging
    const remaining = stats.total_pending - stats.processed;
    if (index % 10 === 0 || index === total - 1) {
        log(`[${stats.processed + 1} of ${stats.total_pending}] ${order_number} (${ordered_at?.split('T')[0]}) — ${remaining} remaining`);
    }

    try {
        // Step 1: Try SP-API GetOrderItems
        let tax = 0;
        let source = null;
        let lineItems = [];

        try {
            const result = await getOrderItemsTax(order_number);
            tax = result.totalTax;
            lineItems = result.lineItems;
            if (tax > 0) source = 'sp-api';
        } catch (e) {
            if (e.message.includes('InvalidInput') || e.message.includes('not found')) {
                // Order not in SP-API (might be old), try ShipStation
            } else {
                throw e;
            }
        }

        // Step 2: If SP-API returned 0, try ShipStation
        if (tax === 0) {
            try {
                tax = await getShipStationTax(order_number);
                if (tax > 0) source = 'shipstation';
            } catch (e) {
                log(`  ⚠ ShipStation fallback failed for ${order_number}: ${e.message}`);
            }
        }

        // Step 3: Update Supabase
        if (tax > 0) {
            const existingExtIds = order.external_ids || {};
            const updates = {
                tax_amount: tax,
                external_ids: {
                    ...existingExtIds,
                    tax_source: source,
                    ...(lineItems.length ? { amazon_tax_details: lineItems } : {})
                }
            };

            await supaPatch('orders', `id=eq.${id}`, updates);

            if (source === 'sp-api') stats.enriched_spapi++;
            else stats.enriched_shipstation++;
            stats.total_tax_found += tax;
        } else {
            // Mark as checked so we don't re-process endlessly
            // We still leave tax_amount=0 but note we checked
            const existingExtIds = order.external_ids || {};
            if (!existingExtIds.tax_checked) {
                await supaPatch('orders', `id=eq.${id}`, {
                    external_ids: { ...existingExtIds, tax_checked: new Date().toISOString() }
                });
            }
            stats.still_zero++;
        }

        stats.processed++;

        // Pace for SP-API GetOrderItems (0.5 req/s, burst 30)
        // ~1.5s between calls keeps us well under limits
        await sleep(1500);

    } catch (e) {
        log(`  ⚠ ${order_number}: ${e.message}`);
        stats.errors++;
        stats.processed++;

        // On rate limit errors, back off more
        if (e.message.includes('429') || e.message.includes('QuotaExceeded')) {
            log('  ⏳ Backing off 30s...');
            await sleep(30000);
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting Amazon order tax enrichment');
    if (DRY_RUN) log('*** DRY RUN ***');
    if (BATCH_SIZE) log(`Batch size: ${BATCH_SIZE}`);

    // Load cursor
    let cursor = loadCursor();
    if (cursor) {
        log(`Resuming from cursor: processed ${cursor.total_processed || 0} orders, last_ordered_at=${cursor.last_ordered_at || 'none'}`);
    } else {
        log('Starting fresh (no cursor)');
    }

    // Fetch pending orders
    const orders = await fetchPendingOrders(cursor);
    const toProcess = BATCH_SIZE ? orders.slice(0, BATCH_SIZE) : orders;

    log(`Found ${stats.total_pending} total orders with tax_amount=0`);
    log(`Processing ${toProcess.length} orders (newest first)`);

    if (toProcess.length === 0) {
        log('Nothing to process!');
        return;
    }

    // Process orders
    for (let i = 0; i < toProcess.length; i++) {
        await enrichOrder(toProcess[i], i, toProcess.length);

        // Save cursor every 50 orders
        if ((i + 1) % 50 === 0 || i === toProcess.length - 1) {
            const lastOrder = toProcess[i];
            saveCursor({
                last_ordered_at: lastOrder.ordered_at,
                last_order_number: lastOrder.order_number,
                total_processed: (cursor?.total_processed || 0) + stats.processed,
                last_batch_stats: { ...stats }
            });
        }
    }

    // Final summary
    log('────────────────────────────────────');
    log('Amazon tax enrichment complete!');
    log(`  Total pending:           ${stats.total_pending}`);
    log(`  Processed this run:      ${stats.processed}`);
    log(`  Enriched via SP-API:     ${stats.enriched_spapi}`);
    log(`  Enriched via ShipStation: ${stats.enriched_shipstation}`);
    log(`  Still zero (no tax):     ${stats.still_zero}`);
    log(`  Errors:                  ${stats.errors}`);
    log(`  Total tax found:         $${stats.total_tax_found.toFixed(2)}`);

    const enriched = stats.enriched_spapi + stats.enriched_shipstation;
    const remaining = stats.total_pending - stats.processed;
    log(`  ${enriched} of ${stats.processed} orders enriched, ${remaining} remaining`);

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
