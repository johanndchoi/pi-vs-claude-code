#!/usr/bin/env node

/**
 * Cross-Validate Shipments: Veeqo ↔ ShipStation
 *
 * Finds Supabase shipments missing label_cost or tracking_number,
 * looks up corresponding orders in ShipStation V1, and backfills
 * missing fields (cost, carrier, tracking, dates).
 *
 * Usage:
 *   node crossvalidate-shipments.mjs              # Full run
 *   node crossvalidate-shipments.mjs --dry-run    # Preview only
 *   node crossvalidate-shipments.mjs --reset      # Clear cursor, start fresh
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESET = args.includes('--reset');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? parseInt(args[i + 1]) : Infinity; })();

const CURSOR_FILE = join(__dirname, '..', '.locks', 'crossvalidate-shipments.cursor');
const BATCH_SIZE = 200;

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

const opExec = cmd => execSync(cmd, { encoding: 'utf8', env: { ...process.env } }).trim();

const SS_KEY = opExec('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Key"');
const SS_SECRET = opExec('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Secret"');
const SS_AUTH = 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Logging & Utils ─────────────────────────────────────────────────
const stats = { processed: 0, matched: 0, updated: 0, not_found: 0, skipped: 0, errors: 0 };
const ssCache = {};  // Cache ShipStation results per order number
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Cursor ──────────────────────────────────────────────────────────
function loadCursor() {
    if (RESET) return null;
    try {
        const data = JSON.parse(readFileSync(CURSOR_FILE, 'utf8'));
        return data;
    } catch { return null; }
}

function saveCursor(cursor) {
    mkdirSync(dirname(CURSOR_FILE), { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify({ ...cursor, saved_at: new Date().toISOString() }, null, 2));
}

// ─── ShipStation V1 Rate Limiter ─────────────────────────────────────
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

    const remaining = res.headers.get('x-rate-limit-remaining');
    if (remaining != null) rateLimitRemaining = parseInt(remaining);

    if (res.status === 429) {
        const reset = parseInt(res.headers.get('x-rate-limit-reset') || '10');
        log(`  ⏳ 429 rate limited, waiting ${reset + 1}s...`);
        await sleep((reset + 1) * 1000);
        rateLimitRemaining = 40;
        return ssGet(path);
    }
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`ShipStation ${res.status}: ${body.slice(0, 200)}`);
    }
    return res.json();
}

// ─── Supabase Helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            Prefer: 'count=exact'
        }
    });
    const count = res.headers.get('content-range')?.split('/')?.pop();
    const body = await res.json();
    return { data: body, count: count ? parseInt(count) : null };
}

async function supaPatch(table, id, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`PATCH ${table} ${res.status}: ${body.slice(0, 200)}`);
    }
}

// ─── Fetch shipments needing enrichment ──────────────────────────────
async function fetchIncompleteShipments(lastId) {
    // Shipments missing label_cost OR tracking_number, not voided
    // Also include label_cost=0 (likely data gaps)
    let filter = 'shipments?is_voided=eq.false&or=(label_cost.is.null,label_cost.eq.0,tracking_number.is.null)';
    filter += '&select=id,order_id,tracking_number,label_cost,carrier_name,carrier_service,shipped_at,data_source';
    filter += `&order=id.asc&limit=${BATCH_SIZE}`;
    if (lastId) filter += `&id=gt.${lastId}`;

    const { data, count } = await supaGet(filter);
    return { shipments: data || [], totalRemaining: count };
}

// ─── Batch fetch order numbers ───────────────────────────────────────
const orderCache = {};

async function batchLoadOrderNumbers(orderIds) {
    const uncached = [...new Set(orderIds.filter(id => id && !orderCache[id]))];
    if (uncached.length === 0) return;

    // Supabase REST API: in filter, batch of 50 at a time
    for (let i = 0; i < uncached.length; i += 50) {
        const batch = uncached.slice(i, i + 50);
        const inFilter = batch.map(id => `"${id}"`).join(',');
        const { data } = await supaGet(`orders?id=in.(${inFilter})&select=id,order_number`);
        for (const row of (data || [])) {
            orderCache[row.id] = row.order_number;
        }
    }
}

function getOrderNumber(orderId) {
    return orderCache[orderId] || null;
}

// ─── Search ShipStation for matching shipment ────────────────────────
async function findShipStationMatch(orderNumber) {
    if (!orderNumber) return null;
    const data = await ssGet(`/shipments?orderNumber=${encodeURIComponent(orderNumber)}&includeShipmentItems=true&pageSize=100`);
    const shipments = data?.shipments || [];
    // Return non-voided shipments only
    return shipments.filter(s => !s.voided);
}

// ─── Carrier mapping ─────────────────────────────────────────────────
const CARRIER_NAMES = {
    stamps_com: 'USPS (Stamps.com)', usps: 'USPS', ups: 'UPS', ups_walleted: 'UPS',
    fedex: 'FedEx', amazon_buy_shipping: 'Amazon Buy Shipping',
    dhl_express: 'DHL Express', ontrac: 'OnTrac'
};

// ─── Match ShipStation shipment to Supabase shipment ─────────────────
function pickBestMatch(ssShipments, supaShipment) {
    if (ssShipments.length === 0) return null;
    if (ssShipments.length === 1) return ssShipments[0];

    // If we have a tracking number, match on it
    if (supaShipment.tracking_number) {
        const byTracking = ssShipments.find(s => s.trackingNumber === supaShipment.tracking_number);
        if (byTracking) return byTracking;
    }

    // Otherwise pick the one with a cost (prefer non-zero cost)
    const withCost = ssShipments.filter(s => s.shipmentCost > 0);
    if (withCost.length === 1) return withCost[0];

    // Fall back to first
    return ssShipments[0];
}

// ─── Build update payload ────────────────────────────────────────────
function buildUpdate(supaShipment, ssMatch) {
    const update = {};
    let changed = false;

    if ((supaShipment.label_cost == null || supaShipment.label_cost === 0) && ssMatch.shipmentCost != null && ssMatch.shipmentCost > 0) {
        update.label_cost = ssMatch.shipmentCost;
        update.total_cost = +(ssMatch.shipmentCost + (ssMatch.insuranceCost || 0)).toFixed(2);
        if (ssMatch.insuranceCost) update.insurance_cost = ssMatch.insuranceCost;
        changed = true;
    }

    if (!supaShipment.tracking_number && ssMatch.trackingNumber) {
        update.tracking_number = ssMatch.trackingNumber;
        changed = true;
    }

    if (!supaShipment.carrier_name && ssMatch.carrierCode) {
        update.carrier_name = CARRIER_NAMES[ssMatch.carrierCode] || ssMatch.carrierCode;
        changed = true;
    }

    if (!supaShipment.carrier_service && ssMatch.serviceName) {
        update.carrier_service = ssMatch.serviceName;
        changed = true;
    }

    if (!supaShipment.shipped_at && ssMatch.shipDate) {
        update.shipped_at = ssMatch.shipDate.includes('T') ? ssMatch.shipDate : ssMatch.shipDate + 'T00:00:00Z';
        changed = true;
    }

    if (changed) {
        update.data_source = 'shipstation';
        update.enriched_at = new Date().toISOString();
    }

    return changed ? update : null;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Cross-Validate Shipments: Veeqo ↔ ShipStation');
    if (DRY_RUN) log('*** DRY RUN — no writes ***');
    if (LIMIT < Infinity) log(`Limit: ${LIMIT} shipments`);

    const cursor = loadCursor();
    let lastId = cursor?.last_id || null;
    if (lastId) log(`Resuming from cursor: id > ${lastId}`);

    // Get initial count
    const { totalRemaining } = await fetchIncompleteShipments(null);
    log(`Total incomplete shipments (missing cost or tracking): ${totalRemaining}`);

    let batchNum = 0;

    while (stats.processed < LIMIT) {
        batchNum++;
        const { shipments } = await fetchIncompleteShipments(lastId);

        if (shipments.length === 0) {
            log('No more shipments to process.');
            break;
        }

        log(`\n── Batch ${batchNum}: ${shipments.length} shipments (starting after id ${lastId || 'start'}) ──`);

        // Batch-load all order numbers at once (eliminates N+1)
        const orderIds = shipments.map(s => s.order_id).filter(Boolean);
        await batchLoadOrderNumbers(orderIds);

        for (const shipment of shipments) {
            if (stats.processed >= LIMIT) break;
            stats.processed++;
            lastId = shipment.id;

            // 1. Get order number (from cache, loaded in batch above)
            const orderNumber = getOrderNumber(shipment.order_id);
            if (!orderNumber) {
                stats.skipped++;
                continue;
            }

            // 2. Search ShipStation (cached per order number)
            let ssShipments;
            try {
                if (!ssCache[orderNumber]) {
                    ssCache[orderNumber] = await findShipStationMatch(orderNumber);
                }
                ssShipments = ssCache[orderNumber];
            } catch (e) {
                log(`  ⚠ SS lookup failed for ${orderNumber}: ${e.message}`);
                stats.errors++;
                continue;
            }

            if (!ssShipments || ssShipments.length === 0) {
                stats.not_found++;
                continue;
            }

            stats.matched++;

            // 3. Pick best match and build update
            const best = pickBestMatch(ssShipments, shipment);
            const update = buildUpdate(shipment, best);

            if (!update) {
                // Matched but nothing new to add
                continue;
            }

            // 4. Apply update
            try {
                await supaPatch('shipments', shipment.id, update);
                stats.updated++;

                if (stats.updated % 50 === 0 || stats.processed <= 5) {
                    const fields = Object.keys(update).filter(k => k !== 'data_source' && k !== 'enriched_at').join(', ');
                    log(`  ✓ ${orderNumber} → enriched: ${fields}${DRY_RUN ? ' (dry)' : ''}`);
                }
            } catch (e) {
                log(`  ⚠ Update failed for ${shipment.id}: ${e.message}`);
                stats.errors++;
            }

            // Save cursor every 100 processed
            if (stats.processed % 100 === 0) {
                saveCursor({ last_id: lastId, stats: { ...stats } });
            }
        }

        // Progress log
        const pct = totalRemaining ? ((stats.processed / Math.min(totalRemaining, LIMIT)) * 100).toFixed(1) : '?';
        log(`  Progress: ${stats.processed}/${Math.min(totalRemaining || 0, LIMIT)} (${pct}%) | matched=${stats.matched} updated=${stats.updated} not_found=${stats.not_found} errors=${stats.errors} | SS rate_limit=${rateLimitRemaining}`);
    }

    // Final cursor save
    saveCursor({ last_id: lastId, completed: true, stats: { ...stats } });

    // ─── Summary ─────────────────────────────────────────────────────
    log('\n════════════════════════════════════');
    log('Cross-validation complete!');
    log(`  Processed:    ${stats.processed}`);
    log(`  Matched:      ${stats.matched} (found in ShipStation)`);
    log(`  Updated:      ${stats.updated} (enriched with new data)`);
    log(`  Not found:    ${stats.not_found} (no ShipStation match)`);
    log(`  Skipped:      ${stats.skipped} (no order number)`);
    log(`  Errors:       ${stats.errors}`);
    log('════════════════════════════════════');

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
