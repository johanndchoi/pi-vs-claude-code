#!/usr/bin/env node

/**
 * ShipStation V1 → Supabase Historical Shipment Sync
 * Pulls all shipments with costs, tracking, and items.
 *
 * Usage:
 *   node shipstation-shipments.mjs                      # Full import
 *   node shipstation-shipments.mjs --since 2024-01-01   # Since date
 *   node shipstation-shipments.mjs --dry-run             # Preview
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
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

const SS_KEY = process.env.SS_V1_KEY ||
    execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Key"', { encoding: 'utf8' }).trim();
const SS_SECRET = process.env.SS_V1_SECRET ||
    execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Secret"', { encoding: 'utf8' }).trim();
const SS_AUTH = 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    fetched: 0,
    created: 0, updated: 0, matched: 0, skipped: 0, errors: 0,
    total_label_spend: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Rate limiter (V1: 40 req/window, resets every ~10s) ────────────
let rateLimitRemaining = 40;

async function ssGet(path) {
    if (rateLimitRemaining <= 2) {
        log('  ⏳ Rate limit pause (11s)...');
        await sleep(11000);
        rateLimitRemaining = 40;
    }

    const res = await fetch(`https://ssapi.shipstation.com${path}`, {
        headers: { Authorization: SS_AUTH }
    });

    // Update rate limit tracking
    const remaining = res.headers.get('x-rate-limit-remaining');
    if (remaining != null) rateLimitRemaining = parseInt(remaining);

    if (res.status === 429) {
        const reset = parseInt(res.headers.get('x-rate-limit-reset') || '10');
        log(`  ⏳ 429 rate limited, waiting ${reset + 1}s...`);
        await sleep((reset + 1) * 1000);
        rateLimitRemaining = 40;
        return ssGet(path);
    }
    if (!res.ok) throw new Error(`ShipStation V1 ${res.status}: ${await res.text()}`);
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
const orderCache = {};
const shipmentByTrackingCache = {};
const shipmentBySsIdCache = {};

async function warmCaches() {
    log('Warming caches...');
    // We'll do on-demand lookups since there are too many to preload
}

async function findOrderByNumber(orderNumber) {
    if (!orderNumber) return null;
    if (orderCache[orderNumber]) return orderCache[orderNumber];
    const rows = await supaGet(`orders?order_number=eq.${encodeURIComponent(orderNumber)}&select=id&limit=1`);
    const id = rows?.[0]?.id;
    if (id) orderCache[orderNumber] = id;
    return id;
}

async function findShipmentByTracking(tn) {
    if (!tn) return null;
    if (shipmentByTrackingCache[tn]) return shipmentByTrackingCache[tn];
    const rows = await supaGet(`shipments?tracking_number=eq.${encodeURIComponent(tn)}&select=id,data_source&limit=1`);
    const row = rows?.[0];
    if (row?.id) shipmentByTrackingCache[tn] = row;
    return row || null;
}

async function findShipmentBySsId(ssId) {
    if (!ssId) return null;
    const key = String(ssId);
    if (shipmentBySsIdCache[key]) return shipmentBySsIdCache[key];
    const rows = await supaGet(`shipments?external_ids->>shipstation=eq.${key}&select=id&limit=1`);
    const id = rows?.[0]?.id;
    if (id) shipmentBySsIdCache[key] = id;
    return id;
}

// ─── Carrier mapping ─────────────────────────────────────────────────
const CARRIER_NAMES = {
    stamps_com: 'USPS (Stamps.com)', usps: 'USPS', ups: 'UPS', ups_walleted: 'UPS',
    fedex: 'FedEx', amazon_buy_shipping: 'Amazon Buy Shipping',
    dhl_express: 'DHL Express', ontrac: 'OnTrac'
};

// ─── Fetch all shipments ─────────────────────────────────────────────
async function fetchAllShipments(sinceDate) {
    let all = [], page = 1;
    const dateFilter = sinceDate ? `&createDateStart=${sinceDate}` : '';

    while (true) {
        log(`Fetching V1 shipments page ${page}...`);
        const data = await ssGet(`/shipments?pageSize=500&page=${page}&includeShipmentItems=true&sortBy=CreateDate&sortDir=DESC${dateFilter}`);
        const shipments = data.shipments || [];
        all = all.concat(shipments);

        const oldest = shipments[shipments.length - 1]?.createDate?.split('T')[0] || '?';
        log(`  Got ${shipments.length} (total: ${all.length}/${data.total}, oldest: ${oldest})`);

        if (page >= data.pages || shipments.length === 0) break;
        page++;
    }
    stats.fetched = all.length;
    return all;
}

// ─── Process one shipment ────────────────────────────────────────────
async function processShipment(ss, index, total) {
    const ssId = String(ss.shipmentId);
    const orderNumber = ss.orderNumber;
    const tracking = ss.trackingNumber;
    const cost = ss.shipmentCost ?? null;
    const carrier = ss.carrierCode || null;
    const service = ss.serviceCode || null;

    if (index % 200 === 0 || index === total - 1) {
        log(`[${index + 1}/${total}] ${orderNumber} → ${tracking || '(no tracking)'} ${carrier}/${service} $${cost ?? '?'}`);
    }

    // 1. Try to find existing shipment (from Veeqo or previous SS import)
    let existing = null;
    if (tracking) {
        existing = await findShipmentByTracking(tracking);
    }
    if (!existing) {
        const existId = await findShipmentBySsId(ssId);
        if (existId) existing = { id: existId, data_source: 'shipstation' };
    }

    // 2. If existing Veeqo shipment, enrich with ShipStation cost data
    if (existing?.data_source === 'veeqo') {
        // Only update if we have cost data to add
        if (cost != null) {
            try {
                if (!DRY_RUN) {
                    await fetch(`${SUPA_URL}/rest/v1/shipments?id=eq.${existing.id}`, {
                        method: 'PATCH',
                        headers: {
                            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            label_cost: cost,
                            insurance_cost: ss.insuranceCost || 0,
                            total_cost: +(cost + (ss.insuranceCost || 0)).toFixed(2),
                            external_ids: { veeqo: undefined, shipstation: ssId } // merge
                        })
                    });
                }
                stats.matched++;
                stats.total_label_spend += cost;
            } catch (e) {
                stats.errors++;
            }
        }
        return;
    }

    // 3. If existing ShipStation record, update it
    if (existing) {
        stats.updated++;
        return;
    }

    // 4. New shipment — find the order
    let orderId = await findOrderByNumber(orderNumber);
    if (!orderId) {
        stats.skipped++;
        return;
    }

    // 5. Build and insert
    const dims = ss.dimensions || {};
    const weightOz = ss.weight?.units === 'ounces' ? ss.weight?.value :
                     ss.weight?.units === 'pounds' ? (ss.weight?.value || 0) * 16 :
                     ss.weight?.value || null;

    const data = {
        order_id: orderId,
        label_source: 'shipstation',
        data_source: 'shipstation',
        status: ss.voided ? 'cancelled' : (tracking ? 'in_transit' : 'label_printed'),
        carrier_name: CARRIER_NAMES[carrier] || carrier,
        carrier_code: carrier,
        carrier_service: service,
        service_code: service,
        tracking_number: tracking,
        label_created_at: ss.createDate,
        shipped_at: ss.shipDate ? ss.shipDate + 'T00:00:00Z' : null,
        label_cost: cost,
        insurance_cost: ss.insuranceCost || 0,
        total_cost: cost != null ? +(cost + (ss.insuranceCost || 0)).toFixed(2) : null,
        weight_oz: weightOz,
        length_in: dims.length || null,
        width_in: dims.width || null,
        height_in: dims.height || null,
        is_voided: ss.voided || false,
        voided_at: ss.voidDate || null,
        confirmation_type: ss.confirmation || null,
        external_ids: { shipstation: ssId }
    };

    try {
        await supaUpsert('shipments', data);
        stats.created++;
        if (cost) stats.total_label_spend += cost;
    } catch (e) {
        if (e.message.includes('duplicate') || e.message.includes('23505')) {
            stats.updated++;
        } else {
            log(`  ⚠ ${ssId}: ${e.message}`);
            stats.errors++;
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting ShipStation V1 → Supabase shipment sync');
    log(`  22,207 labels, Jan 2022 → present`);
    if (DRY_RUN) log('*** DRY RUN ***');

    await warmCaches();

    let runId;
    if (!DRY_RUN) {
        try {
            const run = await supaUpsert('import_runs', {
                source: 'shipstation', job_name: 'shipstation_v1_shipments', status: 'running',
                cursor_start: sinceArg || 'full'
            });
            runId = run?.id;
        } catch {}
    }

    const shipments = await fetchAllShipments(sinceArg);
    log(`Fetched ${shipments.length} shipments from ShipStation V1`);

    for (let i = 0; i < shipments.length; i++) {
        try {
            await processShipment(shipments[i], i, shipments.length);
        } catch (e) {
            log(`  ⚠ Unexpected: ${e.message}`);
            stats.errors++;
        }
    }

    log('────────────────────────────────────');
    log('Sync complete!');
    log(`  Fetched:             ${stats.fetched}`);
    log(`  Created (new):       ${stats.created}`);
    log(`  Enriched (Veeqo):   ${stats.matched}`);
    log(`  Updated (existing):  ${stats.updated}`);
    log(`  Skipped (no order):  ${stats.skipped}`);
    log(`  Errors:              ${stats.errors}`);
    log(`  Total label spend:   $${stats.total_label_spend.toFixed(2)}`);

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
                    records_fetched: stats.fetched,
                    records_created: stats.created,
                    records_updated: stats.matched + stats.updated,
                    records_skipped: stats.skipped,
                    errors: stats.errors > 0 ? [{ count: stats.errors }] : [],
                    metadata: { total_label_spend: stats.total_label_spend }
                })
            });
        } catch {}
    }

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
