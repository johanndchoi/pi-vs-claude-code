#!/usr/bin/env node

/**
 * Veeqo Tracking Events Backfill → Supabase
 * Fetches carrier scan events for all Veeqo shipments and updates shipment statuses.
 *
 * Usage:
 *   node veeqo-tracking.mjs                  # Process all Veeqo shipments
 *   node veeqo-tracking.mjs --recent 500     # Only most recent N shipments
 *   node veeqo-tracking.mjs --dry-run         # Preview
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const recentArg = args.find((_, i) => args[i - 1] === '--recent');
const RECENT_LIMIT = recentArg ? parseInt(recentArg) : null;

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
    execSync('op read "op://Agents Service Accounts/Veeqo API Credentials/credential"', { encoding: 'utf8' }).trim();
const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    shipments_processed: 0,
    shipments_with_events: 0,
    shipments_no_events: 0,
    events_inserted: 0,
    statuses_updated: 0,
    already_current: 0,
    errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Veeqo API (rate limit: ~150 req/min from testing) ──────────────
let veeqoRequestCount = 0;
let veeqoWindowStart = Date.now();

async function veeqoGet(path) {
    veeqoRequestCount++;
    const elapsed = Date.now() - veeqoWindowStart;
    if (veeqoRequestCount >= 140 && elapsed < 60000) {
        const waitMs = 60000 - elapsed + 1000;
        log(`  ⏳ Veeqo rate pause (${Math.ceil(waitMs / 1000)}s)...`);
        await sleep(waitMs);
        veeqoRequestCount = 0;
        veeqoWindowStart = Date.now();
    }
    if (elapsed >= 60000) {
        veeqoRequestCount = 1;
        veeqoWindowStart = Date.now();
    }

    const res = await fetch(`https://api.veeqo.com${path}`, {
        headers: { 'x-api-key': VEEQO_KEY }
    });

    if (res.status === 429) {
        log('  ⏳ Veeqo 429, waiting 60s...');
        await sleep(60000);
        veeqoRequestCount = 0;
        veeqoWindowStart = Date.now();
        return veeqoGet(path);
    }
    if (!res.ok) {
        if (res.status === 404) return null;
        throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    }
    return res.json();
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaPost(table, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal,resolution=merge-duplicates'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`POST ${table} ${res.status}: ${body.slice(0, 200)}`);
    }
}

async function supaPatch(table, filter, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${filter}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`PATCH ${table} ${res.status}: ${body.slice(0, 200)}`);
    }
}

// ─── Status mapping ─────────────────────────────────────────────────
const VEEQO_TO_DB_STATUS = {
    'awaiting_collection': 'awaiting_collection',
    'collected': 'in_transit',
    'in_transit': 'in_transit',
    'out_for_delivery': 'out_for_delivery',
    'delivered': 'delivered',
    'attempted_delivery': 'attempted_delivery',
    'returned_to_sender': 'returned_to_sender',
    'cancelled': 'cancelled',
    'exception': 'exception'
};

// Status priority for determining "latest" status
const STATUS_PRIORITY = {
    'created': 0, 'label_printed': 1, 'awaiting_collection': 2,
    'in_transit': 3, 'out_for_delivery': 4, 'delivered': 5,
    'attempted_delivery': 4, 'returned_to_sender': 5,
    'cancelled': 5, 'exception': 4
};

// ─── Fetch Veeqo shipments from Supabase ─────────────────────────────
async function fetchVeeqoShipments() {
    let all = [];
    let offset = 0;
    const pageSize = 1000;

    const limitClause = RECENT_LIMIT ? `&limit=${RECENT_LIMIT}` : '';
    const orderClause = RECENT_LIMIT ? '&order=created_at.desc' : '&order=created_at.asc';

    while (true) {
        log(`Fetching shipments from DB (offset ${offset})...`);
        const rows = await supaGet(
            `shipments?data_source=eq.veeqo&select=id,external_ids,status,tracking_number${orderClause}&offset=${offset}&limit=${pageSize}${limitClause ? '' : ''}`
        );
        if (!rows?.length) break;
        all = all.concat(rows);
        log(`  Got ${rows.length} (total: ${all.length})`);

        if (RECENT_LIMIT && all.length >= RECENT_LIMIT) {
            all = all.slice(0, RECENT_LIMIT);
            break;
        }
        if (rows.length < pageSize) break;
        offset += pageSize;
    }

    return all;
}

// ─── Process one shipment ────────────────────────────────────────────
async function processShipment(ship, index, total) {
    const veeqoId = ship.external_ids?.veeqo;
    if (!veeqoId) return;

    if (index % 500 === 0 || index === total - 1) {
        log(`[${index + 1}/${total}] Allocation ${veeqoId} (current: ${ship.status})`);
    }

    stats.shipments_processed++;

    // Fetch tracking events from Veeqo
    let events;
    try {
        events = await veeqoGet(`/shipping/tracking_events/${veeqoId}`);
    } catch (e) {
        stats.errors++;
        if (index % 100 === 0) log(`  ⚠ ${veeqoId}: ${e.message}`);
        return;
    }

    if (!events || !Array.isArray(events) || events.length === 0) {
        stats.shipments_no_events++;
        return;
    }

    stats.shipments_with_events++;

    // Insert tracking events
    const eventRows = events.map(e => ({
        shipment_id: ship.id,
        tracking_number: ship.tracking_number || `veeqo-${veeqoId}`,
        status: e.status || 'unknown',
        description: e.description || null,
        location: e.location || null,
        occurred_at: e.timestamp,
        raw_data: e
    }));

    try {
        await supaPost('tracking_events', eventRows);
        stats.events_inserted += eventRows.length;
    } catch (e) {
        // Likely duplicate events — ignore
        if (!e.message.includes('duplicate') && !e.message.includes('23505')) {
            stats.errors++;
            if (stats.errors <= 10) log(`  ⚠ Events ${veeqoId}: ${e.message}`);
        }
    }

    // Update shipment status based on latest event
    const latestEvent = events[events.length - 1];
    const newStatus = VEEQO_TO_DB_STATUS[latestEvent.status];

    if (newStatus && newStatus !== ship.status) {
        const currentPriority = STATUS_PRIORITY[ship.status] || 0;
        const newPriority = STATUS_PRIORITY[newStatus] || 0;

        if (newPriority >= currentPriority) {
            try {
                const updateData = { status: newStatus };
                // Also set delivered_at if delivered
                if (newStatus === 'delivered') {
                    updateData.delivered_at = latestEvent.timestamp;
                }
                await supaPatch('shipments', `id=eq.${ship.id}`, updateData);
                stats.statuses_updated++;
            } catch (e) {
                stats.errors++;
            }
        } else {
            stats.already_current++;
        }
    } else {
        stats.already_current++;
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting Veeqo tracking events backfill');
    if (RECENT_LIMIT) log(`  Processing most recent ${RECENT_LIMIT} shipments`);
    if (DRY_RUN) log('*** DRY RUN ***');

    const shipments = await fetchVeeqoShipments();
    log(`Found ${shipments.length} Veeqo shipments to process`);

    // Process in batches to avoid memory issues
    for (let i = 0; i < shipments.length; i++) {
        try {
            await processShipment(shipments[i], i, shipments.length);
        } catch (e) {
            log(`  ⚠ Unexpected: ${e.message}`);
            stats.errors++;
        }

        // Log progress every 1000
        if ((i + 1) % 1000 === 0) {
            log(`  Progress: ${i + 1}/${shipments.length} | events: ${stats.events_inserted} | status updates: ${stats.statuses_updated} | errors: ${stats.errors}`);
        }
    }

    log('────────────────────────────────────');
    log('Tracking backfill complete!');
    log(`  Shipments processed:   ${stats.shipments_processed}`);
    log(`  With tracking events:  ${stats.shipments_with_events}`);
    log(`  No events available:   ${stats.shipments_no_events}`);
    log(`  Events inserted:       ${stats.events_inserted}`);
    log(`  Statuses updated:      ${stats.statuses_updated}`);
    log(`  Already current:       ${stats.already_current}`);
    log(`  Errors:                ${stats.errors}`);

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
