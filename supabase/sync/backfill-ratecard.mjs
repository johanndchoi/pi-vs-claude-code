#!/usr/bin/env node

/**
 * Backfill label_cost for ghost shipments using third-party rate card.
 * 
 * These are orders shipped via a third-party label seller (carrier="Other" in Veeqo).
 * Weight is computed from order_items × product_variants.weight_oz.
 * 
 * Rules:
 *   - ≤15 lbs → USPS (Priority or Ground Advantage depending on era)
 *   - >15 lbs → UPS Ground (flat rate)
 *   - Rate card era determined by order date
 *
 * Usage:
 *   node backfill-ratecard.mjs             # Full run
 *   node backfill-ratecard.mjs --dry-run   # Preview only
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

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

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }

// ─── Rate Cards ──────────────────────────────────────────────────────
// USPS Priority tiers: [max_lbs, price]
// UPS Ground: flat rate for >15 lbs

const RATE_CARDS = [
    {
        // Before Jan 26 2023: no third-party labels
        start: '2000-01-01',
        end: '2023-01-25',
        usps_priority: null, // not available
        ups_ground: null,
    },
    {
        start: '2023-01-26',
        end: '2023-08-12',
        usps_priority: [
            [4, 6.40],
            [7, 8.00],
            [10, 9.00],
            [12, 10.00],
            [15, 12.00],
            [18, 15.00],
            [25, 18.00],
            [Infinity, 20.00],
        ],
        ups_ground: 12.00,
        ground_advantage: null,
    },
    {
        start: '2023-08-13',
        end: '2024-01-01',
        usps_priority: [
            [4, 5.80],
            [7, 6.70],
            [10, 8.00],
            [12, 9.00],
            [15, 11.00],
            [18, 14.00],
            [25, 16.00],
            [Infinity, 18.00],
        ],
        ups_ground: 12.00,
        ground_advantage: null,
    },
    {
        // Jan 2 2024: Ground Advantage added (0-15oz = $3.40)
        start: '2024-01-02',
        end: '2024-01-04',
        usps_priority: [
            [4, 5.80],
            [7, 6.70],
            [10, 8.00],
            [12, 9.00],
            [15, 11.00],
            [18, 14.00],
            [25, 16.00],
            [Infinity, 18.00],
        ],
        ups_ground: 12.00,
        ground_advantage: [
            [0.9375, 3.40],  // 15oz = 0.9375 lbs
        ],
    },
    {
        // Jan 5 2024 – Apr 15 2024: Ground Advantage expanded (10lbs = $7)
        // Last day with access to third-party rates
        start: '2024-01-05',
        end: '2024-04-15',
        usps_priority: [
            [4, 5.80],
            [7, 6.70],
            [10, 8.00],
            [12, 9.00],
            [15, 11.00],
            [18, 14.00],
            [25, 16.00],
            [Infinity, 18.00],
        ],
        ups_ground: 12.00,
        ground_advantage: [
            [0.9375, 3.40],  // 15oz
            [10, 7.00],      // 10lbs
        ],
    },
];

function getRateCard(orderDate) {
    const d = orderDate.slice(0, 10);
    for (const card of RATE_CARDS) {
        if (d >= card.start && d <= card.end) return card;
    }
    return null;
}

function computeLabelCost(weightLbs, card) {
    if (!card) return null;

    // >15 lbs → UPS Ground
    if (weightLbs > 15) {
        return card.ups_ground
            ? { cost: card.ups_ground, carrier: 'UPS', service: 'Ground' }
            : null;
    }

    // Check Ground Advantage first (cheapest for light packages)
    if (card.ground_advantage) {
        for (const [maxLbs, price] of card.ground_advantage) {
            if (weightLbs <= maxLbs) {
                return { cost: price, carrier: 'USPS', service: 'Ground Advantage' };
            }
        }
    }

    // USPS Priority
    if (card.usps_priority) {
        for (const [maxLbs, price] of card.usps_priority) {
            if (weightLbs <= maxLbs) {
                return { cost: price, carrier: 'USPS', service: 'Priority' };
            }
        }
    }

    return null;
}

// ─── Supabase helpers ────────────────────────────────────────────────
const headers = {
    apikey: SUPA_KEY,
    Authorization: `Bearer ${SUPA_KEY}`,
    'Content-Type': 'application/json',
};

async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { ...headers, Prefer: 'count=exact' },
    });
    if (!res.ok) throw new Error(`GET ${res.status}: ${await res.text()}`);
    const count = res.headers.get('content-range')?.split('/')?.pop();
    return { data: await res.json(), count: count ? parseInt(count) : null };
}

async function supaPatch(table, id, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?id=eq.${id}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`PATCH ${res.status}: ${await res.text()}`);
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Backfill label_cost from third-party rate card');
    if (DRY_RUN) log('*** DRY RUN ***');

    // 1. Load all product variant weights
    log('Loading product variant weights...');
    const variantWeights = {};
    let offset = 0;
    while (true) {
        const { data } = await supaGet(`product_variants?select=id,weight_oz&limit=1000&offset=${offset}`);
        for (const v of data) variantWeights[v.id] = v.weight_oz || 0;
        if (data.length < 1000) break;
        offset += 1000;
    }
    log(`  ${Object.keys(variantWeights).length} variants loaded`);

    // 2. Fetch all ghost shipments (null label_cost, null shipped_at, null tracking)
    log('Loading ghost shipments...');
    let ghostShipments = [];
    offset = 0;
    while (true) {
        const { data } = await supaGet(
            `shipments?is_voided=eq.false&label_cost=is.null&shipped_at=is.null&tracking_number=is.null` +
            `&select=id,order_id&order=id.asc&limit=1000&offset=${offset}`
        );
        ghostShipments.push(...data);
        if (data.length < 1000) break;
        offset += 1000;
    }
    log(`  ${ghostShipments.length} ghost shipments`);

    // 3. Batch-load order dates
    log('Loading order dates...');
    const orderIds = [...new Set(ghostShipments.map(s => s.order_id).filter(Boolean))];
    const orderDates = {};
    for (let i = 0; i < orderIds.length; i += 50) {
        const batch = orderIds.slice(i, i + 50);
        const inf = batch.map(id => `"${id}"`).join(',');
        const { data } = await supaGet(`orders?id=in.(${inf})&select=id,ordered_at`);
        for (const o of data) orderDates[o.id] = o.ordered_at;
    }
    log(`  ${Object.keys(orderDates).length} order dates loaded`);

    // 4. Batch-load order items (to compute weight per order)
    log('Loading order items for weight calculation...');
    const orderWeights = {}; // order_id → total weight in oz
    for (let i = 0; i < orderIds.length; i += 50) {
        const batch = orderIds.slice(i, i + 50);
        const inf = batch.map(id => `"${id}"`).join(',');
        const { data } = await supaGet(`order_items?order_id=in.(${inf})&select=order_id,variant_id,quantity`);
        for (const item of data) {
            const wt = variantWeights[item.variant_id] || 0;
            const itemWeight = wt * (item.quantity || 1);
            orderWeights[item.order_id] = (orderWeights[item.order_id] || 0) + itemWeight;
        }
    }
    log(`  Weights computed for ${Object.keys(orderWeights).length} orders`);

    // 5. Apply rate card and update
    const stats = {
        processed: 0, updated: 0, no_date: 0, no_weight: 0,
        no_card: 0, no_rate: 0, errors: 0,
        by_carrier: {}, by_era: {},
        total_cost: 0,
    };

    for (const shipment of ghostShipments) {
        stats.processed++;
        const orderDate = orderDates[shipment.order_id];
        if (!orderDate) { stats.no_date++; continue; }

        const weightOz = orderWeights[shipment.order_id];
        if (!weightOz || weightOz <= 0) { stats.no_weight++; continue; }

        const weightLbs = weightOz / 16;
        const card = getRateCard(orderDate);
        if (!card || (!card.usps_priority && !card.ups_ground)) { stats.no_card++; continue; }

        const result = computeLabelCost(weightLbs, card);
        if (!result) { stats.no_rate++; continue; }

        const update = {
            label_cost: result.cost,
            total_cost: result.cost,
            carrier_name: result.carrier,
            carrier_service: result.service,
            weight_oz: Math.round(weightOz * 10) / 10,
            data_source: 'manual',
            label_source: 'manual',
        };

        try {
            await supaPatch('shipments', shipment.id, update);
            stats.updated++;
            stats.total_cost += result.cost;

            const key = `${result.carrier} ${result.service}`;
            stats.by_carrier[key] = (stats.by_carrier[key] || 0) + 1;

            const era = card.start;
            stats.by_era[era] = (stats.by_era[era] || 0) + 1;
        } catch (e) {
            stats.errors++;
            if (stats.errors <= 5) log(`  ⚠ Error: ${e.message}`);
        }

        if (stats.updated % 500 === 0 && stats.updated > 0) {
            log(`  Progress: ${stats.updated}/${ghostShipments.length} updated, $${stats.total_cost.toFixed(2)} total`);
        }
    }

    // Summary
    log('\n════════════════════════════════════');
    log('Rate card backfill complete!');
    log(`  Processed:    ${stats.processed}`);
    log(`  Updated:      ${stats.updated}`);
    log(`  Total cost:   $${stats.total_cost.toFixed(2)}`);
    log(`  Avg cost:     $${stats.updated ? (stats.total_cost / stats.updated).toFixed(2) : 0}`);
    log(`  No date:      ${stats.no_date}`);
    log(`  No weight:    ${stats.no_weight}`);
    log(`  No rate card: ${stats.no_card}`);
    log(`  No rate:      ${stats.no_rate}`);
    log(`  Errors:       ${stats.errors}`);
    log('');
    log('By carrier/service:');
    for (const [k, v] of Object.entries(stats.by_carrier).sort((a, b) => b[1] - a[1])) {
        log(`  ${k}: ${v}`);
    }
    log('');
    log('By rate card era:');
    for (const [k, v] of Object.entries(stats.by_era).sort()) {
        log(`  ${k}: ${v}`);
    }
    log('════════════════════════════════════');
}

main().catch(e => { console.error(e); process.exit(1); });
