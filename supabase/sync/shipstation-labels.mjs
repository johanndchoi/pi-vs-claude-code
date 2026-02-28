#!/usr/bin/env node

/**
 * ShipStation → Supabase Historical Label/Shipment Sync
 * Pulls labels (with costs) and enriches with shipment data (items, addresses).
 * Uses ShipStation V2 API.
 *
 * Usage:
 *   node shipstation-labels.mjs                     # Full import
 *   node shipstation-labels.mjs --since 2024-01-01  # Since date
 *   node shipstation-labels.mjs --dry-run            # Preview
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
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

const SS_KEY = process.env.SHIPSTATION_API_KEY;
if (!SS_KEY) { console.error('Missing SHIPSTATION_API_KEY'); process.exit(1); }
const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Stats & rate limiting ──────────────────────────────────────────
const stats = {
    labels_fetched: 0, shipments_fetched: 0,
    shipments_created: 0, shipments_updated: 0,
    shipments_matched: 0, // matched to existing Veeqo shipments
    errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ShipStation rate limit: 40 requests per 60 seconds (V2)
let requestCount = 0;
let windowStart = Date.now();

async function rateLimitedFetch(url, opts) {
    requestCount++;
    const elapsed = Date.now() - windowStart;
    if (requestCount >= 35 && elapsed < 60000) {
        const waitMs = 60000 - elapsed + 1000;
        log(`  ⏳ Rate limit pause (${Math.ceil(waitMs / 1000)}s)...`);
        await sleep(waitMs);
        requestCount = 0;
        windowStart = Date.now();
    }
    if (elapsed >= 60000) {
        requestCount = 1;
        windowStart = Date.now();
    }
    return fetch(url, opts);
}

// ─── API helpers ─────────────────────────────────────────────────────
async function ssGet(path) {
    const res = await rateLimitedFetch(`https://api.shipstation.com/v2${path}`, {
        headers: { 'api-key': SS_KEY }
    });
    if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after') || 60;
        log(`  ⏳ 429 rate limited, waiting ${retryAfter}s...`);
        await sleep(retryAfter * 1000);
        return ssGet(path);
    }
    if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
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

// ─── Caches ──────────────────────────────────────────────────────────
const warehouseCache = {};
const orderCache = {};      // order_number → order uuid
const shipmentCache = {};   // tracking_number → shipment uuid

async function warmCaches() {
    log('Warming caches...');
    const warehouses = await supaGet('warehouses?select=id,external_id,name');
    for (const w of warehouses) if (w.external_id) warehouseCache[w.external_id] = w.id;

    // We can't load all 26k orders into cache. We'll look up on demand.
    log(`  Warehouses: ${Object.keys(warehouseCache).length}`);
}

async function findOrderByNumber(orderNumber) {
    if (!orderNumber) return null;
    if (orderCache[orderNumber]) return orderCache[orderNumber];

    const rows = await supaGet(`orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=id&limit=1`);
    const id = rows?.[0]?.id;
    if (id) orderCache[orderNumber] = id;
    return id;
}

async function findShipmentByTracking(trackingNumber) {
    if (!trackingNumber) return null;
    if (shipmentCache[trackingNumber]) return shipmentCache[trackingNumber];

    const rows = await supaGet(`shipments?tracking_number=eq.${encodeURIComponent(trackingNumber)}&select=id&limit=1`);
    const id = rows?.[0]?.id;
    if (id) shipmentCache[trackingNumber] = id;
    return id;
}

// ─── Fetch all labels (with costs) ───────────────────────────────────
async function fetchAllLabels(sinceDate) {
    let all = [], page = 1;
    const dateFilter = sinceDate ? `&created_at_start=${sinceDate}T00:00:00Z` : '';

    while (true) {
        log(`Fetching labels page ${page}...`);
        const data = await ssGet(`/labels?limit=25&page=${page}&sort_dir=desc${dateFilter}`);
        const labels = data.labels || [];
        all = all.concat(labels);

        const oldest = labels[labels.length - 1]?.created_at?.split('T')[0] || '?';
        log(`  Got ${labels.length} (total: ${all.length}/${data.total}, oldest: ${oldest})`);
        stats.labels_fetched = all.length;

        if (page >= data.pages || labels.length === 0) break;
        page++;
    }
    return all;
}

// ─── Build label lookup by shipment_id ───────────────────────────────
function buildLabelIndex(labels) {
    const index = {};
    for (const l of labels) {
        if (l.shipment_id) {
            if (!index[l.shipment_id]) index[l.shipment_id] = [];
            index[l.shipment_id].push(l);
        }
    }
    return index;
}

// ─── Fetch shipments (with order numbers + items) ────────────────────
async function fetchShipments(status, sinceDate) {
    let all = [], page = 1;
    const dateFilter = sinceDate ? `&created_at_start=${sinceDate}T00:00:00Z` : '';

    while (true) {
        log(`Fetching ${status} shipments page ${page}...`);
        const data = await ssGet(`/shipments?limit=25&page=${page}&shipment_status=${status}&include_shipment_items=true&sort_dir=desc${dateFilter}`);
        const shipments = data.shipments || [];
        all = all.concat(shipments);

        const oldest = shipments[shipments.length - 1]?.created_at?.split('T')[0] || '?';
        log(`  Got ${shipments.length} (total: ${all.length}/${data.total}, oldest: ${oldest})`);
        stats.shipments_fetched = all.length;

        if (page >= data.pages || shipments.length === 0) break;
        page++;
    }
    return all;
}

// (shipment details are fetched in bulk via fetchShipments)

// ─── Carrier name mapping ────────────────────────────────────────────
const CARRIER_NAMES = {
    'stamps_com': 'USPS', 'usps': 'USPS', 'ups': 'UPS', 'fedex': 'FedEx',
    'ups_walleted': 'UPS', 'amazon_shipping_us': 'Amazon Shipping',
    'amazon_buy_shipping': 'Amazon Buy Shipping', 'dhl_express': 'DHL Express'
};

// ─── Process a shipment (enriched with label cost) ───────────────────
async function processShipment(ship, label, index, total) {
    const ssShipmentId = ship.shipment_id;
    const orderNumber = ship.shipment_number || ship.external_shipment_id;
    const trackingNumber = label?.tracking_number || ship.packages?.[0]?.tracking_number || null;

    // Label cost info
    const carrierCode = label?.carrier_code || ship.carrier_id || null;
    const serviceCode = label?.service_code || ship.service_code || null;
    const labelCost = label?.shipment_cost?.amount ?? null;
    const insuranceCost = label?.insurance_cost?.amount ?? null;
    const isVoided = label?.voided || false;

    if (index % 100 === 0 || index === total - 1) {
        log(`[${index + 1}/${total}] ${orderNumber || ssShipmentId} → ${trackingNumber || '(no tracking)'} $${labelCost ?? '?'}`);
    }

    // Match to existing order by order number
    let orderId = null;
    if (orderNumber) {
        orderId = await findOrderByNumber(orderNumber);
    }
    // Also try external_shipment_id and external_order_id
    if (!orderId && ship.external_shipment_id) {
        orderId = await findOrderByNumber(ship.external_shipment_id);
    }

    // Check if shipment already exists in our DB
    let existingShipmentId = null;
    if (trackingNumber) {
        existingShipmentId = await findShipmentByTracking(trackingNumber);
    }
    if (!existingShipmentId) {
        const rows = await supaGet(`shipments?external_ids->>shipstation=eq.${encodeURIComponent(label?.label_id || ssShipmentId)}&select=id&limit=1`);
        existingShipmentId = rows?.[0]?.id;
    }

    // If no order match and no existing shipment, skip
    if (!orderId && !existingShipmentId) return 'skipped';

    const carrierName = CARRIER_NAMES[carrierCode] || carrierCode || null;
    const pkg = label?.packages?.[0] || ship.packages?.[0] || {};

    const data = {
        ...(existingShipmentId ? { id: existingShipmentId } : {}),
        ...(orderId && !existingShipmentId ? { order_id: orderId } : {}),
        label_source: 'shipstation',
        data_source: 'shipstation',
        status: isVoided ? 'cancelled' : (trackingNumber ? 'shipped' : 'label_printed'),
        carrier_name: carrierName,
        carrier_code: carrierCode,
        carrier_service: serviceCode,
        service_code: serviceCode,
        tracking_number: trackingNumber,
        label_created_at: label?.created_at || ship.created_at,
        shipped_at: label?.ship_date || ship.ship_date || null,
        label_cost: labelCost,
        insurance_cost: insuranceCost,
        total_cost: labelCost != null ? +(labelCost + (insuranceCost || 0)).toFixed(2) : null,
        retail_rate: ship.retail_rate?.amount || null,
        savings: (ship.retail_rate?.amount && labelCost)
            ? +(ship.retail_rate.amount - labelCost).toFixed(2) : null,
        weight_oz: pkg.weight?.value || ship.total_weight?.value || null,
        length_in: pkg.dimensions?.length || null,
        width_in: pkg.dimensions?.width || null,
        height_in: pkg.dimensions?.height || null,
        zone: ship.zone || null,
        is_voided: isVoided,
        voided_at: label?.voided_at || null,
        confirmation_type: ship.confirmation || null,
        external_ids: {
            shipstation: label?.label_id || ssShipmentId,
            shipstation_shipment: ssShipmentId
        }
    };

    // If enriching an existing Veeqo shipment, only add ShipStation-specific fields
    if (existingShipmentId && !labelCost) return 'skipped';

    try {
        await supaUpsert('shipments', data);
        if (existingShipmentId) {
            stats.shipments_matched++;
        } else {
            stats.shipments_created++;
        }
        return 'ok';
    } catch (e) {
        if (e.message.includes('duplicate') || e.message.includes('23505')) {
            stats.shipments_updated++;
            return 'ok';
        }
        log(`  ⚠ ${ssShipmentId}: ${e.message}`);
        stats.errors++;
        return 'error';
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting ShipStation → Supabase label import (V2 API)');
    if (DRY_RUN) log('*** DRY RUN ***');

    await warmCaches();

    // Record import run
    let runId;
    if (!DRY_RUN) {
        try {
            const run = await supaUpsert('import_runs', {
                source: 'shipstation', job_name: 'shipstation_labels_import', status: 'running',
                cursor_start: sinceArg || 'full'
            });
            runId = run?.id;
        } catch {}
    }

    // Step 1: Fetch all labels (has cost data)
    const labels = await fetchAllLabels(sinceArg);
    log(`Fetched ${labels.length} labels from ShipStation`);
    const labelIndex = buildLabelIndex(labels);

    // Step 2: Fetch shipped shipments (has order numbers + items)
    const shipments = await fetchShipments('label_purchased', sinceArg);
    log(`Fetched ${shipments.length} shipped shipments from ShipStation`);

    // Step 3: Process each shipment, enriched with label cost
    let skipped = 0;
    for (let i = 0; i < shipments.length; i++) {
        try {
            const ship = shipments[i];
            const matchingLabels = labelIndex[ship.shipment_id] || [];
            const label = matchingLabels[0] || null; // Use first label (most common)
            const result = await processShipment(ship, label, i, shipments.length);
            if (result === 'skipped') skipped++;
        } catch (e) {
            log(`  ⚠ Unexpected: ${e.message}`);
            stats.errors++;
        }
    }

    // Summary
    log('────────────────────────────────────');
    log('Import complete!');
    log(`  Labels fetched:      ${stats.labels_fetched}`);
    log(`  Shipments enriched:  ${stats.shipments_matched} (matched Veeqo records)`);
    log(`  Shipments created:   ${stats.shipments_created} (new from ShipStation)`);
    log(`  Shipments skipped:   ${skipped} (no matching order)`);
    log(`  Errors:              ${stats.errors}`);

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
                    records_fetched: stats.labels_fetched,
                    records_created: stats.shipments_created,
                    records_updated: stats.shipments_matched,
                    records_skipped: skipped,
                    errors: stats.errors > 0 ? [{ count: stats.errors }] : []
                })
            });
        } catch {}
    }

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
