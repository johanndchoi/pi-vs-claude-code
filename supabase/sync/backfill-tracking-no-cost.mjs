#!/usr/bin/env node

/**
 * Backfill label_cost for 228 shipments that have tracking but no label_cost.
 *
 * Strategy:
 *   1. Try matching against ShipStation CSV by order number → get actual cost/weight
 *   2. For USPS shipments ordered before Apr 15 2024 → use third-party rate card
 *   3. For OnTrac shipments → use OnTrac rate model derived from ShipStation data
 *   4. For Buy Shipping → use Amazon Buy Shipping known rates
 *   5. Remaining → log for manual review
 *
 * OnTrac rate model (from 1098 ShipStation entries):
 *   0-2 lbs: $10.86 | 2-4 lbs: $9.15 | 4-7 lbs: $9.97
 *   7-10 lbs: $11.32 | 10-15 lbs: $13.78
 *
 * Usage:
 *   node backfill-tracking-no-cost.mjs             # Full run
 *   node backfill-tracking-no-cost.mjs --dry-run   # Preview only
 */

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createReadStream } from 'fs';
import { createInterface } from 'readline';

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

// ─── OnTrac Rate Model (derived from ShipStation data, 1098 entries) ─────
const ONTRAC_RATES = [
    [2, 10.86],   // 0-2 lbs: avg $10.86 (n=4)
    [4, 9.15],    // 2-4 lbs: avg $9.15 (n=72)
    [7, 9.97],    // 4-7 lbs: avg $9.97 (n=161)
    [10, 11.32],  // 7-10 lbs: avg $11.32 (n=854)
    [15, 13.78],  // 10-15 lbs: avg $13.78 (n=7)
    [20, 16.00],  // 15-20 lbs: extrapolated
    [Infinity, 20.00], // 20+ lbs: extrapolated
];

function ontracCost(weightLbs) {
    for (const [maxLbs, price] of ONTRAC_RATES) {
        if (weightLbs <= maxLbs) return price;
    }
    return 20.00;
}

// ─── Amazon Buy Shipping Rate Model (from ShipStation, 4797 entries) ─
const BUY_SHIPPING_RATES = [
    [1, 4.83],    // 0-1 lbs: avg $4.83 (n=702)
    [2, 9.03],    // 1-2 lbs: avg $9.03 (n=43)
    [4, 7.78],    // 2-4 lbs: avg $7.78 (n=1082)
    [7, 8.14],    // 4-7 lbs: avg $8.14 (n=636)
    [10, 10.60],  // 7-10 lbs: avg $10.60 (n=2081)
    [15, 20.45],  // 10-15 lbs: avg $20.45 (n=28)
    [Infinity, 21.37], // 15+ lbs: avg $21.37 (n=225)
];

function buyShippingCost(weightLbs) {
    for (const [maxLbs, price] of BUY_SHIPPING_RATES) {
        if (weightLbs <= maxLbs) return price;
    }
    return 21.37;
}

// ─── SKU weight overrides for variants with 0 weight_oz ─────────────
const SKU_WEIGHT_OVERRIDES = {
    'OL_TCS_DB1': 3.0,  // Single sleeve, same as OL_TCS_WG1
    'OL_TCS_TB1': 3.0,  // Single sleeve, same as OL_TCS_WG1
    'FB-NEE4-QHZS': 6.0, // Estimated small item weight
};

// ─── Third-party rate cards (from backfill-ratecard.mjs) ──────────
const RATE_CARDS = [
    {
        start: '2023-01-26', end: '2023-08-12',
        usps_priority: [[4, 6.40], [7, 8.00], [10, 9.00], [12, 10.00], [15, 12.00], [18, 15.00], [25, 18.00], [Infinity, 20.00]],
        ups_ground: 12.00,
    },
    {
        start: '2023-08-13', end: '2024-01-01',
        usps_priority: [[4, 5.80], [7, 6.70], [10, 8.00], [12, 9.00], [15, 11.00], [18, 14.00], [25, 16.00], [Infinity, 18.00]],
        ups_ground: 12.00,
    },
    {
        start: '2024-01-02', end: '2024-04-15',
        usps_priority: [[4, 5.80], [7, 6.70], [10, 8.00], [12, 9.00], [15, 11.00], [18, 14.00], [25, 16.00], [Infinity, 18.00]],
        ups_ground: 12.00,
        ground_advantage: [[0.9375, 3.40], [10, 7.00]],
    },
];

function getRateCard(orderDate) {
    const d = orderDate.slice(0, 10);
    for (const card of RATE_CARDS) {
        if (d >= card.start && d <= card.end) return card;
    }
    return null;
}

function ratecardCost(weightLbs, card) {
    if (!card) return null;
    if (weightLbs > 15 && card.ups_ground) return { cost: card.ups_ground, carrier: 'UPS', service: 'Ground' };
    if (card.ground_advantage) {
        for (const [maxLbs, price] of card.ground_advantage) {
            if (weightLbs <= maxLbs) return { cost: price, carrier: 'USPS', service: 'Ground Advantage' };
        }
    }
    if (card.usps_priority) {
        for (const [maxLbs, price] of card.usps_priority) {
            if (weightLbs <= maxLbs) return { cost: price, carrier: 'USPS', service: 'Priority' };
        }
    }
    return null;
}

// ─── Parse ShipStation CSV ───────────────────────────────────────────
async function loadShipStationCSV() {
    const ssPath = join(process.env.HOME, 'Downloads', 'Shipping Data (2).csv');
    const map = new Map(); // order# → { cost, weight_oz, provider, service }

    const rl = createInterface({ input: createReadStream(ssPath, 'utf8') });
    let first = true;
    for await (const line of rl) {
        if (first) { first = false; continue; }
        // Simple CSV parse (fields are quoted)
        const fields = line.match(/(".*?"|[^,]*),?/g)?.map(f => f.replace(/,?$/, '').replace(/^"|"$/g, '')) || [];
        const orderNum = fields[2]?.trim();
        const provider = fields[3]?.trim();
        const service = fields[4]?.trim();
        const cost = parseFloat(fields[9]) || 0;
        const weight = parseFloat(fields[11]) || 0;
        const weightUnit = fields[12]?.trim();
        const weightOz = weightUnit === 'Pound' ? weight * 16 : weight;

        if (orderNum && cost > 0) {
            map.set(orderNum, { cost, weight_oz: weightOz, provider, service });
        }
    }
    return map;
}

// ─── Parse missing-cost CSV ─────────────────────────────────────────
function loadMissingCSV() {
    const csv = readFileSync(join(__dirname, '..', 'shipments-missing-cost.csv'), 'utf8');
    const lines = csv.trim().split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        rows.push({
            order_number: parts[0],
            sku: parts[1],
            tracking_number: parts[2],
            carrier: parts[3],
            shipped_at: parts[4],
            ordered_at: parts[5],
        });
    }
    return rows;
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

async function supaPatch(table, matchCol, matchVal, data) {
    if (DRY_RUN) return true;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}?${matchCol}=eq.${encodeURIComponent(matchVal)}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(data),
    });
    if (!res.ok) {
        const err = await res.text();
        throw new Error(`PATCH ${res.status}: ${err}`);
    }
    return true;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Backfill label_cost for shipments with tracking but no cost');
    if (DRY_RUN) log('*** DRY RUN ***');

    // 1. Load ShipStation CSV
    log('Loading ShipStation CSV...');
    const ssData = await loadShipStationCSV();
    log(`  ${ssData.size} orders with costs in ShipStation`);

    // 2. Load missing-cost CSV
    log('Loading missing-cost CSV...');
    const missing = loadMissingCSV();
    log(`  ${missing.length} shipments missing cost`);

    // 3. Load product variant weights for weight computation
    log('Loading product variant weights...');
    const variantWeights = {};
    let offset = 0;
    while (true) {
        const { data } = await supaGet(`product_variants?select=id,sku,weight_oz&limit=1000&offset=${offset}`);
        for (const v of data) {
            variantWeights[v.id] = v.weight_oz || 0;
            if (v.sku) variantWeights[`sku:${v.sku}`] = v.weight_oz || 0;
        }
        if (data.length < 1000) break;
        offset += 1000;
    }
    log(`  ${Object.keys(variantWeights).length} variant weights loaded`);

    // 4. Look up shipment IDs and order_ids from Supabase by tracking number
    log('Loading shipment records from Supabase...');
    const shipmentsByTracking = {};
    const trackingNumbers = [...new Set(missing.map(m => m.tracking_number).filter(Boolean))];
    for (let i = 0; i < trackingNumbers.length; i += 50) {
        const batch = trackingNumbers.slice(i, i + 50);
        const inf = batch.map(t => `"${t}"`).join(',');
        const { data } = await supaGet(
            `shipments?tracking_number=in.(${inf})&is_voided=eq.false&select=id,order_id,tracking_number,label_cost,carrier_name,carrier_service,weight_oz&limit=1000`
        );
        for (const s of data) {
            shipmentsByTracking[s.tracking_number] = s;
        }
    }
    log(`  ${Object.keys(shipmentsByTracking).length} shipments found by tracking number`);

    // 5. Load order items for weight computation
    log('Loading order items for weight computation...');
    const orderIds = [...new Set(Object.values(shipmentsByTracking).map(s => s.order_id).filter(Boolean))];
    const orderWeights = {};
    for (let i = 0; i < orderIds.length; i += 50) {
        const batch = orderIds.slice(i, i + 50);
        const inf = batch.map(id => `"${id}"`).join(',');
        const { data } = await supaGet(`order_items?order_id=in.(${inf})&select=order_id,variant_id,quantity`);
        for (const item of data) {
            const wt = variantWeights[item.variant_id] || 0;
            orderWeights[item.order_id] = (orderWeights[item.order_id] || 0) + wt * (item.quantity || 1);
        }
    }
    log(`  Weights computed for ${Object.keys(orderWeights).length} orders`);

    // 6. Process each missing shipment
    const stats = {
        ss_matched: 0,
        ratecard_applied: 0,
        ontrac_estimated: 0,
        already_has_cost: 0,
        no_tracking: 0,
        no_shipment_found: 0,
        no_weight: 0,
        manual_review: 0,
        errors: 0,
        total_cost: 0,
        updated: 0,
    };
    const manualReview = [];
    const updates = [];

    for (const row of missing) {
        if (!row.tracking_number) {
            stats.no_tracking++;
            manualReview.push({ ...row, reason: 'no tracking number' });
            continue;
        }

        const shipment = shipmentsByTracking[row.tracking_number];
        if (!shipment) {
            stats.no_shipment_found++;
            manualReview.push({ ...row, reason: 'shipment not found in DB by tracking' });
            continue;
        }

        if (shipment.label_cost && shipment.label_cost > 0) {
            stats.already_has_cost++;
            continue;
        }

        const orderId = shipment.order_id;
        const weightOz = orderWeights[orderId] || 0;
        const weightLbs = weightOz / 16;

        // Strategy 1: ShipStation CSV match
        const ssMatch = ssData.get(row.order_number);
        if (ssMatch) {
            const update = {
                label_cost: ssMatch.cost,
                total_cost: ssMatch.cost,
                weight_oz: ssMatch.weight_oz || (weightOz > 0 ? Math.round(weightOz * 10) / 10 : null),
                data_source: 'shipstation',
                label_source: 'shipstation',
            };
            // Map ShipStation provider to our carrier_name
            if (ssMatch.provider) update.carrier_name = ssMatch.provider;
            if (ssMatch.service) update.carrier_service = ssMatch.service;
            updates.push({ shipmentId: shipment.id, update, source: 'shipstation', row });
            stats.ss_matched++;
            stats.total_cost += ssMatch.cost;
            continue;
        }

        // Strategy 2: USPS/UPS ordered before Apr 15 2024 → rate card
        if ((row.carrier === 'USPS' || row.carrier === 'UPS') && row.ordered_at) {
            const card = getRateCard(row.ordered_at);
            let effectiveWeightOz2 = weightOz;
            if (effectiveWeightOz2 <= 0 && SKU_WEIGHT_OVERRIDES[row.sku]) {
                effectiveWeightOz2 = SKU_WEIGHT_OVERRIDES[row.sku];
            }
            const effectiveWeightLbs2 = effectiveWeightOz2 / 16;
            if (card && effectiveWeightOz2 > 0) {
                const result = ratecardCost(effectiveWeightLbs2, card);
                if (result) {
                    const update = {
                        label_cost: result.cost,
                        total_cost: result.cost,
                        carrier_name: result.carrier,
                        carrier_service: result.service,
                        weight_oz: Math.round(effectiveWeightOz2 * 10) / 10,
                        data_source: 'manual',
                        label_source: 'manual',
                    };
                    updates.push({ shipmentId: shipment.id, update, source: 'ratecard', row });
                    stats.ratecard_applied++;
                    stats.total_cost += result.cost;
                    continue;
                }
            }
        }

        // Strategy 3: OnTrac → estimated cost from rate model
        if (row.carrier === 'OnTrac') {
            // Try SKU weight override if no computed weight
            let effectiveWeightOz = weightOz;
            if (effectiveWeightOz <= 0 && SKU_WEIGHT_OVERRIDES[row.sku]) {
                effectiveWeightOz = SKU_WEIGHT_OVERRIDES[row.sku];
            }
            if (effectiveWeightOz <= 0) {
                stats.no_weight++;
                manualReview.push({ ...row, shipmentId: shipment.id, reason: 'OnTrac but no weight computable' });
                continue;
            }
            const cost = ontracCost(effectiveWeightOz / 16);
            const update = {
                label_cost: cost,
                total_cost: cost,
                carrier_name: 'OnTrac',
                carrier_service: 'Ground',
                weight_oz: Math.round(effectiveWeightOz * 10) / 10,
                data_source: 'manual',
                label_source: 'shipstation', // OnTrac labels were purchased via ShipStation
            };
            updates.push({ shipmentId: shipment.id, update, source: 'ontrac_estimate', row });
            stats.ontrac_estimated++;
            stats.total_cost += cost;
            continue;
        }

        // Strategy 4: Buy Shipping / Other (C122* tracking = Amazon Buy Shipping)
        if (row.carrier === 'Buy Shipping' || row.carrier === 'Other') {
            // Try SKU weight override if no computed weight
            let effectiveWeightOz = weightOz;
            if (effectiveWeightOz <= 0 && SKU_WEIGHT_OVERRIDES[row.sku]) {
                effectiveWeightOz = SKU_WEIGHT_OVERRIDES[row.sku];
            }
            if (effectiveWeightOz <= 0) {
                stats.no_weight++;
                manualReview.push({ ...row, shipmentId: shipment.id, reason: `${row.carrier} but no weight computable` });
                continue;
            }
            const effectiveWeightLbs = effectiveWeightOz / 16;
            const cost = buyShippingCost(effectiveWeightLbs);
            const update = {
                label_cost: cost,
                total_cost: cost,
                carrier_name: 'Amazon Buy Shipping',
                carrier_service: effectiveWeightLbs <= 1 ? 'FCM' : 'Ground',
                weight_oz: Math.round(effectiveWeightOz * 10) / 10,
                data_source: 'manual',
                label_source: 'amazon_buy_shipping',
            };
            updates.push({ shipmentId: shipment.id, update, source: 'buy_shipping_estimate', row });
            stats.buy_shipping_estimated = (stats.buy_shipping_estimated || 0) + 1;
            stats.total_cost += cost;
            continue;
        }

        // Strategy 5: UPS → estimate from ShipStation UPS rates
        if (row.carrier === 'UPS') {
            let effectiveWeightOz = weightOz;
            if (effectiveWeightOz <= 0 && SKU_WEIGHT_OVERRIDES[row.sku]) {
                effectiveWeightOz = SKU_WEIGHT_OVERRIDES[row.sku];
            }
            if (effectiveWeightOz <= 0) {
                stats.no_weight++;
                manualReview.push({ ...row, shipmentId: shipment.id, reason: 'UPS but no weight computable' });
                continue;
            }
            // UPS Ground avg from ShipStation: ~$12 for typical weights
            const cost = 12.00;
            const update = {
                label_cost: cost,
                total_cost: cost,
                carrier_name: 'UPS',
                carrier_service: 'Ground',
                weight_oz: Math.round(effectiveWeightOz * 10) / 10,
                data_source: 'manual',
                label_source: 'shipstation',
            };
            updates.push({ shipmentId: shipment.id, update, source: 'ups_estimate', row });
            stats.ups_estimated = (stats.ups_estimated || 0) + 1;
            stats.total_cost += cost;
            continue;
        }

        // Strategy 6: remaining → manual review
        stats.manual_review++;
        manualReview.push({ ...row, shipmentId: shipment.id, weightOz, reason: `${row.carrier} - no matching strategy` });
    }

    // 7. Apply updates
    log(`\nApplying ${updates.length} updates...`);
    for (let i = 0; i < updates.length; i++) {
        const { shipmentId, update, source, row } = updates[i];
        try {
            await supaPatch('shipments', 'id', shipmentId, update);
            stats.updated++;
            if (stats.updated % 50 === 0) log(`  Progress: ${stats.updated}/${updates.length}`);
        } catch (e) {
            stats.errors++;
            log(`  ⚠ Error updating ${shipmentId} (${row.order_number}): ${e.message}`);
        }
    }

    // 8. Summary
    log('\n════════════════════════════════════════════════════════');
    log('Backfill complete!');
    log(`  Total missing:         ${missing.length}`);
    log(`  ShipStation matched:   ${stats.ss_matched}`);
    log(`  Rate card applied:     ${stats.ratecard_applied}`);
    log(`  OnTrac estimated:      ${stats.ontrac_estimated}`);
    log(`  Buy Shipping est:     ${stats.buy_shipping_estimated || 0}`);
    log(`  UPS estimated:         ${stats.ups_estimated || 0}`);
    log(`  Already had cost:      ${stats.already_has_cost}`);
    log(`  No tracking:           ${stats.no_tracking}`);
    log(`  No shipment in DB:     ${stats.no_shipment_found}`);
    log(`  No weight (OnTrac):    ${stats.no_weight}`);
    log(`  Manual review needed:  ${stats.manual_review}`);
    log(`  Errors:                ${stats.errors}`);
    log(`  Successfully updated:  ${stats.updated}`);
    log(`  Total cost backfilled: $${stats.total_cost.toFixed(2)}`);
    log('════════════════════════════════════════════════════════');

    // 9. Log manual review items
    if (manualReview.length > 0) {
        log(`\n── Manual Review (${manualReview.length} items) ──`);
        const byReason = {};
        for (const item of manualReview) {
            byReason[item.reason] = byReason[item.reason] || [];
            byReason[item.reason].push(item);
        }
        for (const [reason, items] of Object.entries(byReason)) {
            log(`\n${reason} (${items.length}):`);
            for (const item of items.slice(0, 10)) {
                log(`  ${item.order_number} | ${item.carrier} | ${item.sku} | shipped ${item.shipped_at?.slice(0, 10) || '?'} | ordered ${item.ordered_at?.slice(0, 10) || '?'}`);
            }
            if (items.length > 10) log(`  ... and ${items.length - 10} more`);
        }
    }

    // 10. Write updates summary by source
    log('\n── Updates by source ──');
    const bySource = {};
    for (const u of updates) {
        bySource[u.source] = (bySource[u.source] || 0) + 1;
    }
    for (const [source, count] of Object.entries(bySource)) {
        log(`  ${source}: ${count}`);
    }
}

main().catch(e => { console.error(e); process.exit(1); });
