#!/usr/bin/env node

/**
 * Cross-validate Shipments: Veeqo (Supabase) ↔ ShipStation
 *
 * Finds shipments missing label_cost or tracking_number, then looks up
 * the matching ShipStation shipment by order_number and enriches them.
 *
 * Usage:
 *   node crossvalidate-shipments.mjs              # Run enrichment
 *   node crossvalidate-shipments.mjs --dry-run     # Preview only
 *   node crossvalidate-shipments.mjs --reset       # Clear cursor, start over
 *   node crossvalidate-shipments.mjs --limit 100   # Process N shipments max
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESET = args.includes('--reset');
const limitArg = args.find((_, i) => args[i - 1] === '--limit');
const BATCH_LIMIT = limitArg ? parseInt(limitArg) : null;

const CURSOR_DIR = join(__dirname, '..', '.locks');
const CURSOR_FILE = join(CURSOR_DIR, 'crossvalidate-shipments.cursor');

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

function getSSCredentials() {
    const key = process.env.SS_V1_KEY ||
        execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Key"', { encoding: 'utf8' }).trim();
    const secret = process.env.SS_V1_SECRET ||
        execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Secret"', { encoding: 'utf8' }).trim();
    return 'Basic ' + Buffer.from(`${key}:${secret}`).toString('base64');
}

const SS_AUTH = getSSCredentials();
const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Helpers ─────────────────────────────────────────────────────────
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const stats = {
    queried: 0,
    matched: 0,
    updated: 0,
    not_found: 0,
    already_complete: 0,
    errors: 0,
    ss_requests: 0,
};

// ─── Cursor ──────────────────────────────────────────────────────────
function loadCursor() {
    if (RESET) return null;
    try {
        const data = JSON.parse(readFileSync(CURSOR_FILE, 'utf8'));
        return data;
    } catch { return null; }
}

function saveCursor(cursor) {
    if (DRY_RUN) return;
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify({
        ...cursor,
        updated_at: new Date().toISOString(),
    }, null, 2));
}

// ─── ShipStation rate-limited GET ────────────────────────────────────
let rateLimitRemaining = 40;

async function ssGet(path) {
    if (rateLimitRemaining <= 2) {
        log('  ⏳ Rate limit pause (11s)...');
        await sleep(11000);
        rateLimitRemaining = 40;
    }

    stats.ss_requests++;
    const res = await fetch(`https://ssapi.shipstation.com${path}`, {
        headers: { Authorization: SS_AUTH },
    });

    const remaining = res.headers.get('x-rate-limit-remaining');
    if (remaining != null) rateLimitRemaining = parseInt(remaining);

    if (res.status === 429) {
        const reset = parseInt(res.headers.get('x-rate-limit-reset') || '10');
        log(`  ⏳ 429 rate limited, waiting ${reset + 1}s...`);
        await sleep((reset + 1) * 1000);
        rateLimitRemaining = 40;
        return ssGet(path);
    }
    if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Supabase helpers ────────────────────────────────────────────────
const supaHeaders = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
};

async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, { headers: supaHeaders });
    if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
    return res.json();
}

async function supaPatch(table, id, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...supaHeaders, Prefer: 'return=minimal' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Supabase PATCH ${res.status}: ${await res.text()}`);
}

// ─── Carrier mapping ────────────────────────────────────────────────
const CARRIER_NAMES = {
    stamps_com: 'USPS (Stamps.com)', usps: 'USPS', ups: 'UPS', ups_walleted: 'UPS',
    fedex: 'FedEx', amazon_buy_shipping: 'Amazon Buy Shipping',
    dhl_express: 'DHL Express', ontrac: 'OnTrac',
};

// ─── Step 1: Query shipments missing data ────────────────────────────
async function fetchIncompleteShipments(cursor) {
    // Shipments that are not voided AND (missing label_cost OR missing tracking_number)
    // Use created_at > cursor for pagination
    const PAGE_SIZE = 500;
    let all = [];
    let offset = 0;
    const cursorFilter = cursor?.last_shipment_id
        ? `&id=gt.${cursor.last_shipment_id}`
        : '';

    while (true) {
        const query = `shipments?is_voided=eq.false&or=(label_cost.is.null,tracking_number.is.null)&select=id,order_id,tracking_number,label_cost,carrier_name,carrier_service,shipped_at,data_source,external_ids&order=id.asc${cursorFilter}&offset=${offset}&limit=${PAGE_SIZE}`;
        const rows = await supaGet(query);
        all = all.concat(rows);
        log(`  Fetched ${rows.length} incomplete shipments (total: ${all.length})`);
        if (rows.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }

    stats.queried = all.length;
    return all;
}

// ─── Step 2: Get order_number for a shipment ─────────────────────────
const orderNumberCache = {};

async function getOrderNumber(orderId) {
    if (!orderId) return null;
    if (orderNumberCache[orderId]) return orderNumberCache[orderId];
    const rows = await supaGet(`orders?id=eq.${orderId}&select=order_number&limit=1`);
    const num = rows?.[0]?.order_number || null;
    if (num) orderNumberCache[orderId] = num;
    return num;
}

// ─── Step 3+4: Search ShipStation and enrich ─────────────────────────
const ssCache = {};  // order_number → SS shipments array (avoid duplicate lookups)

async function searchShipStation(orderNumber) {
    if (ssCache[orderNumber] !== undefined) return ssCache[orderNumber];
    const data = await ssGet(`/shipments?orderNumber=${encodeURIComponent(orderNumber)}&includeShipmentItems=true`);
    const shipments = data.shipments || [];
    ssCache[orderNumber] = shipments;
    return shipments;
}

function pickBestMatch(ssShipments, shipment) {
    if (!ssShipments.length) return null;
    if (ssShipments.length === 1) return ssShipments[0];

    // If shipment already has tracking, find exact match
    if (shipment.tracking_number) {
        const exact = ssShipments.find(s => s.trackingNumber === shipment.tracking_number);
        if (exact) return exact;
    }

    // Prefer non-voided shipments with cost
    const valid = ssShipments.filter(s => !s.voided && s.shipmentCost != null);
    if (valid.length === 1) return valid[0];
    if (valid.length > 1) {
        // Return the most recent
        return valid.sort((a, b) => new Date(b.createDate) - new Date(a.createDate))[0];
    }

    return ssShipments[0];
}

function buildPatch(shipment, ss) {
    const patch = {};
    let enriched = false;

    if (shipment.label_cost == null && ss.shipmentCost != null) {
        patch.label_cost = ss.shipmentCost;
        patch.insurance_cost = ss.insuranceCost || 0;
        patch.total_cost = +(ss.shipmentCost + (ss.insuranceCost || 0)).toFixed(2);
        enriched = true;
    }

    if (!shipment.tracking_number && ss.trackingNumber) {
        patch.tracking_number = ss.trackingNumber;
        patch.status = 'in_transit';
        enriched = true;
    }

    if (!shipment.carrier_name && ss.carrierCode) {
        patch.carrier_name = CARRIER_NAMES[ss.carrierCode] || ss.carrierCode;
        patch.carrier_code = ss.carrierCode;
        enriched = true;
    }

    if (!shipment.carrier_service && ss.serviceName) {
        patch.carrier_service = ss.serviceName;
        enriched = true;
    }

    if (!shipment.shipped_at && ss.shipDate) {
        patch.shipped_at = ss.shipDate + 'T00:00:00Z';
        enriched = true;
    }

    if (enriched) {
        patch.data_source = 'shipstation';
        // Merge external_ids
        patch.external_ids = {
            ...(shipment.external_ids || {}),
            shipstation: String(ss.shipmentId),
        };
    }

    return enriched ? patch : null;
}

// ─── Main processing loop ────────────────────────────────────────────
async function main() {
    log('╔══════════════════════════════════════════════════╗');
    log('║  Cross-validate Shipments: Supabase ↔ ShipStation ║');
    log('╚══════════════════════════════════════════════════╝');
    if (DRY_RUN) log('*** DRY RUN — no changes will be written ***');

    const cursor = loadCursor();
    if (cursor) {
        log(`Resuming from cursor: shipment id > ${cursor.last_shipment_id} (${cursor.processed} already processed)`);
    }

    // Step 1: Get incomplete shipments
    log('Step 1: Querying shipments missing label_cost or tracking_number...');
    const shipments = await fetchIncompleteShipments(cursor);
    const toProcess = BATCH_LIMIT ? shipments.slice(0, BATCH_LIMIT) : shipments;
    log(`  Found ${shipments.length} incomplete shipments${BATCH_LIMIT ? `, processing ${toProcess.length}` : ''}`);

    if (toProcess.length === 0) {
        log('✅ Nothing to process — all shipments are complete or cursor past end.');
        return;
    }

    let processed = cursor?.processed || 0;

    for (let i = 0; i < toProcess.length; i++) {
        const shipment = toProcess[i];

        try {
            // Step 2: Get order_number
            const orderNumber = await getOrderNumber(shipment.order_id);
            if (!orderNumber) {
                stats.errors++;
                continue;
            }

            // Step 3: Search ShipStation
            const ssShipments = await searchShipStation(orderNumber);
            if (!ssShipments.length) {
                stats.not_found++;
                if (i % 200 === 0) {
                    log(`  [${i + 1}/${toProcess.length}] ${orderNumber} — not found in ShipStation`);
                }
                continue;
            }

            // Find best match
            const match = pickBestMatch(ssShipments, shipment);
            if (!match) {
                stats.not_found++;
                continue;
            }

            stats.matched++;

            // Step 4: Build and apply patch
            const patch = buildPatch(shipment, match);
            if (!patch) {
                stats.already_complete++;
                continue;
            }

            await supaPatch('shipments', shipment.id, patch);
            stats.updated++;

            if (i % 50 === 0 || i === toProcess.length - 1) {
                log(`  [${i + 1}/${toProcess.length}] ${orderNumber} → enriched (cost=$${match.shipmentCost ?? '?'}, tracking=${match.trackingNumber ? '✓' : '✗'}) [rate-limit: ${rateLimitRemaining}]`);
            }
        } catch (e) {
            log(`  ⚠ Shipment ${shipment.id}: ${e.message}`);
            stats.errors++;
        }

        processed++;

        // Save cursor every 100 records
        if (processed % 100 === 0) {
            saveCursor({
                last_shipment_id: shipment.id,
                processed,
            });
        }
    }

    // Final cursor save
    if (toProcess.length > 0) {
        saveCursor({
            last_shipment_id: toProcess[toProcess.length - 1].id,
            processed,
        });
    }

    // ─── Report ──────────────────────────────────────────────────────
    log('');
    log('════════════════════════════════════════════════');
    log('  Cross-validation complete');
    log('════════════════════════════════════════════════');
    log(`  Shipments queried:     ${stats.queried}`);
    log(`  Matched in ShipStation: ${stats.matched}`);
    log(`  Updated/enriched:      ${stats.updated}`);
    log(`  Already complete:      ${stats.already_complete}`);
    log(`  Not found in SS:       ${stats.not_found}`);
    log(`  Errors:                ${stats.errors}`);
    log(`  ShipStation API calls: ${stats.ss_requests}`);
    log('════════════════════════════════════════════════');

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
