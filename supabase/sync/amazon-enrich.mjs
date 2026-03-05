#!/usr/bin/env node

/**
 * Amazon SP-API → Supabase Order Enrichment (Optimized)
 * Fills in tax_amount, shipping_cost, discount_amount, total from Amazon SP-API.
 * Falls back to ShipStation V1 API when SP-API returns no tax data.
 *
 * Optimizations over original:
 *   - Batch GetOrders (up to 50 IDs) to skip per-order GetOrder calls
 *   - ShipStation V1 fallback for orders where SP-API has no tax
 *   - Cursor-based resume (picks up where it left off)
 *   - Newest-first processing (most valuable for current reporting)
 *   - Progress logging with ETA
 *
 * Usage:
 *   node amazon-enrich.mjs                  # Enrich orders with tax=0
 *   node amazon-enrich.mjs --all            # Re-enrich all Amazon orders
 *   node amazon-enrich.mjs --since 2026-01  # Only orders after date
 *   node amazon-enrich.mjs --dry-run        # Preview without writing
 *   node amazon-enrich.mjs --limit 10       # Process only N orders (for testing)
 *   node amazon-enrich.mjs --reset-cursor   # Clear saved cursor, start fresh
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALL = args.includes('--all');
const SINCE = args.find((_, i) => args[i - 1] === '--since');
const LIMIT = parseInt(args.find((_, i) => args[i - 1] === '--limit') || '0') || 0;
const RESET_CURSOR = args.includes('--reset-cursor');

// ─── Environment ─────────────────────────────────────────────────────
function loadEnv() {
    try {
        const content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
        for (const line of content.split('\n')) {
            const m = line.match(/^([^#=]+)=(.*)$/);
            if (m && !process.env[m[1].trim()]) process.env[m[1].trim()] = m[2].trim();
        }
    } catch {}
}
loadEnv();

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── 1Password credential loader ────────────────────────────────────
const op = (ref) => execSync(`op read "${ref}"`, {
    encoding: 'utf8',
    env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: process.env.OP_SERVICE_ACCOUNT_TOKEN }
}).trim();

// Amazon SP-API credentials
const LWA_CLIENT_ID = op('op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials');
const LWA_CLIENT_SECRET = op('op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret');
const REFRESH_TOKEN = op('op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken');

// ShipStation V1 credentials (fallback)
const SS_KEY = process.env.SS_V1_KEY ||
    op('op://Agents Service Accounts/Shipstation v1 API Credential/API Key');
const SS_SECRET = process.env.SS_V1_SECRET ||
    op('op://Agents Service Accounts/Shipstation v1 API Credential/API Secret');
const SS_AUTH = 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const MARKETPLACE_ID = 'ATVPDKIKX0DER'; // US marketplace

const stats = {
    checked: 0, enriched: 0, items_updated: 0,
    skipped: 0, api_errors: 0, errors: 0,
    ss_fallback: 0, ss_enriched: 0
};
const startTime = Date.now();
let totalToProcess = 0;

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Token Management ────────────────────────────────────────────────
let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}&client_id=${LWA_CLIENT_ID}&client_secret=${LWA_CLIENT_SECRET}`
    });
    const data = await res.json();
    if (!data.access_token) throw new Error('Token failed: ' + JSON.stringify(data));
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

// ─── SP-API Helpers ──────────────────────────────────────────────────
let rateLimitWait = 0;

async function spApiGet(path) {
    const token = await getAccessToken();
    const res = await fetch(`${SP_API_BASE}${path}`, {
        headers: { 'x-amz-access-token': token }
    });

    if (res.status === 429) {
        rateLimitWait = Math.min(60, (rateLimitWait || 5) * 2);
        log(`  ⏳ Rate limited, waiting ${rateLimitWait}s...`);
        await sleep(rateLimitWait * 1000);
        return spApiGet(path);
    }
    rateLimitWait = Math.max(0, rateLimitWait - 1);

    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`SP-API ${res.status}: ${body}`);
    }
    return res.json();
}

/**
 * Batch fetch orders from SP-API (up to 50 at a time).
 * Returns a Map of orderNumber → Order object.
 */
async function batchGetOrders(orderNumbers) {
    const map = new Map();
    // SP-API supports up to 50 AmazonOrderIds per request
    for (let i = 0; i < orderNumbers.length; i += 50) {
        const batch = orderNumbers.slice(i, i + 50);
        const ids = batch.join(',');
        const data = await spApiGet(
            `/orders/v0/orders?MarketplaceIds=${MARKETPLACE_ID}&AmazonOrderIds=${ids}`
        );
        if (data?.payload?.Orders) {
            for (const order of data.payload.Orders) {
                map.set(order.AmazonOrderId, order);
            }
        }
        // Rate limit: ~1 req/sec for getOrders
        if (i + 50 < orderNumbers.length) await sleep(1100);
    }
    return map;
}

// ─── ShipStation V1 Fallback ─────────────────────────────────────────
let ssRateBucket = 40; // SS V1 allows 40 req/60s
let ssLastReset = Date.now();

async function ssGet(path) {
    // Simple rate limiter: 40 req / 60s
    const now = Date.now();
    if (now - ssLastReset > 60000) {
        ssRateBucket = 40;
        ssLastReset = now;
    }
    if (ssRateBucket <= 1) {
        const waitMs = 60000 - (now - ssLastReset) + 500;
        log(`  ⏳ ShipStation rate limit, waiting ${(waitMs / 1000).toFixed(0)}s...`);
        await sleep(waitMs);
        ssRateBucket = 40;
        ssLastReset = Date.now();
    }
    ssRateBucket--;

    const res = await fetch(`https://ssapi.shipstation.com${path}`, {
        headers: { Authorization: SS_AUTH }
    });
    if (!res.ok) {
        if (res.status === 429) {
            await sleep(15000);
            return ssGet(path);
        }
        return null;
    }
    return res.json();
}

/**
 * Try to get tax from ShipStation V1 for a given order number.
 * Returns { taxAmount } or null.
 */
async function getShipStationTax(orderNumber) {
    stats.ss_fallback++;
    const data = await ssGet(`/orders?orderNumber=${encodeURIComponent(orderNumber)}`);
    if (!data?.orders?.length) return null;
    const ssOrder = data.orders[0];
    if (ssOrder.taxAmount && ssOrder.taxAmount > 0) {
        return { taxAmount: +ssOrder.taxAmount.toFixed(2) };
    }
    return null;
}

// ─── Supabase Helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaGetWithCount(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Prefer: 'count=exact' }
    });
    const count = parseInt(res.headers.get('content-range')?.split('/')[1] || '0');
    const data = await res.json();
    return { data, count };
}

async function supaPatch(table, id, data) {
    if (DRY_RUN) return true;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        log(`  ⚠ PATCH ${table} ${id}: ${res.status} ${body}`);
        return false;
    }
    return true;
}

// ─── Enrich a single order (with pre-fetched SP-API order data) ──────
async function enrichOrder(order, amzOrderMap) {
    const orderNum = order.order_number;
    const amzOrder = amzOrderMap.get(orderNum);

    // Get order items for tax/shipping/discount breakdown (must be per-order)
    const itemsData = await spApiGet(`/orders/v0/orders/${orderNum}/orderItems`);
    if (!itemsData?.payload?.OrderItems) {
        stats.api_errors++;
        return;
    }
    const amzItems = itemsData.payload.OrderItems;

    // Calculate totals from line items
    let totalTax = 0;
    let totalShipping = 0;
    let totalShippingTax = 0;
    let totalDiscount = 0;
    let totalShippingDiscount = 0;

    for (const item of amzItems) {
        totalTax += +(item.ItemTax?.Amount || 0);
        totalShipping += +(item.ShippingPrice?.Amount || 0);
        totalShippingTax += +(item.ShippingTax?.Amount || 0);
        totalDiscount += +(item.PromotionDiscount?.Amount || 0);
        totalShippingDiscount += +(item.ShippingDiscount?.Amount || 0);
    }

    const orderTotal = +(amzOrder?.OrderTotal?.Amount || 0);

    // Build order patch
    const orderPatch = {};
    if (totalTax > 0) orderPatch.tax_amount = +totalTax.toFixed(2);
    if (totalShipping > 0) orderPatch.shipping_cost = +totalShipping.toFixed(2);
    if (totalDiscount > 0) orderPatch.discount_amount = +(totalDiscount + totalShippingDiscount).toFixed(2);
    if (orderTotal > 0) orderPatch.total = orderTotal;

    // If SP-API returned no tax, try ShipStation V1 as fallback
    if (!orderPatch.tax_amount || orderPatch.tax_amount === 0) {
        const ssTax = await getShipStationTax(orderNum);
        if (ssTax) {
            orderPatch.tax_amount = ssTax.taxAmount;
            stats.ss_enriched++;
        }
    }

    if (Object.keys(orderPatch).length > 0) {
        const ok = await supaPatch('orders', order.id, orderPatch);
        if (ok) stats.enriched++;
        else stats.errors++;
    } else {
        stats.skipped++;
    }

    // Update order_items with per-item tax/shipping
    if (order.order_items?.length) {
        for (const dbItem of order.order_items) {
            const sku = dbItem.sku;
            const amzItem = amzItems.find(ai =>
                ai.SellerSKU === sku ||
                ai.ASIN === dbItem.metadata?.amazon_asin
            );
            if (!amzItem) continue;

            const itemPatch = {};
            const itemTax = +(amzItem.ItemTax?.Amount || 0);
            const itemDiscount = +(amzItem.PromotionDiscount?.Amount || 0);

            if (itemTax > 0) itemPatch.tax_amount = itemTax;
            if (itemDiscount > 0) itemPatch.discount_amount = itemDiscount;

            if (Object.keys(itemPatch).length > 0) {
                const ok = await supaPatch('order_items', dbItem.id, itemPatch);
                if (ok) stats.items_updated++;
            }
        }
    }
}

// ─── Cursor management ───────────────────────────────────────────────
const CURSOR_DIR = join(__dirname, '..', '.locks');
const CURSOR_FILE = join(CURSOR_DIR, 'amazon-enrich.cursor.json');

function loadCursor() {
    try {
        const raw = readFileSync(CURSOR_FILE, 'utf8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function saveCursor(data) {
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify({
        ...data,
        updated_at: new Date().toISOString()
    }, null, 2));
}

function clearCursor() {
    try { writeFileSync(CURSOR_FILE, '{}'); } catch {}
}

// ─── Progress Display ────────────────────────────────────────────────
function logProgress() {
    const elapsed = (Date.now() - startTime) / 1000;
    const rate = stats.checked / elapsed;
    const remaining = totalToProcess - stats.checked;
    const eta = rate > 0 ? remaining / rate : 0;
    const etaMin = Math.ceil(eta / 60);

    log(`  📊 ${stats.checked} of ${totalToProcess} orders enriched, ${remaining} remaining | ` +
        `${stats.enriched} enriched, ${stats.ss_enriched} via ShipStation | ` +
        `ETA: ${etaMin}m | ${rate.toFixed(1)} orders/sec`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Amazon SP-API order enrichment starting (optimized)');
    if (DRY_RUN) log('*** DRY RUN ***');
    if (LIMIT) log(`*** LIMITED TO ${LIMIT} ORDERS ***`);

    if (RESET_CURSOR) {
        clearCursor();
        log('Cursor reset');
    }

    // Load cursor for resume
    const cursor = loadCursor();
    let cursorOrderedAt = cursor?.last_ordered_at || null;

    // Build query for Amazon orders needing enrichment
    let filter = `channel_id=eq.${AMAZON_CHANNEL_ID}`;
    if (!ALL) filter += '&tax_amount=eq.0';
    if (SINCE) filter += `&ordered_at=gte.${SINCE}`;

    // If we have a cursor (and no explicit --since), resume from where we left off
    // Since we process newest-first (desc), cursor means "skip orders newer than this"
    if (cursorOrderedAt && !SINCE && !ALL && !RESET_CURSOR) {
        filter += `&ordered_at=lte.${cursorOrderedAt}`;
        log(`  Resuming from cursor: ${cursorOrderedAt}`);
    }

    // Get total count
    const { count: totalCount } = await supaGetWithCount(
        `orders?${filter}&select=id`
    );
    totalToProcess = LIMIT ? Math.min(LIMIT, totalCount) : totalCount;
    log(`  ${totalCount} orders need enrichment${LIMIT ? `, processing ${totalToProcess}` : ''}`);

    if (totalToProcess === 0) {
        log('Nothing to do!');
        return;
    }

    let offset = 0;
    const PAGE_SIZE = 50; // Match SP-API batch size

    while (stats.checked < totalToProcess) {
        // Fetch a page of orders from Supabase (newest first)
        const orders = await supaGet(
            `orders?${filter}&select=id,order_number,ordered_at,tax_amount,shipping_cost,total,order_items(id,sku,metadata)` +
            `&limit=${PAGE_SIZE}&offset=${offset}&order=ordered_at.desc`
        );
        if (!orders.length) break;

        // Batch-fetch order-level data from SP-API (up to 50 at once)
        const orderNumbers = orders.map(o => o.order_number);
        let amzOrderMap;
        try {
            amzOrderMap = await batchGetOrders(orderNumbers);
        } catch (e) {
            log(`  ⚠ Batch GetOrders failed: ${e.message}`);
            amzOrderMap = new Map();
        }

        // Process each order (still need per-order GetOrderItems call)
        for (const order of orders) {
            if (LIMIT && stats.checked >= LIMIT) break;
            stats.checked++;

            try {
                await enrichOrder(order, amzOrderMap);
            } catch (e) {
                log(`  ⚠ ${order.order_number}: ${e.message}`);
                stats.errors++;
            }

            // Save cursor after each order (the oldest ordered_at we've processed)
            if (order.ordered_at) {
                saveCursor({
                    last_ordered_at: order.ordered_at,
                    last_order_number: order.order_number,
                    stats: { ...stats }
                });
            }

            // SP-API rate limit for getOrderItems: ~0.5 req/sec
            // We eliminated the per-order getOrder call, so only need ~2s between orders
            await sleep(2000);

            // Progress every 25 orders
            if (stats.checked % 25 === 0) logProgress();
        }

        if (LIMIT && stats.checked >= LIMIT) break;
        offset += orders.length;
    }

    // Final progress
    logProgress();
    log('────────────────────────────────────');
    log(`Done! Checked ${stats.checked} Amazon orders:`);
    log(`  Enriched (SP-API):     ${stats.enriched - stats.ss_enriched}`);
    log(`  Enriched (ShipStation): ${stats.ss_enriched} (of ${stats.ss_fallback} fallback attempts)`);
    log(`  Total enriched:        ${stats.enriched}`);
    log(`  Items updated:         ${stats.items_updated}`);
    log(`  Skipped (no data):     ${stats.skipped}`);
    log(`  API errors:            ${stats.api_errors}`);
    log(`  DB errors:             ${stats.errors}`);

    // Save final cursor (read back the latest per-order cursor for last_ordered_at)
    const latestCursor = loadCursor();
    saveCursor({
        last_ordered_at: latestCursor?.last_ordered_at || null,
        last_order_number: latestCursor?.last_order_number || null,
        completed_at: new Date().toISOString(),
        stats: { ...stats }
    });
}

main().catch(e => { console.error(e); process.exit(1); });
