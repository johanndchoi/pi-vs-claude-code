#!/usr/bin/env node

/**
 * Amazon SP-API → Supabase Order Enrichment
 * Fills in tax_amount, shipping_cost, discount_amount, total from Amazon SP-API
 * since Veeqo doesn't pass these through for Amazon orders.
 *
 * Usage:
 *   node amazon-enrich.mjs                  # Enrich orders with tax=0
 *   node amazon-enrich.mjs --all            # Re-enrich all Amazon orders
 *   node amazon-enrich.mjs --since 2026-01  # Only orders after date
 *   node amazon-enrich.mjs --dry-run        # Preview without writing
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const ALL = args.includes('--all');
const SINCE = args.find((_, i) => args[i - 1] === '--since');

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

// Amazon SP-API credentials from 1Password
const LWA_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials"', { encoding: 'utf8' }).trim();
const LWA_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret"', { encoding: 'utf8' }).trim();
const REFRESH_TOKEN = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken"', { encoding: 'utf8' }).trim();

const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';

const stats = { checked: 0, enriched: 0, items_updated: 0, skipped: 0, api_errors: 0, errors: 0 };
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

// ─── SP-API Helper ───────────────────────────────────────────────────
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

// ─── Supabase Helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
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

// ─── Enrich a single order ───────────────────────────────────────────
async function enrichOrder(order) {
    const orderNum = order.order_number;

    // Get order-level data from SP-API
    const orderData = await spApiGet(`/orders/v0/orders/${orderNum}`);
    if (!orderData?.payload) {
        stats.api_errors++;
        return;
    }
    const amzOrder = orderData.payload;

    // Get order items for tax/shipping/discount breakdown
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

    const orderTotal = +(amzOrder.OrderTotal?.Amount || 0);

    // Update order
    const orderPatch = {};
    if (totalTax > 0) orderPatch.tax_amount = +totalTax.toFixed(2);
    if (totalShipping > 0) orderPatch.shipping_cost = +totalShipping.toFixed(2);
    if (totalDiscount > 0) orderPatch.discount_amount = +(totalDiscount + totalShippingDiscount).toFixed(2);
    if (orderTotal > 0) orderPatch.total = orderTotal;

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
            // Match by ASIN or SKU
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
const CURSOR_FILE = join(__dirname, '..', '.locks', 'amazon-enrich.cursor');

function loadCursor() {
    try { return readFileSync(CURSOR_FILE, 'utf8').trim(); } catch { return null; }
}

function saveCursor(ts) {
    mkdirSync(dirname(CURSOR_FILE), { recursive: true });
    writeFileSync(CURSOR_FILE, ts);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Amazon SP-API order enrichment starting');
    if (DRY_RUN) log('*** DRY RUN ***');

    // Build query for Amazon orders needing enrichment
    // Always targets tax_amount=0 (unenriched) — this means old orders get retried
    // until all are enriched. Once caught up, only new orders will have tax=0.
    let filter = `channel_id=eq.${AMAZON_CHANNEL_ID}`;
    if (!ALL) filter += '&tax_amount=eq.0';
    if (SINCE) filter += `&ordered_at=gte.${SINCE}`;

    // Check how many need enrichment
    const countRes = await fetch(`${SUPA_URL}/rest/v1/orders?${filter}&select=id`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Prefer: 'count=exact' }
    });
    const remaining = parseInt(countRes.headers.get('content-range')?.split('/')[1] || '0');
    log(`  ${remaining} orders need enrichment`);

    let offset = 0;
    let totalOrders = 0;

    while (true) {
        const orders = await supaGet(
            `orders?${filter}&select=id,order_number,tax_amount,shipping_cost,total,order_items(id,sku,metadata)&limit=100&offset=${offset}&order=ordered_at.desc`
        );
        if (!orders.length) break;
        totalOrders += orders.length;

        for (let i = 0; i < orders.length; i++) {
            stats.checked++;

            try {
                await enrichOrder(orders[i]);
            } catch (e) {
                log(`  ⚠ ${orders[i].order_number}: ${e.message}`);
                stats.errors++;
            }

            // SP-API rate limit: ~1 req/sec for getOrder, ~0.5 req/sec for getOrderItems
            // We make 2 calls per order, so wait 2-3s between orders
            await sleep(2500);

            if (stats.checked % 50 === 0) {
                log(`  [${stats.checked}] Enriched: ${stats.enriched}, Items: ${stats.items_updated}, Errors: ${stats.api_errors + stats.errors}`);
            }
        }

        offset += orders.length;
    }

    log('────────────────────────────────────');
    log(`Done! Checked ${stats.checked} Amazon orders:`);
    log(`  Enriched:      ${stats.enriched}`);
    log(`  Items updated: ${stats.items_updated}`);
    log(`  Skipped:       ${stats.skipped} (no tax/shipping data from Amazon either)`);
    log(`  API errors:    ${stats.api_errors}`);
    log(`  DB errors:     ${stats.errors}`);

}

main().catch(e => { console.error(e); process.exit(1); });
