#!/usr/bin/env node

/**
 * Backfill Amazon settlement fees for orders missing channel_fees.
 *
 * Root cause: amazon-settlements.mjs only fetches last 20 reports per run,
 * and the settlement reports for Oct-Dec 2025 were generated later (Dec 2025/Jan 2026),
 * so the cursor-based import skipped them — creating a ~3 month gap.
 *
 * This script targets specific report IDs covering the gap periods.
 *
 * Usage:
 *   node backfill-amazon-fees.mjs              # Import gap settlements
 *   node backfill-amazon-fees.mjs --dry-run    # Show what would be imported
 */

import { readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

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

const OP_PREFIX = 'op://Agents Service Accounts/Amazon SP-API Credentials';
const LWA_CLIENT_ID = execSync(`op read "${OP_PREFIX}/LWACredentials"`, { encoding: 'utf8' }).trim();
const LWA_CLIENT_SECRET = execSync(`op read "${OP_PREFIX}/ClientSecret"`, { encoding: 'utf8' }).trim();
const REFRESH_TOKEN = execSync(`op read "${OP_PREFIX}/SellerRefreshToken"`, { encoding: 'utf8' }).trim();

const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

// Reports covering the gap period (Oct 28 2025 → Jan 28 2026)
// Plus re-process recent reports that may have had partial imports
// Identified from SP-API listing — V2 report IDs sorted by start date
const GAP_REPORTS = [
    // Gap: Oct 28 → Nov 25 (no reports exist for this period)
    // Gap covered by these Dec/Jan reports:
    { id: '1185517020431', range: '2025-11-25 → 2025-12-09' },
    { id: '1190745020445', range: '2025-12-09 → 2025-12-23' },
    { id: '1193530020452', range: '2025-12-23 → 2025-12-30' },
    { id: '1193901020453', range: '2025-12-03 → 2025-12-31' },
    { id: '1195741020458', range: '2025-12-30 → 2026-01-05' },
    { id: '1198601020465', range: '2026-01-05 → 2026-01-12' },
    { id: '1199344020467', range: '2025-12-31 → 2026-01-14' },
    { id: '1201384020472', range: '2026-01-12 → 2026-01-19' },
    { id: '1203578020477', range: '2026-01-19 → 2026-01-24' },
    { id: '1205561020481', range: '2026-01-14 → 2026-01-28' },
    // Also re-process recent reports (Jan-Feb 2026) for completeness
    { id: '1207689020486', range: '2026-01-24 → 2026-02-02' },
    { id: '1208396020488', range: '2026-02-02 → 2026-02-04' },
    { id: '1208911020490', range: '2026-02-04 → 2026-02-06' },
    { id: '1209356020491', range: '2026-02-06 → 2026-02-07' },
    { id: '1211064020495', range: '2026-01-28 → 2026-02-11' },
    { id: '1211932020497', range: '2026-02-07 → 2026-02-13' },
    { id: '1213459020501', range: '2026-02-13 → 2026-02-17' },
    { id: '1215802020507', range: '2026-02-17 → 2026-02-23' },
    { id: '1215805020507', range: '2026-02-11 → 2026-02-23' },
    { id: '1216273020509', range: '2026-02-23 → 2026-02-25' },
    { id: '1217509020512', range: '2026-02-25 → 2026-02-27' },
];

const stats = {
    reports_processed: 0, fees_created: 0, fees_skipped: 0,
    orders_matched: 0, orders_unmatched: 0, errors: 0
};
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Token management ────────────────────────────────────────────────
let accessToken = null, tokenExpiry = 0;
async function getToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}&client_id=${LWA_CLIENT_ID}&client_secret=${LWA_CLIENT_SECRET}`
    });
    const data = await res.json();
    if (!data.access_token) throw new Error(`Token error: ${JSON.stringify(data)}`);
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

async function spApiGet(path, retries = 5) {
    const token = await getToken();
    const res = await fetch(`${SP_API_BASE}${path}`, { headers: { 'x-amz-access-token': token } });
    if (res.status === 429 && retries > 0) {
        log('  ⏳ Rate limited, waiting 30s...');
        await sleep(30000);
        return spApiGet(path, retries - 1);
    }
    if (!res.ok) throw new Error(`SP-API ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Supabase helpers ────────────────────────────────────────────────
const orderCache = {};
async function findOrderId(orderNumber) {
    if (orderCache[orderNumber] !== undefined) return orderCache[orderNumber];
    const res = await fetch(
        `${SUPA_URL}/rest/v1/orders?order_number=eq.${orderNumber}&select=id`,
        { headers: supaHeaders }
    );
    const rows = await res.json();
    orderCache[orderNumber] = rows?.[0]?.id || null;
    return orderCache[orderNumber];
}

async function upsertFee(fee) {
    const res = await fetch(`${SUPA_URL}/rest/v1/channel_fees`, {
        method: 'POST',
        headers: {
            ...supaHeaders,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(fee)
    });
    if (res.ok) { stats.fees_created++; return; }
    const body = await res.text();
    if (body.includes('23505') || body.includes('duplicate')) { stats.fees_skipped++; return; }
    log(`    ⚠ Fee upsert error: ${body.slice(0, 150)}`);
    stats.errors++;
}

// ─── Fee type mapping ────────────────────────────────────────────────
function mapFeeType(amountType, amountDesc) {
    if (amountDesc === 'Commission') return 'marketplace_commission';
    if (amountDesc === 'FBAPerUnitFulfillmentFee') return 'fulfillment_fee';
    if (amountDesc === 'FBAPerOrderFulfillmentFee') return 'fulfillment_fee';
    if (amountDesc === 'ShippingHB') return 'shipping_fee';
    if (amountDesc === 'ShippingChargeback') return 'shipping_chargeback';
    if (amountDesc === 'FixedClosingFee') return 'closing_fee';
    if (amountDesc === 'VariableClosingFee') return 'closing_fee';
    if (amountType === 'Promotion') return 'promotion';
    if (amountType === 'ItemWithheldTax') return 'tax_withheld';
    if (amountType === 'ItemPrice' && amountDesc === 'Tax') return 'tax_collected';
    if (amountType === 'ItemPrice' && amountDesc === 'Principal') return 'item_price';
    if (amountType === 'ItemPrice' && amountDesc === 'Shipping') return 'shipping_price';
    return 'other';
}

function parseSettlement(tsv) {
    const lines = tsv.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split('\t');
    return lines.slice(1).map(line => {
        const vals = line.split('\t');
        const row = {};
        headers.forEach((h, i) => row[h] = vals[i] || '');
        return row;
    });
}

// ─── Process one report ──────────────────────────────────────────────
async function processReport(reportId) {
    const report = await spApiGet(`/reports/2021-06-30/reports/${reportId}`);
    const docId = report.reportDocumentId;
    if (!docId) { log(`    No document`); return; }

    await sleep(3000); // Respect rate limits between API calls
    const doc = await spApiGet(`/reports/2021-06-30/documents/${docId}`);
    const tsvRes = await fetch(doc.url);
    const tsv = await tsvRes.text();
    const rows = parseSettlement(tsv);
    const settlementId = rows[0]?.['settlement-id'] || reportId;

    let created = 0;
    const matchedOrders = new Set();
    const unmatchedOrders = new Set();

    for (const row of rows) {
        const orderNum = row['order-id'];
        if (!orderNum) continue;

        const feeType = mapFeeType(row['amount-type'], row['amount-description']);
        if (['item_price', 'shipping_price', 'tax_collected', 'tax_withheld'].includes(feeType)) continue;

        const amount = Math.abs(parseFloat(row['amount']) || 0);
        if (amount === 0) continue;

        const orderId = await findOrderId(orderNum);
        if (!orderId) { unmatchedOrders.add(orderNum); stats.orders_unmatched++; continue; }
        matchedOrders.add(orderNum);
        stats.orders_matched++;

        if (!DRY_RUN) {
            await upsertFee({
                order_id: orderId,
                channel_id: AMAZON_CHANNEL_ID,
                fee_type: feeType,
                description: row['amount-description'] || feeType,
                amount,
                currency_code: row['currency'] || 'USD',
                incurred_at: row['posted-date-time'] || row['posted-date'] || null,
                external_ref: `${settlementId}-${orderNum}-${row['order-item-code']}-${row['amount-description']}`,
                metadata: {
                    settlement_id: settlementId,
                    sku: row['sku'] || null,
                    order_item_code: row['order-item-code'] || null,
                    fulfillment_id: row['fulfillment-id'] || null
                }
            });
            created++;
        }
    }

    log(`    Settlement ${settlementId}: ${rows.length} rows → ${created} fees upserted, ${matchedOrders.size} orders matched, ${unmatchedOrders.size} unmatched`);
    stats.reports_processed++;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Amazon settlement fee backfill — targeted gap period');
    if (DRY_RUN) log('  *** DRY RUN ***');
    log(`  Processing ${GAP_REPORTS.length} reports covering 2025-11-25 → 2026-02-27\n`);

    for (let i = 0; i < GAP_REPORTS.length; i++) {
        const { id, range } = GAP_REPORTS[i];
        log(`[${i + 1}/${GAP_REPORTS.length}] Report ${id} (${range})`);
        try {
            await processReport(id);
            await sleep(5000); // Extra delay to avoid rate limits
        } catch (e) {
            log(`  ⚠ Error: ${e.message.slice(0, 200)}`);
            stats.errors++;
            if (e.message.includes('429')) await sleep(60000);
        }
    }

    log('\n════════════════════════════════════');
    log('Backfill complete!');
    log(`  Reports processed:  ${stats.reports_processed}`);
    log(`  Fees created:       ${stats.fees_created}`);
    log(`  Fees deduplicated:  ${stats.fees_skipped}`);
    log(`  Orders matched:     ${stats.orders_matched}`);
    log(`  Orders unmatched:   ${stats.orders_unmatched}`);
    log(`  Errors:             ${stats.errors}`);

    const outPath = join(__dirname, '..', 'backfill-results.json');
    writeFileSync(outPath, JSON.stringify(stats, null, 2));
    log(`\nResults saved to ${outPath}`);
}

main().catch(e => { console.error(e); process.exit(1); });
