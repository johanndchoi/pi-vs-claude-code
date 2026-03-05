#!/usr/bin/env node

/**
 * Merge duplicate shipment rows into one row per order.
 * Keeps the richest data, combines external_ids from all sources,
 * and deletes the duplicate rows.
 *
 * Usage:
 *   node merge-shipments.mjs --dry-run    # Preview
 *   node merge-shipments.mjs              # Execute merge
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');

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

const stats = { orders_checked: 0, merged: 0, rows_deleted: 0, errors: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaPatch(table, id, data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json', Prefer: 'return=minimal'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) throw new Error(`PATCH ${table} ${res.status}: ${await res.text()}`);
}

async function supaDelete(table, id) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'DELETE',
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    if (!res.ok) throw new Error(`DELETE ${table} ${res.status}: ${await res.text()}`);
}

// ─── Pick best value (non-null, prefer non-generic) ──────────────────
function best(...values) {
    for (const v of values) {
        if (v !== null && v !== undefined && v !== '') return v;
    }
    return null;
}

// ─── Merge logic ─────────────────────────────────────────────────────
function mergeRows(rows) {
    // Sort: rows with tracking_number first, then by most filled fields
    const scored = rows.map(r => ({
        ...r,
        score: [
            r.tracking_number ? 100 : 0,
            r.label_cost ? 10 : 0,
            r.shipped_at ? 5 : 0,
            r.carrier_service ? 3 : 0,
            r.carrier_name && r.carrier_name !== 'Buy Shipping' ? 2 : 0,
            r.tracking_url ? 1 : 0,
        ].reduce((a, b) => a + b, 0)
    }));
    scored.sort((a, b) => b.score - a.score);

    const winner = scored[0];
    const losers = scored.slice(1);

    // Merge external_ids from all rows
    const mergedExternalIds = {};
    for (const r of rows) {
        if (r.external_ids) {
            Object.assign(mergedExternalIds, r.external_ids);
        }
    }

    // Build merged data — take best from all rows
    const allValues = (field) => rows.map(r => r[field]).filter(v => v !== null && v !== undefined && v !== '');

    const merged = {
        tracking_number: best(...rows.map(r => r.tracking_number)),
        tracking_url: best(...rows.map(r => r.tracking_url)),
        carrier_name: best(
            ...rows.map(r => r.carrier_name).filter(n => n && n !== 'Buy Shipping'),
            ...rows.map(r => r.carrier_name)
        ),
        carrier_code: best(...rows.map(r => r.carrier_code)),
        carrier_service: best(...rows.map(r => r.carrier_service)),
        label_cost: best(...rows.map(r => r.label_cost)),
        label_source: best(
            // Prefer specific sources over generic
            ...rows.map(r => r.label_source).filter(s => s && s !== 'veeqo'),
            ...rows.map(r => r.label_source)
        ),
        shipped_at: best(...rows.map(r => r.shipped_at)),
        delivered_at: best(...rows.map(r => r.delivered_at)),
        status: best(
            // Prefer most advanced status
            ...rows.map(r => r.status).filter(s => s === 'delivered'),
            ...rows.map(r => r.status).filter(s => s === 'in_transit'),
            ...rows.map(r => r.status).filter(s => s === 'in_transit'),
            ...rows.map(r => r.status)
        ),
        weight_oz: best(...rows.map(r => r.weight_oz)),
        external_ids: mergedExternalIds,
        // Keep both data sources
        data_source: best(
            ...rows.map(r => r.data_source).filter(s => s === 'veeqo'),
            ...rows.map(r => r.data_source)
        ),
    };

    return { winner, losers, merged };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Shipment merge — finding duplicate rows per order');
    if (DRY_RUN) log('*** DRY RUN ***');

    // Get all order_ids that have multiple shipment rows
    // We need to paginate through all shipments grouped by order
    let offset = 0;
    const orderShipments = {}; // order_id -> [shipment rows]

    log('Loading all shipments...');
    while (true) {
        const batch = await supaGet(
            `shipments?order_id=not.is.null&select=id,order_id,data_source,label_source,tracking_number,tracking_url,carrier_name,carrier_code,carrier_service,label_cost,shipped_at,delivered_at,status,weight_oz,external_ids&limit=1000&offset=${offset}&order=order_id`
        );
        for (const row of batch) {
            if (!orderShipments[row.order_id]) orderShipments[row.order_id] = [];
            orderShipments[row.order_id].push(row);
        }
        offset += batch.length;
        if (batch.length < 1000) break;
        if (offset % 10000 === 0) log(`  Loaded ${offset} shipments...`);
    }

    const totalOrders = Object.keys(orderShipments).length;
    const dupeOrders = Object.entries(orderShipments).filter(([_, rows]) => rows.length > 1);
    log(`Total orders with shipments: ${totalOrders}`);
    log(`Orders with multiple shipment rows: ${dupeOrders.length}`);

    // Process each duplicate set
    for (const [orderId, rows] of dupeOrders) {
        stats.orders_checked++;

        // Group by tracking number — if an order has legitimately different shipments
        // (e.g., multi-package), don't merge those
        const groups = {};
        for (const r of rows) {
            // Group key: tracking number if available, otherwise 'null'
            const key = r.tracking_number || '__null__';
            if (!groups[key]) groups[key] = [];
            groups[key].push(r);
        }

        // Also merge null-tracking rows into the group that has tracking (if only one group has it)
        const trackedGroups = Object.entries(groups).filter(([k]) => k !== '__null__');
        const nullGroup = groups['__null__'] || [];

        if (trackedGroups.length === 1 && nullGroup.length > 0) {
            // Single tracking number + null rows → merge all together
            trackedGroups[0][1].push(...nullGroup);
            delete groups['__null__'];
        } else if (trackedGroups.length === 0 && nullGroup.length > 1) {
            // All null tracking — merge them all
            // Keep as is, will be merged below
        } else if (trackedGroups.length > 1 && nullGroup.length > 0) {
            // Multiple different tracking numbers — these might be multi-package
            // Merge nulls into the first tracked group (best effort)
            trackedGroups[0][1].push(...nullGroup);
            delete groups['__null__'];
        }

        // Merge within each group
        for (const [key, groupRows] of Object.entries(groups)) {
            if (groupRows.length < 2) continue;

            const { winner, losers, merged } = mergeRows(groupRows);

            if (DRY_RUN) {
                log(`  Order ${orderId.slice(0, 8)}... (${key}): keep ${winner.id.slice(0, 8)} (${winner.data_source}), delete ${losers.length} dupes`);
                stats.merged++;
                stats.rows_deleted += losers.length;
                continue;
            }

            try {
                // Update winner with merged data
                await supaPatch('shipments', winner.id, merged);

                // Re-point any shipment_photos or tracking_events from losers to winner
                for (const loser of losers) {
                    // Move tracking_events
                    await fetch(`${SUPA_URL}/rest/v1/tracking_events?shipment_id=eq.${loser.id}`, {
                        method: 'PATCH',
                        headers: {
                            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
                            'Content-Type': 'application/json', Prefer: 'return=minimal'
                        },
                        body: JSON.stringify({ shipment_id: winner.id })
                    });

                    // Move shipment_photos
                    await fetch(`${SUPA_URL}/rest/v1/shipment_photos?shipment_id=eq.${loser.id}`, {
                        method: 'PATCH',
                        headers: {
                            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
                            'Content-Type': 'application/json', Prefer: 'return=minimal'
                        },
                        body: JSON.stringify({ shipment_id: winner.id })
                    });

                    // Delete loser
                    await supaDelete('shipments', loser.id);
                    stats.rows_deleted++;
                }

                stats.merged++;
                if (stats.merged % 500 === 0) log(`  Merged ${stats.merged} shipments...`);
            } catch (e) {
                log(`  ⚠ Error merging ${orderId.slice(0, 8)}: ${e.message}`);
                stats.errors++;
            }
        }
    }

    log('────────────────────────────────────');
    log('Merge complete!');
    log(`  Orders with dupes: ${dupeOrders.length}`);
    log(`  Shipments merged:  ${stats.merged}`);
    log(`  Rows deleted:      ${stats.rows_deleted}`);
    log(`  Errors:            ${stats.errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
