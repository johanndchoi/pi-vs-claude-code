#!/usr/bin/env node

/**
 * Backfill missing shipment data from Veeqo API + tracking_events table.
 * Fixes: tracking_number, tracking_url, carrier_service, label_cost,
 *        shipped_at, delivered_at, status
 *
 * Usage:
 *   node backfill-shipments.mjs                # Fix all null-tracking shipments
 *   node backfill-shipments.mjs --delivered     # Also backfill delivered_at from tracking_events
 *   node backfill-shipments.mjs --dry-run       # Preview
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { buildTrackingUrl } from './lib/tracking-url.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DO_DELIVERED = args.includes('--delivered');

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
const VEEQO_KEY = execSync('op read "op://Agents Service Accounts/Veeqo API Credentials/credential"', { encoding: 'utf8' }).trim();

const stats = { checked: 0, updated: 0, not_found: 0, api_404: 0, delivered_backfilled: 0, errors: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── API helpers ─────────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaPatch(id, data) {
    if (DRY_RUN) return true;
    const res = await fetch(`${SUPA_URL}/rest/v1/shipments?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify(data)
    });
    return res.ok;
}

let rateLimitHits = 0;
async function veeqoGet(path) {
    const res = await fetch(`https://api.veeqo.com${path}`, {
        headers: { 'x-api-key': VEEQO_KEY }
    });
    if (res.status === 429) {
        rateLimitHits++;
        const wait = Math.min(60, 10 * rateLimitHits);
        log(`  ⏳ Veeqo rate limited, waiting ${wait}s...`);
        await sleep(wait * 1000);
        return veeqoGet(path);
    }
    rateLimitHits = Math.max(0, rateLimitHits - 1);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Phase 1: Fix null-tracking from Veeqo ──────────────────────────
async function fixNullTracking() {
    log('Phase 1: Fixing null-tracking shipments from Veeqo API');

    // Get all null-tracking shipments with their order's Veeqo ID
    let offset = 0;
    let shipments = [];
    while (true) {
        const batch = await supaGet(
            `shipments?tracking_number=is.null&data_source=eq.veeqo&select=id,external_ids,order_id,orders(external_ids)&limit=1000&offset=${offset}`
        );
        shipments = shipments.concat(batch);
        if (batch.length < 1000) break;
        offset += batch.length;
    }
    log(`  Found ${shipments.length} null-tracking Veeqo shipments`);

    // Group by Veeqo order ID to minimize API calls
    const byOrder = {};
    for (const s of shipments) {
        const veeqoOrderId = s.orders?.external_ids?.veeqo;
        if (!veeqoOrderId) continue;
        if (!byOrder[veeqoOrderId]) byOrder[veeqoOrderId] = [];
        byOrder[veeqoOrderId].push(s);
    }
    const orderIds = Object.keys(byOrder).sort((a, b) => Number(b) - Number(a)); // Newest first
    log(`  Across ${orderIds.length} unique Veeqo orders (newest first)`);

    let consecutiveMisses = 0;
    for (let i = 0; i < orderIds.length; i++) {
        const voId = orderIds[i];
        const shipmentRows = byOrder[voId];
        stats.checked += shipmentRows.length;

        if ((i + 1) % 100 === 0) {
            log(`  [${i + 1}/${orderIds.length}] Updated: ${stats.updated}, 404s: ${stats.api_404}, noData: ${stats.not_found}, errors: ${stats.errors}`);
        }

        // Stop if we've hit 500 consecutive orders with no tracking data (too old)
        if (consecutiveMisses > 500) {
            log(`  ⏹ Stopping — ${consecutiveMisses} consecutive orders without tracking data (too old for Veeqo)`);
            break;
        }

        // Fetch order from Veeqo
        const order = await veeqoGet(`/orders/${voId}`);
        if (!order) {
            stats.api_404 += shipmentRows.length;
            consecutiveMisses += shipmentRows.length;
            continue;
        }

        // Build map of Veeqo shipment ID → API data
        const apiShipments = {};
        for (const alloc of order.allocations || []) {
            const ship = alloc.shipment;
            if (!ship) continue;
            apiShipments[String(ship.id)] = {
                tracking_number: ship.tracking_number?.tracking_number || null,
                tracking_url: buildTrackingUrl(ship.tracking_number?.tracking_number, ship.carrier?.name),
                carrier_name: ship.carrier?.name || null,
                carrier_service: ship.service_name || ship.short_service_name || null,
                service_code: ship.service_type || null,
                label_cost: ship.outbound_label_charges?.value || null,
                shipped_at: ship.created_at || null,
                delivered_at: ship.tracking_number?.delivered_at || null,
                status: ship.tracking_number?.status || null,
            };
        }

        // Match and update
        for (const row of shipmentRows) {
            const veeqoShipId = row.external_ids?.veeqo;
            const apiData = apiShipments[veeqoShipId];

            if (!apiData || !apiData.tracking_number) {
                stats.not_found++;
                continue;
            }

            const patch = {};
            if (apiData.tracking_number) patch.tracking_number = apiData.tracking_number;
            if (apiData.tracking_url) patch.tracking_url = apiData.tracking_url;
            if (apiData.carrier_service) patch.carrier_service = apiData.carrier_service;
            if (apiData.service_code) patch.service_code = apiData.service_code;
            if (apiData.label_cost) patch.label_cost = apiData.label_cost;
            if (apiData.shipped_at) patch.shipped_at = apiData.shipped_at;
            if (apiData.delivered_at) patch.delivered_at = apiData.delivered_at;

            // Fix status based on actual tracking data
            // Valid: created, label_printed, awaiting_collection, in_transit, out_for_delivery, delivered, attempted_delivery, returned_to_sender, cancelled, exception
            if (apiData.delivered_at || apiData.status === 'delivered') {
                patch.status = 'delivered';
            } else if (apiData.tracking_number) {
                patch.status = 'in_transit';
            }

            if (Object.keys(patch).length > 0) {
                const ok = await supaPatch(row.id, patch);
                if (ok) {
                    stats.updated++;
                    consecutiveMisses = 0;
                    if (stats.updated <= 5) log(`    ✅ ${row.id.slice(0,8)} → ${patch.tracking_number}`);
                } else {
                    stats.errors++;
                    consecutiveMisses++;
                    log(`    ⚠ PATCH failed for ${row.id.slice(0,8)}`);
                }
            } else {
                consecutiveMisses++;
            }
        }

        await sleep(300); // Gentle on Veeqo API
    }
}

// ─── Phase 2: Backfill delivered_at from tracking_events ─────────────
async function backfillDelivered() {
    log('Phase 2: Backfilling delivered_at from tracking_events');

    // Find shipments with tracking but no delivered_at, where tracking_events has a delivered event
    let offset = 0;
    let total = 0;
    while (true) {
        const shipments = await supaGet(
            `shipments?delivered_at=is.null&tracking_number=not.is.null&select=id&limit=500&offset=${offset}`
        );
        if (shipments.length === 0) break;

        for (const s of shipments) {
            // Find delivered event
            const events = await supaGet(
                `tracking_events?shipment_id=eq.${s.id}&status=eq.delivered&select=occurred_at&order=occurred_at.desc&limit=1`
            );
            if (events?.length > 0) {
                const ok = await supaPatch(s.id, {
                    delivered_at: events[0].occurred_at,
                    status: 'delivered'
                });
                if (ok) stats.delivered_backfilled++;
            }
        }

        offset += shipments.length;
        total += shipments.length;
        if (total % 1000 === 0) log(`  Checked ${total} shipments, backfilled ${stats.delivered_backfilled}`);
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Shipment backfill starting');
    if (DRY_RUN) log('*** DRY RUN ***');

    await fixNullTracking();

    log('────────────────────────────────────');
    log(`Phase 1 complete:`);
    log(`  Checked:    ${stats.checked}`);
    log(`  Updated:    ${stats.updated}`);
    log(`  API 404s:   ${stats.api_404} (old orders, deleted from Veeqo)`);
    log(`  No data:    ${stats.not_found} (Veeqo has no tracking either)`);
    log(`  Errors:     ${stats.errors}`);

    if (DO_DELIVERED) {
        await backfillDelivered();
        log('────────────────────────────────────');
        log(`Phase 2 complete:`);
        log(`  Delivered backfilled: ${stats.delivered_backfilled}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
