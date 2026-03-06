#!/usr/bin/env node

/**
 * Backfill shipment label_cost from ShipStation CSV export.
 * 
 * Usage:
 *   node backfill-labels-csv.mjs /path/to/Shipping\ Data.csv
 *   node backfill-labels-csv.mjs /path/to/Shipping\ Data.csv --dry-run
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Load env ────────────────────────────────────────────────────────
try {
    const content = readFileSync(join(__dirname, '..', '.env.local'), 'utf8');
    for (const line of content.split('\n')) {
        const m = line.match(/^(\w+)=(.+)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
} catch {}

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase creds'); process.exit(1); }

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const csvPath = args.find(a => !a.startsWith('--'));
if (!csvPath) { console.error('Usage: node backfill-labels-csv.mjs <csv-path> [--dry-run]'); process.exit(1); }

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ─── Parse CSV ───────────────────────────────────────────────────────
function parseCSV(path) {
    const content = readFileSync(path, 'utf8').replace(/^\uFEFF/, ''); // strip BOM
    const lines = content.split('\n');
    const headers = parseCSVLine(lines[0]);
    
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        const vals = parseCSVLine(lines[i]);
        const row = {};
        headers.forEach((h, idx) => row[h.trim()] = (vals[idx] || '').trim());
        rows.push(row);
    }
    return rows;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
        if (ch === '"') { inQuotes = !inQuotes; }
        else if (ch === ',' && !inQuotes) { result.push(current); current = ''; }
        else { current += ch; }
    }
    result.push(current);
    return result;
}

// ─── Carrier mapping ─────────────────────────────────────────────────
const CARRIER_MAP = {
    'Amazon Buy Shipping': 'Amazon Buy Shipping',
    'Amazon Shipping US': 'Amazon Shipping',
    'UPS': 'UPS',
    'UPS by ShipStation': 'UPS',
    'Stamps.com': 'USPS',
    'USPS': 'USPS',
    'FedEx One Balance': 'FedEx',
    'FedEx': 'FedEx',
    'OnTrac': 'OnTrac',
    'Sendle': 'Sendle',
};

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaFetch(path, opts = {}) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        ...opts,
        headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            ...(opts.headers || {}),
        },
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`Supabase ${res.status}: ${body.slice(0, 300)}`);
    }
    const count = res.headers.get('content-range')?.split('/')?.pop();
    if (opts.method === 'PATCH') return { count };
    const data = await res.json();
    return { data, count: count ? parseInt(count) : null };
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log(`Parsing CSV: ${csvPath}`);
    const csvRows = parseCSV(csvPath);
    log(`CSV rows: ${csvRows.length}`);
    if (DRY_RUN) log('*** DRY RUN ***');

    // Index CSV by order number (handle multi-shipment orders)
    const csvByOrder = {};
    for (const row of csvRows) {
        const on = row['Order #'];
        if (!on) continue;
        const cost = parseFloat(row['Shipping Cost'] || '0');
        const ins = parseFloat(row['Insurance Cost'] || '0');
        if (!csvByOrder[on]) csvByOrder[on] = [];
        csvByOrder[on].push({
            ship_date: row['Ship Date'],
            provider: row['Provider'],
            service: row['Service'],
            zone: row['Zone'] ? parseInt(row['Zone']) : null,
            label_cost: cost,
            insurance_cost: ins,
            total_cost: +(cost + ins).toFixed(2),
            weight_oz: parseFloat(row['Weight'] || '0'),
            carrier_name: CARRIER_MAP[row['Provider']] || row['Provider'],
        });
    }
    log(`Unique orders in CSV: ${Object.keys(csvByOrder).length}`);

    // Fetch ALL shipments missing label_cost (non-voided)
    log('Fetching shipments needing label_cost...');
    let allShipments = [];
    let offset = 0;
    const PAGE = 1000;
    while (true) {
        const { data } = await supaFetch(
            `shipments?is_voided=eq.false&or=(label_cost.is.null,label_cost.eq.0)` +
            `&select=id,order_id,tracking_number,carrier_name,carrier_service,label_cost,shipped_at` +
            `&order=id.asc&limit=${PAGE}&offset=${offset}`,
            { headers: { Prefer: 'count=exact' } }
        );
        allShipments.push(...data);
        if (data.length < PAGE) break;
        offset += PAGE;
    }
    log(`Shipments needing label_cost: ${allShipments.length}`);

    // Fetch order numbers for these shipments (batch by order_id)
    const orderIds = [...new Set(allShipments.map(s => s.order_id).filter(Boolean))];
    log(`Unique orders to look up: ${orderIds.length}`);

    const orderMap = {}; // order_id -> order_number
    for (let i = 0; i < orderIds.length; i += 50) {
        const batch = orderIds.slice(i, i + 50);
        const inFilter = batch.map(id => `"${id}"`).join(',');
        const { data } = await supaFetch(`orders?id=in.(${inFilter})&select=id,order_number`);
        for (const row of data) {
            orderMap[row.id] = row.order_number;
        }
    }
    log(`Order numbers loaded: ${Object.keys(orderMap).length}`);

    // Match and update
    const stats = { matched: 0, updated: 0, not_found: 0, no_order: 0, already_has_cost: 0, multi_match: 0 };

    for (const shipment of allShipments) {
        const orderNumber = orderMap[shipment.order_id];
        if (!orderNumber) {
            stats.no_order++;
            continue;
        }

        const csvEntries = csvByOrder[orderNumber];
        if (!csvEntries || csvEntries.length === 0) {
            stats.not_found++;
            continue;
        }

        stats.matched++;

        // Pick best CSV entry
        let best;
        if (csvEntries.length === 1) {
            best = csvEntries[0];
        } else {
            // Multi-shipment: try to match by date proximity
            stats.multi_match++;
            // Just pick the first one with cost > 0 that hasn't been used
            best = csvEntries.find(e => e.label_cost > 0 && !e._used) || csvEntries[0];
        }
        best._used = true;

        if (best.label_cost <= 0) continue;

        // Build update
        const update = {
            label_cost: best.label_cost,
            total_cost: best.total_cost,
            data_source: 'shipstation',
            enriched_at: new Date().toISOString(),
        };
        if (best.insurance_cost > 0) update.insurance_cost = best.insurance_cost;
        if (best.zone) update.zone = best.zone;
        if (best.weight_oz > 0) update.weight_oz = best.weight_oz;
        if (!shipment.carrier_name && best.carrier_name) update.carrier_name = best.carrier_name;
        if (!shipment.carrier_service && best.service) update.carrier_service = best.service;

        if (!DRY_RUN) {
            await supaFetch(`shipments?id=eq.${shipment.id}`, {
                method: 'PATCH',
                headers: { Prefer: 'return=minimal' },
                body: JSON.stringify(update),
            });
        }
        stats.updated++;

        if (stats.updated % 500 === 0) {
            log(`  Progress: ${stats.updated} updated, ${stats.matched} matched, ${stats.not_found} not found`);
        }
    }

    log('\n════════════════════════════════════');
    log('Backfill complete!');
    log(`  Matched:      ${stats.matched} (order found in CSV)`);
    log(`  Updated:      ${stats.updated} (label_cost filled)`);
    log(`  Not found:    ${stats.not_found} (order not in CSV)`);
    log(`  No order#:    ${stats.no_order} (shipment has no order_id)`);
    log(`  Multi-ship:   ${stats.multi_match} (multiple CSV entries per order)`);
    log('════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
