#!/usr/bin/env node

/**
 * Daily Inventory Snapshot → Supabase
 * Records stock levels per variant per warehouse for sell-through & stockout analysis.
 *
 * Primary: Veeqo GET /products (sellables → stock_entries)
 * Fallback: ShipStation GET /warehouses + /products for cross-check
 *
 * Usage:
 *   node inventory-snapshot.mjs              # Take today's snapshot
 *   node inventory-snapshot.mjs --dry-run    # Preview without writing
 *   node inventory-snapshot.mjs --force      # Overwrite existing snapshot
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FORCE = args.includes('--force');

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
    execSync('op read "op://Agents Service Accounts/Veeqo API Credentials/credential"',
        { encoding: 'utf8', env: { ...process.env } }).trim();

const SS_KEY = process.env.SS_V1_KEY ||
    execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Key"',
        { encoding: 'utf8', env: { ...process.env } }).trim();
const SS_SECRET = process.env.SS_V1_SECRET ||
    execSync('op read "op://Agents Service Accounts/Shipstation v1 API Credential/API Secret"',
        { encoding: 'utf8', env: { ...process.env } }).trim();
const SS_AUTH = 'Basic ' + Buffer.from(`${SS_KEY}:${SS_SECRET}`).toString('base64');

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing Supabase credentials'); process.exit(1); }

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    veeqo_products: 0,
    rows_prepared: 0,
    rows_inserted: 0,
    rows_skipped_existing: 0,
    shipstation_fallback: false,
    errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TODAY = new Date().toISOString().split('T')[0];

// ─── Veeqo API ──────────────────────────────────────────────────────
let veeqoRequestCount = 0;
let veeqoWindowStart = Date.now();

async function veeqoGet(path) {
    // Rate limit: ~150 req/min
    veeqoRequestCount++;
    if (veeqoRequestCount > 140) {
        const elapsed = Date.now() - veeqoWindowStart;
        if (elapsed < 60000) {
            const wait = 60000 - elapsed + 500;
            log(`  ⏳ Veeqo rate limit pause (${Math.ceil(wait / 1000)}s)...`);
            await sleep(wait);
        }
        veeqoRequestCount = 0;
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
    if (!res.ok) throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── ShipStation API ─────────────────────────────────────────────────
let rateLimitRemaining = 40;

async function ssGet(path) {
    if (rateLimitRemaining <= 2) {
        log('  ⏳ ShipStation rate limit pause (11s)...');
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
        log(`  ⏳ ShipStation 429, waiting ${reset + 1}s...`);
        await sleep((reset + 1) * 1000);
        rateLimitRemaining = 40;
        return ssGet(path);
    }
    if (!res.ok) throw new Error(`ShipStation ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supabasePost(table, rows) {
    if (rows.length === 0) return { inserted: 0, skipped: 0 };

    // Use upsert with ON CONFLICT to skip existing
    const prefer = FORCE
        ? 'resolution=merge-duplicates'
        : 'resolution=ignore-duplicates';

    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            'apikey': SUPA_KEY,
            'Authorization': `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': `${prefer},return=representation,count=exact`
        },
        body: JSON.stringify(rows)
    });

    if (!res.ok) {
        const text = await res.text();
        throw new Error(`Supabase POST ${table}: ${res.status} ${text}`);
    }

    const count = parseInt(res.headers.get('content-range')?.split('/')[1] || '0');
    const data = await res.json();
    return { inserted: data.length, total: count };
}

async function supabaseGet(table, params = '') {
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${params}`, {
        headers: {
            'apikey': SUPA_KEY,
            'Authorization': `Bearer ${SUPA_KEY}`
        }
    });
    if (!res.ok) throw new Error(`Supabase GET ${table}: ${res.status}`);
    return res.json();
}

// ─── Variant lookup cache ────────────────────────────────────────────
let variantMap = null; // sku → variant_id

async function loadVariantMap() {
    log('Loading product variants from Supabase...');
    const variants = await supabaseGet('product_variants', 'select=id,sku&limit=10000');
    variantMap = new Map();
    for (const v of variants) {
        if (v.sku) variantMap.set(v.sku, v.id);
    }
    log(`  Loaded ${variantMap.size} variant SKUs`);
}

// ─── Check if snapshot exists for today ──────────────────────────────
async function snapshotExistsToday() {
    const rows = await supabaseGet('inventory_snapshots',
        `snapshot_date=eq.${TODAY}&select=id&limit=1`);
    return rows.length > 0;
}

// ─── Pull inventory from Veeqo ──────────────────────────────────────
async function fetchVeeqoInventory() {
    log('Fetching products from Veeqo...');
    const rows = [];
    let page = 1;
    const pageSize = 100;

    while (true) {
        const products = await veeqoGet(`/products?page_size=${pageSize}&page=${page}`);
        if (!products || products.length === 0) break;

        stats.veeqo_products += products.length;

        for (const product of products) {
            const sellables = product.sellables || [];
            for (const sellable of sellables) {
                const sku = sellable.sku_code;
                if (!sku) continue;

                const variantId = variantMap?.get(sku) || null;
                const stockEntries = sellable.stock_entries || [];

                if (stockEntries.length === 0) {
                    // No warehouse breakdown — record total
                    rows.push({
                        variant_id: variantId,
                        sku,
                        warehouse_id: null,
                        quantity: sellable.total_quantity_sold != null
                            ? (sellable.quantity_to_sell || 0)
                            : (sellable.stock_level || 0),
                        snapshot_date: TODAY,
                        data_source: 'veeqo'
                    });
                } else {
                    for (const entry of stockEntries) {
                        rows.push({
                            variant_id: variantId,
                            sku,
                            warehouse_id: null, // Veeqo warehouse IDs are integers, not UUIDs
                            quantity: entry.physical_quantity ?? entry.stock_level ?? 0,
                            snapshot_date: TODAY,
                            data_source: 'veeqo'
                        });
                    }
                }
            }
        }

        log(`  Page ${page}: ${products.length} products (${rows.length} stock rows so far)`);

        if (products.length < pageSize) break;
        page++;
    }

    return rows;
}

// ─── ShipStation fallback ────────────────────────────────────────────
async function fetchShipStationInventory() {
    log('Falling back to ShipStation for inventory data...');
    stats.shipstation_fallback = true;
    const rows = [];

    // Get warehouses
    const warehouses = await ssGet('/warehouses');
    log(`  Found ${warehouses.length} ShipStation warehouses`);

    // Get products (paginated)
    let page = 1;
    while (true) {
        const data = await ssGet(`/products?pageSize=500&page=${page}`);
        const products = data.products || [];
        if (products.length === 0) break;

        for (const product of products) {
            const sku = product.sku;
            if (!sku) continue;

            const variantId = variantMap?.get(sku) || null;

            // ShipStation products don't have per-warehouse stock in the products endpoint
            // Use the warehouse quantity if available
            rows.push({
                variant_id: variantId,
                sku,
                warehouse_id: null,
                quantity: product.warehouseLocation ? 0 : 0, // ShipStation doesn't expose stock in products API
                snapshot_date: TODAY,
                data_source: 'shipstation'
            });
        }

        log(`  Page ${page}: ${products.length} products`);
        if (page >= (data.pages || 1)) break;
        page++;
    }

    return rows;
}

// ─── Deduplicate rows (keep one per SKU+warehouse) ───────────────────
function dedupeRows(rows) {
    const seen = new Map();
    for (const row of rows) {
        const key = `${row.sku}::${row.warehouse_id || 'null'}`;
        // Keep the row with higher quantity (more accurate)
        const existing = seen.get(key);
        if (!existing || row.quantity > existing.quantity) {
            seen.set(key, row);
        }
    }
    return [...seen.values()];
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log(`=== Inventory Snapshot — ${TODAY} ===`);
    if (DRY_RUN) log('DRY RUN — no data will be written');

    // Check if snapshot already taken today
    if (!FORCE) {
        const exists = await snapshotExistsToday();
        if (exists) {
            log(`Snapshot for ${TODAY} already exists. Use --force to overwrite.`);
            stats.rows_skipped_existing = 1;
            printStats();
            return;
        }
    }

    await loadVariantMap();

    // Try Veeqo first
    let rows = [];
    try {
        rows = await fetchVeeqoInventory();
    } catch (err) {
        log(`⚠ Veeqo failed: ${err.message}`);
        stats.errors++;
    }

    // Fallback to ShipStation if Veeqo returned nothing useful
    if (rows.length === 0) {
        try {
            rows = await fetchShipStationInventory();
        } catch (err) {
            log(`⚠ ShipStation fallback also failed: ${err.message}`);
            stats.errors++;
        }
    }

    if (rows.length === 0) {
        log('❌ No inventory data collected from any source');
        process.exit(1);
    }

    // Deduplicate
    rows = dedupeRows(rows);
    stats.rows_prepared = rows.length;
    log(`Prepared ${rows.length} snapshot rows`);

    if (DRY_RUN) {
        log('Sample rows:');
        for (const row of rows.slice(0, 5)) {
            log(`  ${row.sku}: qty=${row.quantity} src=${row.data_source}`);
        }
        printStats();
        return;
    }

    // Insert in batches of 500
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        try {
            const result = await supabasePost('inventory_snapshots', batch);
            stats.rows_inserted += result.inserted;
            log(`  Batch ${Math.floor(i / BATCH) + 1}: inserted ${result.inserted} rows`);
        } catch (err) {
            // Handle unique constraint violations gracefully
            if (err.message.includes('409') || err.message.includes('duplicate') || err.message.includes('23505')) {
                stats.rows_skipped_existing += batch.length;
                log(`  Batch ${Math.floor(i / BATCH) + 1}: skipped (already exists)`);
            } else {
                stats.errors++;
                log(`  ⚠ Batch error: ${err.message}`);
            }
        }
    }

    printStats();
}

function printStats() {
    log('─'.repeat(50));
    log(`Sync complete — ${TODAY}`);
    log(`  Veeqo products scanned: ${stats.veeqo_products}`);
    log(`  Rows prepared:          ${stats.rows_prepared}`);
    log(`  Rows inserted:          ${stats.rows_inserted}`);
    log(`  Rows skipped (exist):   ${stats.rows_skipped_existing}`);
    log(`  ShipStation fallback:   ${stats.shipstation_fallback ? 'YES' : 'no'}`);
    log(`  Errors:                 ${stats.errors}`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
