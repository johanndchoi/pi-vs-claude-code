#!/usr/bin/env node

/**
 * Backfill label_cost for Veeqo shipments missing it.
 * 
 * Queries Supabase for non-voided shipments with null label_cost,
 * fetches the Veeqo order, matches shipments, and updates label_cost.
 *
 * Usage:
 *   node backfill-veeqo-labels.mjs              # Full run
 *   node backfill-veeqo-labels.mjs --limit 100  # Test with 100 orders
 *   node backfill-veeqo-labels.mjs --dry-run    # Preview only
 *   node backfill-veeqo-labels.mjs --resume      # Resume from saved cursor
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const RESUME = args.includes('--resume');
const limitArg = args.find((_, i) => args[i - 1] === '--limit');
const LIMIT = limitArg ? parseInt(limitArg) : null;

const CURSOR_FILE = join(__dirname, '.backfill-veeqo-labels-cursor.json');
const DELAY_MS = 1100; // 1.1s between Veeqo API calls (300 req/5min)

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

const VEEQO_KEY = execSync('op read "op://Agents Service Accounts/Veeqo API Credentials/credential"', { encoding: 'utf8' }).trim();

const stats = { checked: 0, updated: 0, api_404: 0, no_cost: 0, already_has: 0, errors: 0, skipped_resume: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Cursor management ──────────────────────────────────────────────
function loadCursor() {
    if (!RESUME || !existsSync(CURSOR_FILE)) return null;
    try {
        const data = JSON.parse(readFileSync(CURSOR_FILE, 'utf8'));
        log(`Resuming from cursor: processed ${data.processed} orders, last veeqo_id=${data.lastVeeqoOrderId}`);
        return data;
    } catch { return null; }
}

function saveCursor(data) {
    writeFileSync(CURSOR_FILE, JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2));
}

// ─── API helpers ─────────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    if (!res.ok) throw new Error(`Supabase GET ${res.status}: ${await res.text()}`);
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
        log(`  ⏳ Rate limited, waiting ${wait}s...`);
        await sleep(wait * 1000);
        return veeqoGet(path);
    }
    rateLimitHits = Math.max(0, rateLimitHits - 1);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Backfill Veeqo label_cost starting');
    if (DRY_RUN) log('*** DRY RUN ***');
    if (LIMIT) log(`Limit: ${LIMIT} orders`);

    // Step 1: Query all shipments missing label_cost (non-voided, Veeqo-sourced)
    log('Fetching shipments with null label_cost...');
    let allShipments = [];
    let offset = 0;
    while (true) {
        const batch = await supaGet(
            `shipments?label_cost=is.null&is_voided=eq.false&data_source=eq.veeqo` +
            `&select=id,external_ids,tracking_number,order_id,orders(external_ids)` +
            `&limit=1000&offset=${offset}`
        );
        allShipments = allShipments.concat(batch);
        if (batch.length < 1000) break;
        offset += batch.length;
    }
    log(`Found ${allShipments.length} shipments missing label_cost`);

    // Step 2: Group by Veeqo order ID
    const byOrder = {};
    let noVeeqoId = 0;
    for (const s of allShipments) {
        const veeqoOrderId = s.orders?.external_ids?.veeqo;
        if (!veeqoOrderId) { noVeeqoId++; continue; }
        if (!byOrder[veeqoOrderId]) byOrder[veeqoOrderId] = [];
        byOrder[veeqoOrderId].push(s);
    }
    const orderIds = Object.keys(byOrder).sort((a, b) => Number(b) - Number(a)); // Newest first
    log(`Across ${orderIds.length} unique Veeqo orders (${noVeeqoId} skipped - no veeqo_id)`);

    // Load resume cursor
    const cursor = loadCursor();
    const resumeAfter = cursor?.lastVeeqoOrderId;
    let pastResume = !resumeAfter;

    const effectiveLimit = LIMIT ? Math.min(LIMIT, orderIds.length) : orderIds.length;

    let processed = cursor?.processed || 0;
    for (let i = 0; i < orderIds.length; i++) {
        const voId = orderIds[i];

        // Resume logic: skip until we find where we left off
        if (!pastResume) {
            if (voId === resumeAfter) pastResume = true;
            stats.skipped_resume++;
            continue;
        }

        // Check limit (count from actual processing, not skips)
        if (LIMIT && (processed - (cursor?.processed || 0)) >= effectiveLimit) {
            log(`Reached limit of ${LIMIT} orders`);
            break;
        }

        const shipmentRows = byOrder[voId];
        stats.checked += shipmentRows.length;
        processed++;

        // Progress log every 100
        if (processed % 100 === 0) {
            log(`  [${processed}/${orderIds.length}] Updated: ${stats.updated}, 404s: ${stats.api_404}, noCost: ${stats.no_cost}, errors: ${stats.errors}`);
            saveCursor({ processed, lastVeeqoOrderId: voId, stats });
        }

        // Fetch from Veeqo
        let order;
        try {
            order = await veeqoGet(`/orders/${voId}`);
        } catch (e) {
            log(`  ⚠ Veeqo error for order ${voId}: ${e.message}`);
            stats.errors++;
            await sleep(DELAY_MS);
            continue;
        }

        if (!order) {
            stats.api_404 += shipmentRows.length;
            await sleep(DELAY_MS);
            continue;
        }

        // Build map of veeqo shipment id → label cost data from API
        const apiShipments = {};
        for (const alloc of (order.allocations || [])) {
            const ship = alloc.shipment;
            if (!ship) continue;

            // Extract label cost — try multiple sources
            let labelCost = null;

            // Source 1: outbound_label_charges (object or array)
            const olc = ship.outbound_label_charges;
            if (olc != null) {
                if (Array.isArray(olc)) {
                    labelCost = olc[0]?.value ?? null;
                } else if (typeof olc === 'object' && olc.value != null) {
                    labelCost = +olc.value;
                } else if (typeof olc === 'number') {
                    labelCost = olc;
                }
            }

            // Source 2: charges array (has BASE_RATE etc)
            if (labelCost == null && Array.isArray(ship.charges) && ship.charges.length > 0) {
                const total = ship.charges.reduce((sum, c) => sum + (c.value || 0), 0);
                if (total > 0) labelCost = +total.toFixed(2);
            } else if (labelCost == null && ship.charges && typeof ship.charges === 'object' && ship.charges.value != null) {
                labelCost = +ship.charges.value;
            }

            // Source 3: ship.cost fallback
            if (labelCost == null && ship.cost != null) {
                labelCost = +ship.cost;
            }

            const carrierService = ship.service_name || ship.short_service_name || ship.carrier_service_name || null;

            apiShipments[String(ship.id)] = {
                label_cost: labelCost,
                carrier_service: carrierService,
                tracking_number: ship.tracking_number?.tracking_number || ship.tracking_number || null
            };
        }

        // Match shipments and update
        for (const row of shipmentRows) {
            const veeqoShipId = row.external_ids?.veeqo;
            let apiData = veeqoShipId ? apiShipments[veeqoShipId] : null;

            // Fallback: match by tracking number if no veeqo shipment ID match
            if (!apiData && row.tracking_number) {
                apiData = Object.values(apiShipments).find(
                    a => a.tracking_number === row.tracking_number
                );
            }

            if (!apiData || apiData.label_cost == null) {
                stats.no_cost++;
                continue;
            }

            const patch = { label_cost: +apiData.label_cost };

            // Also backfill carrier_service if missing
            if (apiData.carrier_service && !row.carrier_service) {
                patch.carrier_service = apiData.carrier_service;
            }

            // Calculate total_cost if we now have label_cost
            patch.total_cost = +apiData.label_cost;

            const ok = await supaPatch('shipments', row.id, patch);
            if (ok) {
                stats.updated++;
                if (stats.updated <= 10) {
                    log(`    ✅ ${row.id.slice(0, 8)} → $${apiData.label_cost}`);
                }
            } else {
                stats.errors++;
                log(`    ⚠ PATCH failed for ${row.id.slice(0, 8)}`);
            }
        }

        await sleep(DELAY_MS);
    }

    // Save final cursor
    saveCursor({ processed, lastVeeqoOrderId: orderIds[processed - 1] || 'done', stats, completed: true });

    // Summary
    log('────────────────────────────────────');
    log('Backfill complete!');
    log(`  Orders checked:    ${processed}`);
    log(`  Shipments checked: ${stats.checked}`);
    log(`  Updated:           ${stats.updated}`);
    log(`  API 404s:          ${stats.api_404} (old orders purged from Veeqo)`);
    log(`  No cost in API:    ${stats.no_cost}`);
    log(`  Errors:            ${stats.errors}`);
    if (stats.skipped_resume) log(`  Skipped (resume):  ${stats.skipped_resume}`);

    if (stats.errors > 10) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
