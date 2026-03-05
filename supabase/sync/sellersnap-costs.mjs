#!/usr/bin/env node

/**
 * SellerSnap → Supabase Cost Price Sync
 * Pulls product costs from SellerSnap and updates product_variants + order_items.
 *
 * Stores: Amazon (30206), Walmart (31069)
 */

import { readFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

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
const SS_USER = execSync('op read "op://Agents Service Accounts/SellerSnapAPI/username"', { encoding: 'utf8' }).trim();
const SS_PASS = execSync('op read "op://Agents Service Accounts/SellerSnapAPI/password"', { encoding: 'utf8' }).trim();

const STORES = [
    { id: 30206, name: 'Amazon' },
    { id: 31069, name: 'Walmart' },
];

const stats = { variants_updated: 0, items_updated: 0, skus_loaded: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

async function main() {
    log('SellerSnap cost sync starting');

    // Fetch costs from all stores
    const allCosts = {};
    for (const store of STORES) {
        const res = await fetch(`https://api4.sellersnap.io/store/${store.id}/listings/data`, {
            headers: { Authorization: 'Basic ' + Buffer.from(`${SS_USER}:${SS_PASS}`).toString('base64') }
        });
        const data = await res.json();
        const listings = data?.data || [];
        let count = 0;
        for (const item of listings) {
            if (!item.sku || !item.cost || item.cost === '0.00') continue;
            const totalCost = +(+item.cost + +(item.additional_cost || 0)).toFixed(2);
            // Don't overwrite if Amazon already has a cost (prefer Amazon data)
            if (!allCosts[item.sku] || store.name === 'Amazon') {
                allCosts[item.sku] = totalCost;
            }
            count++;
        }
        log(`  ${store.name} (${store.id}): ${listings.length} listings, ${count} with cost`);
    }
    stats.skus_loaded = Object.keys(allCosts).length;
    log(`  Total unique SKUs with cost: ${stats.skus_loaded}`);

    const h = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

    // Update product_variants
    for (const [sku, cost] of Object.entries(allCosts)) {
        const res = await fetch(`${SUPA_URL}/rest/v1/product_variants?sku=eq.${encodeURIComponent(sku)}&cost_price=neq.${cost}`, {
            method: 'PATCH',
            headers: { ...h, 'Content-Type': 'application/json', Prefer: 'return=headers-only' },
            body: JSON.stringify({ cost_price: cost })
        });
        if (res.ok) {
            const range = res.headers.get('content-range');
            if (range && !range.startsWith('*/0')) stats.variants_updated++;
        }
    }
    log(`  Product variants updated: ${stats.variants_updated}`);

    // Update order_items with cost_price=0
    for (const [sku, cost] of Object.entries(allCosts)) {
        const res = await fetch(`${SUPA_URL}/rest/v1/order_items?sku=eq.${encodeURIComponent(sku)}&cost_price=eq.0`, {
            method: 'PATCH',
            headers: { ...h, 'Content-Type': 'application/json', Prefer: 'count=exact' },
            body: JSON.stringify({ cost_price: cost })
        });
        if (res.ok) {
            const range = res.headers.get('content-range');
            const count = range ? parseInt(range.split('/')[1]) : 0;
            if (count > 0) stats.items_updated += count;
        }
    }

    log('────────────────────────────────────');
    log(`Done! SKUs: ${stats.skus_loaded}, Variants: ${stats.variants_updated}, Items: ${stats.items_updated}`);
}

main().catch(e => { console.error(e); process.exit(1); });
