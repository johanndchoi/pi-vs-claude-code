#!/usr/bin/env node

/**
 * Daily Inventory Snapshot
 * Records stock levels per variant per warehouse for sell-through
 * and stockout analysis.
 *
 * Primary: Veeqo GET /products (sellables → stock_entries)
 * Fallback: ShipStation GET /products + /warehouses (cross-check)
 *
 * Usage:
 *   node inventory-snapshot.mjs              # Today's snapshot
 *   node inventory-snapshot.mjs --dry-run    # Preview without writing
 *   node inventory-snapshot.mjs --date 2026-03-01  # Backfill specific date
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const DATE_ARG = args.find((_, i) => args[i - 1] === '--date');
const SNAPSHOT_DATE = DATE_ARG || new Date().toISOString().split('T')[0];

// ─── Load credentials ────────────────────────────────────────────────
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
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing SUPABASE_API_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

// ShipStation credentials (fallback)
let SS_AUTH = null;
function getShipStationAuth() {
    if (SS_AUTH) return SS_AUTH;
    try {
        const ssKey = process.env.SS_V1_KEY ||
            execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Key"', { encoding: 'utf8' }).trim();
        const ssSecret = process.env.SS_V1_SECRET ||
            execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Secret"', { encoding: 'utf8' }).trim();
        SS_AUTH = 'Basic ' + Buffer.from(`${ssKey}:${ssSecret}`).toString('base64');
        return SS_AUTH;
    } catch (e) {
        log(`  ⚠ ShipStation credentials unavailable: ${e.message}`);
        return null;
    }
}

// ─── Stats ───────────────────────────────────────────────────────────
const stats = { inserted: 0, skipped_existing: 0, skipped_no_variant: 0, errors: 0, ss_fallback: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── API helpers ─────────────────────────────────────────────────────
async function veeqoGet(path) {
    const res = await fetch(`https://api.veeqo.com${path}`, {
        headers: { 'x-api-key': VEEQO_KEY }
    });
    if (!res.ok) throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    return res.json();
}

async function shipStationGet(path) {
    const auth = getShipStationAuth();
    if (!auth) return null;
    const res = await fetch(`https://ssapi.shipstation.com${path}`, {
        headers: { Authorization: auth }
    });
    if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
    return res.json();
}

async function supaPost(table, data) {
    if (DRY_RUN) { log(`  [DRY RUN] ${table}: ${JSON.stringify(data).slice(0, 120)}`); return { ok: true }; }
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=minimal,resolution=merge-duplicates'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        // UNIQUE violation = already snapshotted today, not an error
        if (res.status === 409 || body.includes('duplicate') || body.includes('unique')) {
            return { ok: false, duplicate: true };
        }
        throw new Error(`Supabase ${table} ${res.status}: ${body}`);
    }
    return { ok: true };
}

async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

// ─── Build variant/warehouse lookup caches ───────────────────────────
const variantCache = {};   // sku -> { id, ... }
const warehouseCache = {}; // external_id -> uuid

async function loadCaches() {
    log('Loading variant and warehouse caches...');

    // Load all active variants
    let offset = 0;
    while (true) {
        const batch = await supaGet(
            `product_variants?is_active=eq.true&select=id,sku,external_ids&limit=1000&offset=${offset}`
        );
        for (const v of batch) {
            if (v.sku) variantCache[v.sku] = v;
        }
        if (batch.length < 1000) break;
        offset += 1000;
    }
    log(`  Cached ${Object.keys(variantCache).length} variants`);

    // Load warehouses
    const warehouses = await supaGet('warehouses?select=id,external_id&is_active=eq.true');
    for (const w of warehouses) {
        if (w.external_id) warehouseCache[w.external_id] = w.id;
    }
    log(`  Cached ${Object.keys(warehouseCache).length} warehouses`);
}

// ─── Check if snapshot already done ──────────────────────────────────
async function snapshotExists() {
    const rows = await supaGet(
        `inventory_snapshots?snapshot_date=eq.${SNAPSHOT_DATE}&select=id&limit=1`
    );
    return rows && rows.length > 0;
}

// ─── Fetch all Veeqo products with stock ─────────────────────────────
async function fetchVeeqoInventory() {
    let all = [], page = 1;
    while (true) {
        log(`  Fetching Veeqo products page ${page}...`);
        const batch = await veeqoGet(`/products?page_size=100&page=${page}`);
        all = all.concat(batch);
        if (batch.length < 100) break;
        page++;
        await sleep(300); // Rate limit courtesy
    }
    return all;
}

// ─── Extract snapshot rows from Veeqo data ──────────────────────────
function extractVeeqoSnapshots(products) {
    const rows = [];
    for (const product of products) {
        for (const sellable of (product.sellables || [])) {
            const sku = sellable.sku_code;
            if (!sku) continue;

            const variant = variantCache[sku];
            if (!variant) {
                stats.skipped_no_variant++;
                continue;
            }

            for (const se of (sellable.stock_entries || [])) {
                const whExtId = String(se.warehouse_id);
                const warehouseId = warehouseCache[whExtId] || null;

                rows.push({
                    variant_id: variant.id,
                    sku,
                    warehouse_id: warehouseId,
                    quantity: se.physical_stock_level || 0,
                    snapshot_date: SNAPSHOT_DATE,
                    data_source: 'veeqo'
                });
            }
        }
    }
    return rows;
}

// ─── ShipStation fallback: cross-check for missing SKUs ──────────────
async function fetchShipStationInventory(existingSkus) {
    log('  Checking ShipStation for additional inventory data...');
    const auth = getShipStationAuth();
    if (!auth) { log('  ⚠ ShipStation unavailable, skipping fallback'); return []; }

    const rows = [];
    let page = 1;
    while (true) {
        const data = await shipStationGet(`/products?pageSize=500&page=${page}`);
        if (!data || !data.products) break;

        for (const prod of data.products) {
            const sku = prod.sku;
            if (!sku || existingSkus.has(sku)) continue;

            const variant = variantCache[sku];
            if (!variant) continue;

            // ShipStation doesn't break stock by warehouse in product list,
            // use warehouseQuantity if available
            if (prod.warehouseLocation || prod.quantity != null) {
                rows.push({
                    variant_id: variant.id,
                    sku,
                    warehouse_id: null,  // ShipStation product list doesn't specify warehouse
                    quantity: prod.quantity || 0,
                    snapshot_date: SNAPSHOT_DATE,
                    data_source: 'shipstation'
                });
                stats.ss_fallback++;
            }
        }

        if (data.products.length < 500 || page >= data.pages) break;
        page++;
        await sleep(500); // ShipStation rate limit: 40 req/min
    }

    return rows;
}

// ─── Batch insert snapshots ──────────────────────────────────────────
async function insertSnapshots(rows) {
    log(`Inserting ${rows.length} snapshot rows...`);
    const BATCH = 200;

    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            const result = await supaPost('inventory_snapshots', batch);
            if (result.duplicate) {
                stats.skipped_existing += batch.length;
            } else {
                stats.inserted += batch.length;
            }
        } catch (e) {
            // If batch fails, try individual inserts
            for (const row of batch) {
                try {
                    const result = await supaPost('inventory_snapshots', row);
                    if (result.duplicate) {
                        stats.skipped_existing++;
                    } else {
                        stats.inserted++;
                    }
                } catch (e2) {
                    log(`  ⚠ ${row.sku}: ${e2.message}`);
                    stats.errors++;
                }
            }
        }

        if (i + BATCH < rows.length) {
            log(`  Progress: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log(`Inventory Snapshot — ${SNAPSHOT_DATE}`);
    if (DRY_RUN) log('*** DRY RUN — no writes ***');

    // Check if already done
    if (!DRY_RUN && await snapshotExists()) {
        log(`Snapshot for ${SNAPSHOT_DATE} already exists. Skipping.`);
        log('Use --date YYYY-MM-DD to snapshot a different date.');
        return;
    }

    await loadCaches();

    // Primary: Veeqo
    log('Fetching inventory from Veeqo...');
    const veeqoProducts = await fetchVeeqoInventory();
    log(`  Got ${veeqoProducts.length} products from Veeqo`);

    const rows = extractVeeqoSnapshots(veeqoProducts);
    log(`  Extracted ${rows.length} stock entries from Veeqo`);

    // Fallback: ShipStation cross-check for SKUs not in Veeqo
    const veeqoSkus = new Set(rows.map(r => r.sku));
    const ssRows = await fetchShipStationInventory(veeqoSkus);
    if (ssRows.length > 0) {
        log(`  Added ${ssRows.length} entries from ShipStation fallback`);
        rows.push(...ssRows);
    }

    if (rows.length === 0) {
        log('No inventory data found. Aborting.');
        process.exit(1);
    }

    // Insert
    await insertSnapshots(rows);

    // Summary
    log('────────────────────────────────────');
    log('Snapshot complete!');
    log(`  Date:              ${SNAPSHOT_DATE}`);
    log(`  Inserted:          ${stats.inserted}`);
    log(`  Skipped (existing):${stats.skipped_existing}`);
    log(`  Skipped (no var):  ${stats.skipped_no_variant}`);
    log(`  ShipStation adds:  ${stats.ss_fallback}`);
    log(`  Errors:            ${stats.errors}`);

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
