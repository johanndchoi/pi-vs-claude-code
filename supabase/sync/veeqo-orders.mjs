#!/usr/bin/env node

/**
 * Veeqo → Supabase Order Sync
 * Syncs orders, customers, addresses, shipments, and tracking.
 * 
 * Usage:
 *   node veeqo-orders.mjs                    # Incremental (since last sync)
 *   node veeqo-orders.mjs --full             # Full historical sync
 *   node veeqo-orders.mjs --since 2025-01-01 # Since specific date
 *   node veeqo-orders.mjs --dry-run          # Preview only
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildTrackingUrl } from './lib/tracking-url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FULL_SYNC = args.includes('--full');
const sinceArg = args.find((_, i) => args[i - 1] === '--since');

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

const VEEQO_KEY = process.env.VEEQO_API_KEY ||
    execSync('op item get "Veeqo API Credentials" --vault="Agents Service Accounts" --reveal --fields label=credential', { encoding: 'utf8' }).trim();
const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    orders_created: 0, orders_updated: 0,
    customers_created: 0, customers_updated: 0,
    items_created: 0, shipments_created: 0,
    tracking_events: 0, errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ─── Caches ──────────────────────────────────────────────────────────
const channelCache = {};    // veeqo_id → uuid
const warehouseCache = {};  // veeqo_id → uuid
const variantCache = {};    // sku → uuid
const costPriceCache = {};  // sku → cost_price
const customerCache = {};   // email → {id, ...}

async function warmCaches() {
    log('Warming caches...');
    const channels = await supaGet('channels?select=id,external_id');
    for (const c of channels) if (c.external_id) channelCache[c.external_id] = c.id;

    const warehouses = await supaGet('warehouses?select=id,external_id');
    for (const w of warehouses) if (w.external_id) warehouseCache[w.external_id] = w.id;

    const variants = await supaGet('product_variants?select=id,sku,cost_price');
    for (const v of variants) {
        variantCache[v.sku] = v.id;
        if (v.cost_price > 0) costPriceCache[v.sku] = +v.cost_price;
    }

    log(`  Channels: ${Object.keys(channelCache).length}, Warehouses: ${Object.keys(warehouseCache).length}, Variants: ${Object.keys(variantCache).length}`);
}

// ─── API helpers ─────────────────────────────────────────────────────
async function veeqoGet(path) {
    const res = await fetch(`https://api.veeqo.com${path}`, {
        headers: { 'x-api-key': VEEQO_KEY }
    });
    if (!res.ok) throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    return res.json();
}

async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaUpsert(table, data) {
    if (DRY_RUN) return data;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify(data)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`${table} ${res.status}: ${body?.message || body?.details || JSON.stringify(body).slice(0, 200)}`);
    return Array.isArray(body) ? body[0] : body;
}

async function supaUpdate(table, id, data) {
    if (DRY_RUN) return data;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        },
        body: JSON.stringify(data)
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`PATCH ${table} ${res.status}: ${body?.message || JSON.stringify(body).slice(0, 200)}`);
    return Array.isArray(body) ? body[0] : body;
}

// ─── Status mapping ──────────────────────────────────────────────────
function mapOrderStatus(veeqoStatus) {
    const map = {
        awaiting_payment: 'awaiting_payment',
        awaiting_fulfillment: 'awaiting_fulfillment',
        partially_fulfilled: 'partially_shipped',
        shipped: 'shipped',
        delivered: 'delivered',
        cancelled: 'cancelled',
        on_hold: 'on_hold',
        refunded: 'refunded'
    };
    return map[veeqoStatus] || 'pending';
}

function mapShipmentStatus(tracking) {
    if (!tracking) return 'created';
    if (tracking.delivered_at) return 'delivered';
    if (tracking.out_for_delivery_at) return 'out_for_delivery';
    if (tracking.in_transit_at) return 'in_transit';
    if (tracking.awaiting_collection_at) return 'awaiting_collection';
    if (tracking.cancelled_at) return 'cancelled';
    if (tracking.returned_to_sender_at) return 'returned_to_sender';
    if (tracking.attempted_delivery_at) return 'attempted_delivery';
    return 'created';
}

// ─── Process customer ────────────────────────────────────────────────
async function processCustomer(vo) {
    const cust = vo.customer;
    const deliverTo = vo.deliver_to;
    if (!cust && !deliverTo) return null;

    const email = cust?.email || deliverTo?.email || null;
    const firstName = cust?.full_name?.split(' ')[0] || deliverTo?.first_name || null;
    const lastName = cust?.full_name?.split(' ').slice(1).join(' ') || deliverTo?.last_name || null;
    const phone = cust?.phone || cust?.mobile || deliverTo?.phone || null;

    // Check cache first
    const cacheKey = email || `${firstName}_${lastName}`;
    if (customerCache[cacheKey]) return customerCache[cacheKey];

    // Check DB
    let existing = null;
    if (email) {
        const rows = await supaGet(`customers?email=eq.${encodeURIComponent(email)}&select=id&limit=1`);
        existing = rows?.[0]?.id;
    }

    const custData = {
        ...(existing ? { id: existing } : {}),
        first_name: firstName,
        last_name: lastName,
        email,
        phone,
        customer_type: cust?.customer_type || 'retail',
        channel_customer_ids: { veeqo: String(cust?.id || '') }
    };

    try {
        const result = await supaUpsert('customers', custData);
        const customerId = result?.id || existing;
        if (customerId) {
            customerCache[cacheKey] = customerId;
            existing ? stats.customers_updated++ : stats.customers_created++;
        }
        return customerId;
    } catch (e) {
        log(`  ⚠ Customer: ${e.message}`);
        stats.errors++;
        return null;
    }
}

// ─── Process address ─────────────────────────────────────────────────
async function processAddress(addr, customerId, type) {
    if (!addr || !addr.address1) return null;

    // Check if exists
    const existing = await supaGet(
        `addresses?customer_id=eq.${customerId}&address_line_1=eq.${encodeURIComponent(addr.address1)}&address_type=eq.${type}&select=id&limit=1`
    );
    const existingId = existing?.[0]?.id;

    const data = {
        ...(existingId ? { id: existingId } : {}),
        customer_id: customerId,
        address_type: type,
        first_name: addr.first_name || null,
        last_name: addr.last_name || null,
        company: addr.company || null,
        address_line_1: addr.address1,
        address_line_2: addr.address2 || null,
        city: addr.city || addr.city_locality || '',
        state: addr.state || addr.state_province || null,
        country: addr.country || addr.country_code || 'US',
        postal_code: addr.zip || addr.postal_code || '',
        phone: addr.phone || null,
        email: addr.email || null,
        is_verified: addr.verified || false,
        is_residential: addr.residential !== false
    };

    try {
        const result = await supaUpsert('addresses', data);
        return result?.id || existingId;
    } catch (e) {
        log(`  ⚠ Address: ${e.message}`);
        stats.errors++;
        return null;
    }
}

// ─── Process order ───────────────────────────────────────────────────
async function processOrder(vo, index, total) {
    const veeqoId = String(vo.id);
    const orderNum = vo.number || veeqoId;
    log(`[${index + 1}/${total}] ${orderNum} (${vo.status})`);

    // Check if exists
    const existing = await supaGet(`orders?external_ids->>veeqo=eq.${veeqoId}&select=id,status&limit=1`);
    const existingId = existing?.[0]?.id;
    const existingStatus = existing?.[0]?.status;

    // Skip if already synced and status hasn't changed (for incremental)
    // BUT always re-process if any shipment is missing a tracking number
    const newStatus = mapOrderStatus(vo.status);
    if (existingId && existingStatus === newStatus && !FULL_SYNC) {
        // Check if any shipments are missing tracking numbers
        const nullTracking = await supaGet(`shipments?order_id=eq.${existingId}&tracking_number=is.null&select=id&limit=1`);
        if (!nullTracking?.length) {
            return;
        }
        log(`  ↻ Re-processing (shipment missing tracking number)`);
    }

    // Process customer
    const customerId = await processCustomer(vo);

    // Process addresses
    let shippingAddrId = null, billingAddrId = null;
    if (customerId) {
        if (vo.deliver_to) {
            shippingAddrId = await processAddress(vo.deliver_to, customerId, 'shipping');
        }
        if (vo.billing_address) {
            billingAddrId = await processAddress(vo.billing_address, customerId, 'billing');
        }
    }

    // Resolve channel
    const channelId = channelCache[String(vo.channel?.id)] || null;
    const warehouseId = warehouseCache[String(vo.allocations?.[0]?.warehouse?.id)] || null;

    // Build order data
    const orderData = {
        ...(existingId ? { id: existingId } : {}),
        order_number: orderNum,
        channel_id: channelId,
        customer_id: customerId,
        status: newStatus,
        shipping_address_id: shippingAddrId,
        billing_address_id: billingAddrId,
        subtotal: +(vo.subtotal_price || 0),
        shipping_cost: +(vo.delivery_cost || 0),
        tax_amount: +(vo.total_tax || 0),
        discount_amount: +(vo.total_discounts || 0),
        total: +(vo.total_price || 0),
        currency_code: vo.currency_code || 'USD',
        ordered_at: vo.created_at,
        shipped_at: vo.shipped_at || null,
        cancelled_at: vo.cancelled_at || null,
        warehouse_id: warehouseId,
        delivery_method: vo.delivery_method?.name || null,
        is_prime: vo.is_amazon_prime || false,
        fulfilled_by: vo.fulfilled_by_amazon ? 'fba' : 'merchant',
        customer_notes: vo.customer_note?.text || null,
        internal_notes: vo.notes || null,
        tags: (vo.tags || []).map(t => t.name),
        data_source: 'veeqo',
        external_ids: { veeqo: veeqoId }
    };

    let orderId;
    try {
        const result = await supaUpsert('orders', orderData);
        orderId = result?.id || existingId;
        existingId ? stats.orders_updated++ : stats.orders_created++;
    } catch (e) {
        log(`  ⚠ Order ${orderNum}: ${e.message}`);
        stats.errors++;
        return;
    }

    if (!orderId) { stats.errors++; return; }

    // Process line items (only on create or full sync)
    if (!existingId || FULL_SYNC) {
        for (const li of (vo.line_items || [])) {
            await processLineItem(orderId, li);
        }
    }

    // Process shipments
    for (const alloc of (vo.allocations || [])) {
        if (alloc.shipment) {
            await processShipment(orderId, alloc, warehouseId);
        }
    }
}

// ─── Cost price lookup (from product_variants or historical order_items) ──
async function lookupCostPrice(sku) {
    if (costPriceCache[sku] !== undefined) return costPriceCache[sku];
    // Check if any previous order_item has a cost for this SKU
    const rows = await supaGet(`order_items?sku=eq.${encodeURIComponent(sku)}&cost_price=gt.0&select=cost_price&limit=1`);
    const cost = rows?.[0]?.cost_price ? +rows[0].cost_price : 0;
    costPriceCache[sku] = cost;
    return cost;
}

// ─── Process line item ───────────────────────────────────────────────
async function processLineItem(orderId, li) {
    const sku = li.sellable?.sku_code || 'UNKNOWN';
    const variantId = variantCache[sku] || null;

    const data = {
        order_id: orderId,
        variant_id: variantId,
        sku,
        title: li.title || li.sellable?.product_title || '',
        quantity: li.quantity || 1,
        unit_price: +(li.price_per_unit || 0),
        tax_rate: +(li.tax_rate || 0),
        tax_amount: +((li.price_per_unit || 0) * (li.quantity || 1) * (li.tax_rate || 0)).toFixed(2),
        discount_amount: +(li.taxless_discount_per_unit || 0) * (li.quantity || 1),
        cost_price: +(li.sellable?.cost_price || 0) || await lookupCostPrice(sku),
        remote_line_id: li.remote_id ? String(li.remote_id) : null
    };

    try {
        await supaUpsert('order_items', data);
        stats.items_created++;
    } catch (e) {
        // Might be duplicate on re-run
        if (!e.message.includes('duplicate') && !e.message.includes('23505')) {
            log(`  ⚠ Line item ${sku}: ${e.message}`);
            stats.errors++;
        }
    }
}

// ─── Process shipment ────────────────────────────────────────────────
async function processShipment(orderId, alloc, warehouseId) {
    const ship = alloc.shipment;
    if (!ship) return;

    const veeqoShipId = String(ship.id);
    const tracking = ship.tracking_number || ship.tracking || ship.trackings?.[0];
    const trackingNumber = tracking?.tracking_number || null;

    // Check if exists
    const existing = await supaGet(`shipments?external_ids->>veeqo=eq.${veeqoShipId}&select=id&limit=1`);
    const existingId = existing?.[0]?.id;

    const carrierName = ship.carrier?.name || null;
    const carrierCode = ship.carrier?.slug || ship.carrier?.provider_type || null;

    const data = {
        ...(existingId ? { id: existingId } : {}),
        order_id: orderId,
        warehouse_id: warehouseId,
        status: mapShipmentStatus(tracking),
        label_source: carrierCode === 'buy-shipping' ? 'amazon_buy_shipping' : 'veeqo',
        data_source: 'veeqo',
        carrier_name: carrierName,
        carrier_code: carrierCode,
        carrier_service: ship.service_name || ship.short_service_name || ship.carrier_service_name || null,
        service_code: ship.service_type || null,
        tracking_number: trackingNumber,
        tracking_url: buildTrackingUrl(trackingNumber, ship.carrier?.name),
        label_created_at: ship.created_at || null,
        shipped_at: ship.created_at || ship.shipped_at || null,
        delivered_at: tracking?.delivered_at || null,
        label_cost: ship.outbound_label_charges?.value ?? (ship.cost ? +ship.cost : null),
        insurance_cost: ship.insurance_charges?.value ?? null,
        total_cost: (ship.outbound_label_charges?.value ?? 0) + (ship.insurance_charges?.value ?? 0) || null,
        weight_oz: alloc.total_weight || null,
        is_voided: tracking?.cancelled || false,
        voided_at: tracking?.cancelled_at || null,
        external_ids: { veeqo: veeqoShipId }
    };

    // Package dimensions from allocation
    const pkg = alloc.allocation_package;
    if (pkg) {
        data.length_in = pkg.depth || null;
        data.width_in = pkg.width || null;
        data.height_in = pkg.height || null;
        data.package_type = pkg.package_name || null;
    }

    try {
        const result = await supaUpsert('shipments', data);
        if (!existingId) stats.shipments_created++;

        // Process tracking events if available
        const shipmentId = result?.id || existingId;
        if (shipmentId && tracking && trackingNumber) {
            await processTrackingEvents(shipmentId, tracking, trackingNumber);
        }
    } catch (e) {
        log(`  ⚠ Shipment: ${e.message}`);
        stats.errors++;
    }
}

// ─── Process tracking events ─────────────────────────────────────────
async function processTrackingEvents(shipmentId, tracking, trackingNumber) {
    // Build events from tracking timestamps
    const events = [];
    const tsFields = [
        ['created', 'Label created', tracking.created_at],
        ['awaiting_collection', 'Awaiting collection', tracking.awaiting_collection_at],
        ['in_transit', 'In transit', tracking.in_transit_at],
        ['out_for_delivery', 'Out for delivery', tracking.out_for_delivery_at],
        ['delivered', 'Delivered', tracking.delivered_at],
        ['attempted_delivery', 'Delivery attempted', tracking.attempted_delivery_at],
        ['returned_to_sender', 'Returned to sender', tracking.returned_to_sender_at],
        ['cancelled', 'Cancelled', tracking.cancelled_at]
    ];

    for (const [status, desc, ts] of tsFields) {
        if (ts) {
            events.push({
                shipment_id: shipmentId,
                tracking_number: trackingNumber,
                status,
                description: desc,
                occurred_at: ts
            });
        }
    }

    for (const ev of events) {
        try {
            // Check if event exists (avoid dupes)
            const existing = await supaGet(
                `tracking_events?shipment_id=eq.${shipmentId}&status=eq.${ev.status}&select=id&limit=1`
            );
            if (existing?.length > 0) continue;

            await supaUpsert('tracking_events', ev);
            stats.tracking_events++;
        } catch (e) {
            // Silently skip dupes
        }
    }
}

// ─── Fetch orders ────────────────────────────────────────────────────
async function fetchOrders(sinceDate) {
    let all = [], page = 1;
    const params = sinceDate ? `&created_at_min=${sinceDate}` : '';

    while (true) {
        log(`Fetching orders page ${page}...`);
        const batch = await veeqoGet(`/orders?page_size=100&page=${page}${params}`);
        all = all.concat(batch);

        const oldest = batch[batch.length - 1]?.created_at?.split('T')[0] || '?';
        log(`  Got ${batch.length} (total: ${all.length}, oldest on page: ${oldest})`);

        if (batch.length < 100) break;
        page++;

        // Rate limiting: small delay every 10 pages
        if (page % 10 === 0) {
            log('  (brief pause for rate limiting)');
            await new Promise(r => setTimeout(r, 1000));
        }
    }
    return all;
}

// ─── Get sync cursor ─────────────────────────────────────────────────
async function getLastSyncDate() {
    const rows = await supaGet('sync_cursors?source=eq.veeqo_orders&select=cursor_value&limit=1');
    return rows?.[0]?.cursor_value || null;
}

async function updateSyncCursor(cursorValue) {
    if (DRY_RUN) return;
    // Check if cursor exists, then update or insert
    const existing = await supaGet('sync_cursors?source=eq.veeqo_orders&select=id&limit=1');
    const data = {
        source: 'veeqo_orders',
        cursor_value: cursorValue,
        last_synced_at: new Date().toISOString(),
        records_synced: stats.orders_created + stats.orders_updated
    };
    if (existing?.[0]?.id) {
        await supaUpdate('sync_cursors', existing[0].id, data);
    } else {
        await supaUpsert('sync_cursors', data);
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting Veeqo → Supabase order sync');
    if (DRY_RUN) log('*** DRY RUN ***');

    await warmCaches();

    // Determine date range
    let sinceDate = null;
    if (FULL_SYNC) {
        log('Full sync requested — fetching ALL orders');
    } else if (sinceArg) {
        sinceDate = sinceArg;
        log(`Syncing since ${sinceDate}`);
    } else {
        sinceDate = await getLastSyncDate();
        if (sinceDate) {
            log(`Incremental sync since ${sinceDate}`);
        } else {
            log('No previous sync found — fetching ALL orders');
        }
    }

    // Record import run
    let runId;
    if (!DRY_RUN) {
        try {
            const run = await supaUpsert('import_runs', {
                source: 'veeqo', job_name: 'veeqo_orders_sync', status: 'running',
                cursor_start: sinceDate || 'full'
            });
            runId = run?.id;
        } catch {}
    }

    // Fetch
    const orders = await fetchOrders(sinceDate);
    log(`Fetched ${orders.length} orders`);

    // Process
    for (let i = 0; i < orders.length; i++) {
        try {
            await processOrder(orders[i], i, orders.length);
        } catch (e) {
            log(`  ⚠ Unexpected: ${e.message}`);
            stats.errors++;
        }
    }

    // Update cursor to now
    if (!DRY_RUN && orders.length > 0) {
        await updateSyncCursor(new Date().toISOString());
    }

    // Summary
    log('────────────────────────────────────');
    log('Sync complete!');
    log(`  Orders created:    ${stats.orders_created}`);
    log(`  Orders updated:    ${stats.orders_updated}`);
    log(`  Customers created: ${stats.customers_created}`);
    log(`  Customers updated: ${stats.customers_updated}`);
    log(`  Line items:        ${stats.items_created}`);
    log(`  Shipments:         ${stats.shipments_created}`);
    log(`  Tracking events:   ${stats.tracking_events}`);
    log(`  Errors:            ${stats.errors}`);

    // Update import run
    if (runId && !DRY_RUN) {
        try {
            await fetch(`${SUPA_URL}/rest/v1/import_runs?id=eq.${runId}`, {
                method: 'PATCH',
                headers: {
                    apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    status: stats.errors > 0 ? 'partial' : 'completed',
                    completed_at: new Date().toISOString(),
                    records_fetched: orders.length,
                    records_created: stats.orders_created,
                    records_updated: stats.orders_updated,
                    cursor_end: new Date().toISOString(),
                    errors: stats.errors > 0 ? [{ count: stats.errors }] : []
                })
            });
        } catch {}
    }

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
