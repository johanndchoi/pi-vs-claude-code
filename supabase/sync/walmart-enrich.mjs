#!/usr/bin/env node

/**
 * Walmart Order Enrichment → Supabase
 * Enriches existing Veeqo-synced Walmart orders with:
 *   - purchaseOrderId (Walmart PO ID) → external_ids.walmart
 *   - Total tax (order-level)
 *   - Shipping program type (TWO_DAY, etc.)
 *   - Delivery status (Delivered vs Shipped)
 *   - Estimated delivery/ship dates
 *   - Refund/promotion details
 *   - Line-level tax amounts
 *
 * Usage:
 *   node walmart-enrich.mjs                      # Enrich all Walmart orders
 *   node walmart-enrich.mjs --since 2025-10-01   # Since date
 *   node walmart-enrich.mjs --dry-run             # Preview
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const sinceArg = args.find((_, i) => args[i - 1] === '--since') || '2025-01-01';

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

// Walmart creds from 1Password
const WM_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/username"', { encoding: 'utf8' }).trim();
const WM_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/credential"', { encoding: 'utf8' }).trim();

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    wm_orders_fetched: 0,
    orders_enriched: 0,
    orders_not_found: 0,
    items_enriched: 0,
    refunds_found: 0,
    errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Walmart API ─────────────────────────────────────────────────────
let wmToken = null;
let wmTokenExpiry = 0;

async function wmAuth() {
    if (wmToken && Date.now() < wmTokenExpiry) return wmToken;

    const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `enrich-${Date.now()}`,
            Authorization: 'Basic ' + Buffer.from(`${WM_CLIENT_ID}:${WM_CLIENT_SECRET}`).toString('base64'),
            Accept: 'application/json'
        },
        body: 'grant_type=client_credentials'
    });

    if (!res.ok) throw new Error(`Walmart auth failed: ${res.status}`);
    const data = await res.json();
    wmToken = data.access_token;
    wmTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return wmToken;
}

async function wmGet(path) {
    const token = await wmAuth();
    const res = await fetch(`https://marketplace.walmartapis.com/v3${path}`, {
        headers: {
            'WM_SEC.ACCESS_TOKEN': token,
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `enrich-${Date.now()}`,
            Accept: 'application/json'
        }
    });

    if (res.status === 429) {
        log('  ⏳ Walmart rate limited, waiting 30s...');
        await sleep(30000);
        return wmGet(path);
    }
    if (!res.ok) throw new Error(`Walmart ${res.status}: ${await res.text()}`);
    return res.json();
}

async function fetchAllWalmartOrders(sinceDate) {
    let all = [];

    // Walmart API needs date windows for full pagination
    // Break into quarterly windows from sinceDate to now
    const start = new Date(sinceDate + 'T00:00:00Z');
    const now = new Date();
    const windows = [];

    let windowStart = new Date(start);
    while (windowStart < now) {
        let windowEnd = new Date(windowStart);
        windowEnd.setMonth(windowEnd.getMonth() + 3); // 3-month windows
        if (windowEnd > now) windowEnd = now;
        windows.push({
            start: windowStart.toISOString().split('.')[0] + 'Z',
            end: windowEnd.toISOString().split('.')[0] + 'Z'
        });
        windowStart = new Date(windowEnd);
    }

    const seen = new Set();

    for (const win of windows) {
        let cursor = null;
        let page = 0;
        const expectedTotal = null;
        log(`Window: ${win.start.split('T')[0]} → ${win.end.split('T')[0]}`);

        while (true) {
            page++;
            let query = `createdStartDate=${win.start}&createdEndDate=${win.end}&limit=200`;
            if (cursor) query += `&nextCursor=${encodeURIComponent(cursor)}`;

            const data = await wmGet(`/orders?${query}`);
            const orders = data?.list?.elements?.order || [];
            const meta = data?.list?.meta || {};
            const windowTotal = meta.totalCount || 0;

            // Deduplicate
            let added = 0;
            for (const o of orders) {
                const key = o.purchaseOrderId;
                if (!seen.has(key)) {
                    seen.add(key);
                    all.push(o);
                    added++;
                }
            }

            log(`  Page ${page}: ${orders.length} fetched, ${added} new (window: ${windowTotal}, total: ${all.length})`);

            // Stop if: no new orders (cursor is recycling), or no cursor
            cursor = meta.nextCursor;
            if (!cursor || orders.length === 0 || added === 0) break;

            // Safety: don't exceed 2x expected total for this window
            if (page > Math.ceil(windowTotal / 200) + 2) {
                log(`  ⚠ Safety cap: ${page} pages exceeds expected ${Math.ceil(windowTotal / 200)}`);
                break;
            }
            await sleep(500);
        }
    }

    stats.wm_orders_fetched = all.length;
    return all;
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
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

// ─── Enrich one order ────────────────────────────────────────────────
async function enrichOrder(wmOrder, index, total) {
    const customerOrderId = wmOrder.customerOrderId;
    const purchaseOrderId = wmOrder.purchaseOrderId;

    if (index % 50 === 0 || index === total - 1) {
        log(`[${index + 1}/${total}] ${customerOrderId} (PO: ${purchaseOrderId})`);
    }

    // Find in Supabase by order_number (= customerOrderId)
    const rows = await supaGet(`orders?order_number=eq.${encodeURIComponent(customerOrderId)}&select=id,external_ids,tags,tax_amount`);
    if (!rows?.length || rows?.code) {
        stats.orders_not_found++;
        return;
    }

    const order = rows[0];
    const orderId = order.id;
    const existingExtIds = order.external_ids || {};
    const existingTags = order.tags || [];

    // Extract enrichment data from Walmart order
    const orderLines = wmOrder.orderLines?.orderLine || [];

    // Calculate total tax across all lines
    let totalTax = 0;
    let totalRefunds = 0;
    const lineDetails = [];

    for (const line of orderLines) {
        const charges = line.charges?.charge || [];
        for (const charge of charges) {
            if (charge.chargeType === 'PRODUCT') {
                const tax = charge.tax?.taxAmount?.amount || 0;
                totalTax += tax;
            }
        }

        // Check for refunds
        const refundCharges = line.refund?.refundCharges?.refundCharge || [];
        for (const rc of refundCharges) {
            const amt = rc.charge?.chargeAmount?.amount || 0;
            totalRefunds += amt; // Negative values
            stats.refunds_found++;
        }

        // Line status for delivery detection
        const statuses = line.orderLineStatuses?.orderLineStatus || [];
        const latestStatus = statuses[0]?.status || null;

        lineDetails.push({
            lineNumber: line.lineNumber,
            sku: line.item?.sku,
            status: latestStatus,
            shippingProgramType: line.fulfillment?.shippingProgramType || null,
            shipMethod: line.fulfillment?.shipMethod || null,
            trackingNumber: statuses[0]?.trackingInfo?.trackingNumber || null,
            carrier: statuses[0]?.trackingInfo?.carrierName?.carrier || null
        });
    }

    // Determine overall Walmart status
    const wmStatuses = lineDetails.map(l => l.status).filter(Boolean);
    const isDelivered = wmStatuses.every(s => s === 'Delivered');
    const isCancelled = wmStatuses.every(s => s === 'Cancelled');

    // Map to our status enum
    let enrichedStatus = null;
    if (isDelivered) enrichedStatus = 'delivered';
    else if (isCancelled) enrichedStatus = 'cancelled';

    // Shipping program info
    const shippingPrograms = [...new Set(lineDetails.map(l => l.shippingProgramType).filter(Boolean))];
    const shipMethods = [...new Set(lineDetails.map(l => l.shipMethod).filter(Boolean))];

    // Estimated dates
    const estDelivery = wmOrder.shippingInfo?.estimatedDeliveryDate
        ? new Date(wmOrder.shippingInfo.estimatedDeliveryDate).toISOString()
        : null;
    const estShip = wmOrder.shippingInfo?.estimatedShipDate
        ? new Date(wmOrder.shippingInfo.estimatedShipDate).toISOString()
        : null;

    // Build update
    const wmMeta = {
        shipping_program: shippingPrograms.join(', ') || null,
        ship_method: shipMethods.join(', ') || null,
        estimated_delivery: estDelivery,
        estimated_ship: estShip,
        customer_email_relay: wmOrder.customerEmailId || null,
        ship_node: wmOrder.shipNode?.name || null,
        line_details: lineDetails
    };

    // Add shipping program as a tag
    const newTags = [...existingTags];
    for (const prog of shippingPrograms) {
        if (prog && !newTags.includes(`wm:${prog}`)) newTags.push(`wm:${prog}`);
    }

    const updates = {
        external_ids: {
            ...existingExtIds,
            walmart: purchaseOrderId,
            walmart_meta: wmMeta
        },
        tax_amount: +totalTax.toFixed(2) || order.tax_amount,
        tags: newTags.length > existingTags.length ? newTags : undefined
    };

    // Add discount if refunds exist
    if (totalRefunds !== 0) {
        updates.discount_amount = +Math.abs(totalRefunds).toFixed(2);
    }

    // Update status if we have better info
    if (enrichedStatus) {
        updates.status = enrichedStatus;
    }

    // Remove undefined fields
    Object.keys(updates).forEach(k => updates[k] === undefined && delete updates[k]);

    try {
        await supaPatch('orders', `id=eq.${orderId}`, updates);
        stats.orders_enriched++;
    } catch (e) {
        log(`  ⚠ ${customerOrderId}: ${e.message}`);
        stats.errors++;
    }

    // Enrich order items with Walmart line-level data
    for (const line of orderLines) {
        const sku = line.item?.sku;
        const lineNumber = line.lineNumber;
        if (!sku) continue;

        const charges = line.charges?.charge || [];
        let itemTax = 0;
        for (const charge of charges) {
            if (charge.chargeType === 'PRODUCT') {
                itemTax += charge.tax?.taxAmount?.amount || 0;
            }
        }

        try {
            // Match by order_id + remote_line_id (which is the lineNumber)
            const items = await supaGet(
                `order_items?order_id=eq.${orderId}&remote_line_id=eq.${lineNumber}&select=id,tax_amount`
            );
            if (items?.length) {
                const item = items[0];
                if (!item.tax_amount || item.tax_amount === 0) {
                    await supaPatch('order_items', `id=eq.${item.id}`, {
                        tax_amount: +itemTax.toFixed(2)
                    });
                    stats.items_enriched++;
                }
            }
        } catch (e) {
            // Non-critical
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting Walmart order enrichment');
    log(`  Since: ${sinceArg}`);
    if (DRY_RUN) log('*** DRY RUN ***');

    // Fetch all Walmart orders
    const wmOrders = await fetchAllWalmartOrders(sinceArg);
    log(`Fetched ${wmOrders.length} orders from Walmart API`);

    // Process each
    for (let i = 0; i < wmOrders.length; i++) {
        try {
            await enrichOrder(wmOrders[i], i, wmOrders.length);
        } catch (e) {
            log(`  ⚠ Unexpected: ${e.message}`);
            stats.errors++;
        }
    }

    log('────────────────────────────────────');
    log('Enrichment complete!');
    log(`  Walmart orders fetched: ${stats.wm_orders_fetched}`);
    log(`  Orders enriched:       ${stats.orders_enriched}`);
    log(`  Orders not in DB:      ${stats.orders_not_found}`);
    log(`  Items tax-enriched:    ${stats.items_enriched}`);
    log(`  Refunds/promos found:  ${stats.refunds_found}`);
    log(`  Errors:                ${stats.errors}`);

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
