#!/usr/bin/env node

/**
 * Veeqo → Supabase Product Sync
 * Syncs all products, variants, kit components, and inventory levels.
 * 
 * Usage: node veeqo-products.mjs [--dry-run]
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const FULL = args.includes('--full');
const DRY_RUN = process.argv.includes('--dry-run');

// ─── Load credentials ────────────────────────────────────────────────
function loadEnv() {
    const envPath = join(__dirname, '..', '.env.local');
    try {
        const content = readFileSync(envPath, 'utf8');
        for (const line of content.split('\n')) {
            const match = line.match(/^(\w+)=(.+)$/);
            if (match) process.env[match[1]] = match[2];
        }
    } catch {}
}
loadEnv();

const VEEQO_KEY = process.env.VEEQO_API_KEY ||
    execSync('op item get "Veeqo API Credentials" --vault="Agents Service Accounts" --reveal --fields label=credential', { encoding: 'utf8' }).trim();

const SUPA_URL = process.env.SUPABASE_API_URL;
const SUPA_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA_URL || !SUPA_KEY) { console.error('Missing SUPABASE_API_URL or SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    products_created: 0, products_updated: 0,
    variants_created: 0, variants_updated: 0,
    kits_created: 0, inventory_upserted: 0, errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ─── API helpers ─────────────────────────────────────────────────────
async function veeqoGet(path) {
    const res = await fetch(`https://api.veeqo.com${path}`, {
        headers: { 'x-api-key': VEEQO_KEY }
    });
    if (!res.ok) throw new Error(`Veeqo ${res.status}: ${await res.text()}`);
    return res.json();
}

async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    return res.json();
}

async function supaUpsert(table, data) {
    if (DRY_RUN) { log(`  [DRY RUN] ${table}: ${JSON.stringify(data).slice(0, 120)}`); return data; }
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation,resolution=merge-duplicates'
        },
        body: JSON.stringify(data)
    });
    const body = await res.json();
    if (!res.ok) {
        const msg = body?.message || body?.details || JSON.stringify(body);
        throw new Error(`Supabase ${table} ${res.status}: ${msg}`);
    }
    return Array.isArray(body) ? body[0] : body;
}

// ─── Cursor management ───────────────────────────────────────────────
const CURSOR_FILE = join(__dirname, '..', '.locks', 'veeqo-products.cursor');

function loadCursor() {
    try { return readFileSync(CURSOR_FILE, 'utf8').trim(); } catch { return null; }
}

function saveCursor(ts) {
    mkdirSync(dirname(CURSOR_FILE), { recursive: true });
    writeFileSync(CURSOR_FILE, ts);
}

// ─── Fetch Veeqo products ───────────────────────────────────────────
async function fetchAllProducts() {
    const cursor = !FULL && loadCursor();
    let all = [], page = 1;
    const sinceParam = cursor ? `&updated_at_min=${cursor}` : '';
    if (cursor) log(`Incremental since ${cursor}`);
    else log('Full product sync');

    while (true) {
        log(`Fetching Veeqo products page ${page}...`);
        const batch = await veeqoGet(`/products?page_size=100&page=${page}${sinceParam}`);
        all = all.concat(batch);
        log(`  Got ${batch.length} (total: ${all.length})`);
        if (batch.length < 100) break;
        page++;
    }
    return all;
}

// ─── Warehouse cache ─────────────────────────────────────────────────
const warehouseCache = {};
async function getWarehouseId(veeqoWhId) {
    if (warehouseCache[veeqoWhId]) return warehouseCache[veeqoWhId];
    const rows = await supaGet(`warehouses?external_id=eq.${veeqoWhId}&select=id&limit=1`);
    const id = rows?.[0]?.id;
    if (id) warehouseCache[veeqoWhId] = id;
    return id;
}

// ─── Variant cache (for kit component lookups) ───────────────────────
const variantBySkuCache = {};
async function getVariantIdBySku(sku) {
    if (variantBySkuCache[sku]) return variantBySkuCache[sku];
    const rows = await supaGet(`product_variants?sku=eq.${encodeURIComponent(sku)}&select=id&limit=1`);
    const id = rows?.[0]?.id;
    if (id) variantBySkuCache[sku] = id;
    return id;
}

// ─── Process product ─────────────────────────────────────────────────
async function processProduct(vp, index, total) {
    const veeqoId = String(vp.id);
    const title = vp.title || '(untitled)';
    log(`[${index + 1}/${total}] ${title.slice(0, 65)}`);

    const hasKit = (vp.sellables || []).some(s => s.type === 'Kit');

    // Check if exists
    const existing = await supaGet(`products?external_ids->>veeqo=eq.${veeqoId}&select=id&limit=1`);
    const existingId = existing?.[0]?.id;

    const productData = {
        ...(existingId ? { id: existingId } : {}),
        title: vp.title || null,
        description: vp.description || null,
        brand: vp.brand || null,
        product_type: hasKit ? 'kit' : 'standard',
        origin_country: vp.origin_country || 'US',
        hs_tariff_code: vp.hs_tariff_number || null,
        main_image_url: vp.main_image_src || null,
        external_ids: { veeqo: veeqoId }
    };

    let product;
    try {
        product = await supaUpsert('products', productData);
        existingId ? stats.products_updated++ : stats.products_created++;
    } catch (e) {
        log(`  ⚠ Product error: ${e.message}`); stats.errors++; return;
    }

    const productId = product?.id || existingId;
    if (!productId) { log(`  ⚠ No product ID returned`); stats.errors++; return; }

    // Process variants
    for (const vs of (vp.sellables || [])) {
        await processVariant(productId, vs);
    }
}

// ─── Process variant ─────────────────────────────────────────────────
async function processVariant(productId, vs) {
    const sku = vs.sku_code;
    if (!sku) return;

    const veeqoVarId = String(vs.id);
    const weightOz = vs.weight_grams ? +(vs.weight_grams / 28.3495).toFixed(2) : 0;
    const dims = vs.measurement_attributes || {};

    // Check if exists
    const existing = await supaGet(`product_variants?sku=eq.${encodeURIComponent(sku)}&select=id&limit=1`);
    const existingId = existing?.[0]?.id;

    const variantData = {
        ...(existingId ? { id: existingId } : {}),
        product_id: productId,
        sku,
        title: vs.sellable_title || null,
        upc: vs.upc_code || null,
        price: +(vs.price || 0),
        cost_price: +(vs.cost_price || 0),
        weight_oz: weightOz,
        length_in: dims.depth || null,
        width_in: dims.width || null,
        height_in: dims.height || null,
        customs_description: vs.customs_description || null,
        is_active: vs.deleted_at == null,
        external_ids: { veeqo: veeqoVarId }
    };

    let variant;
    try {
        variant = await supaUpsert('product_variants', variantData);
        existingId ? stats.variants_updated++ : stats.variants_created++;
    } catch (e) {
        log(`  ⚠ Variant ${sku}: ${e.message}`); stats.errors++; return;
    }

    const variantId = variant?.id || existingId;
    if (!variantId) { stats.errors++; return; }
    variantBySkuCache[sku] = variantId;

    // Kit components
    if (vs.type === 'Kit' && vs.contents) {
        for (const comp of vs.contents) {
            await processKitComponent(variantId, comp);
        }
    }

    // Inventory levels
    for (const se of (vs.stock_entries || [])) {
        await processInventory(variantId, se);
    }
}

// ─── Kit component ───────────────────────────────────────────────────
async function processKitComponent(kitVariantId, comp) {
    const compSku = comp.sku_code;
    if (!compSku) return;

    const compVariantId = await getVariantIdBySku(compSku);
    if (!compVariantId) return; // Not synced yet

    try {
        await supaUpsert('kit_components', {
            kit_variant_id: kitVariantId,
            component_variant_id: compVariantId,
            quantity: comp.quantity || 1
        });
        stats.kits_created++;
    } catch (e) {
        // Likely duplicate — that's fine
        if (!e.message.includes('duplicate') && !e.message.includes('409')) {
            log(`  ⚠ Kit component ${compSku}: ${e.message}`);
        }
    }
}

// ─── Inventory ───────────────────────────────────────────────────────
async function processInventory(variantId, se) {
    const whId = await getWarehouseId(String(se.warehouse_id));
    if (!whId) return;

    // Check existing
    const existing = await supaGet(
        `inventory_levels?variant_id=eq.${variantId}&warehouse_id=eq.${whId}&select=id&limit=1`
    );
    const existingId = existing?.[0]?.id;

    try {
        await supaUpsert('inventory_levels', {
            ...(existingId ? { id: existingId } : {}),
            variant_id: variantId,
            warehouse_id: whId,
            physical_qty: se.physical_stock_level || 0,
            allocated_qty: se.allocated_stock_level || 0,
            incoming_qty: se.incoming_stock_level || 0
        });
        stats.inventory_upserted++;
    } catch (e) {
        log(`  ⚠ Inventory: ${e.message}`); stats.errors++;
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Starting Veeqo → Supabase product sync');
    if (DRY_RUN) log('*** DRY RUN — no writes ***');

    // Record import run
    let runId;
    if (!DRY_RUN) {
        try {
            const run = await supaUpsert('import_runs', {
                source: 'veeqo', job_name: 'veeqo_products_sync', status: 'running'
            });
            runId = run?.id;
        } catch {}
    }

    const products = await fetchAllProducts();
    log(`Fetched ${products.length} products from Veeqo`);

    for (let i = 0; i < products.length; i++) {
        try {
            await processProduct(products[i], i, products.length);
        } catch (e) {
            log(`  ⚠ Unexpected error: ${e.message}`);
            stats.errors++;
        }
    }

    log('────────────────────────────────────');
    log('Sync complete!');
    log(`  Products created: ${stats.products_created}`);
    log(`  Products updated: ${stats.products_updated}`);
    log(`  Variants created: ${stats.variants_created}`);
    log(`  Variants updated: ${stats.variants_updated}`);
    log(`  Kit links:        ${stats.kits_created}`);
    log(`  Inventory rows:   ${stats.inventory_upserted}`);
    log(`  Errors:           ${stats.errors}`);

    // Update import run
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
                    records_fetched: products.length,
                    records_created: stats.products_created + stats.variants_created,
                    records_updated: stats.products_updated + stats.variants_updated,
                    errors: stats.errors > 0 ? [{ count: stats.errors }] : []
                })
            });
        } catch {}
    }

    // Save cursor for next incremental run
    saveCursor(new Date().toISOString());
}

main().catch(e => { console.error(e); process.exit(1); });
