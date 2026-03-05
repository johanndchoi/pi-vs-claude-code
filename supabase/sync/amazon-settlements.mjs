#!/usr/bin/env node

/**
 * Amazon Settlement Reports → Supabase channel_fees
 * Downloads settlement reports from SP-API and imports fees per order.
 *
 * Usage:
 *   node amazon-settlements.mjs              # Process unimported settlements
 *   node amazon-settlements.mjs --all        # Re-process all available
 *   node amazon-settlements.mjs --recent 5   # Last N reports
 */

import { readFileSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const RECENT = parseInt(args[args.indexOf('--recent') + 1]) || 20;

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
const LWA_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials"', { encoding: 'utf8' }).trim();
const LWA_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret"', { encoding: 'utf8' }).trim();
const REFRESH_TOKEN = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken"', { encoding: 'utf8' }).trim();

const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const CURSOR_FILE = join(__dirname, '..', '.locks', 'amazon-settlements.cursor');

const stats = { reports: 0, fees_created: 0, fees_skipped: 0, orders_matched: 0, orders_unmatched: 0, errors: 0 };
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
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

async function spApiGet(path) {
    const token = await getToken();
    const res = await fetch(`${SP_API_BASE}${path}`, { headers: { 'x-amz-access-token': token } });
    if (res.status === 429) { await sleep(10000); return spApiGet(path); }
    if (!res.ok) throw new Error(`SP-API ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Cursor ──────────────────────────────────────────────────────────
function loadCursor() {
    try { return readFileSync(CURSOR_FILE, 'utf8').trim(); } catch { return null; }
}
function saveCursor(id) {
    mkdirSync(dirname(CURSOR_FILE), { recursive: true });
    writeFileSync(CURSOR_FILE, id);
}

// ─── Supabase helpers ────────────────────────────────────────────────
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

async function findOrderId(orderNumber) {
    const res = await fetch(`${SUPA_URL}/rest/v1/orders?order_number=eq.${orderNumber}&select=id`, { headers: supaHeaders });
    const rows = await res.json();
    return rows?.[0]?.id || null;
}

async function upsertFee(data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/channel_fees`, {
        method: 'POST',
        headers: {
            ...supaHeaders,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(data)
    });
    if (res.ok) return true;
    const body = await res.text();
    if (body.includes('23505') || body.includes('duplicate')) { stats.fees_skipped++; return true; }
    stats.errors++;
    return false;
}

// ─── Parse settlement TSV ────────────────────────────────────────────
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

// ─── Process one settlement report ───────────────────────────────────
async function processReport(reportId) {
    log(`  Processing report ${reportId}...`);

    const report = await spApiGet(`/reports/2021-06-30/reports/${reportId}`);
    const docId = report.reportDocumentId;
    if (!docId) { log(`    No document for report ${reportId}`); return; }

    const doc = await spApiGet(`/reports/2021-06-30/documents/${docId}`);
    const tsvRes = await fetch(doc.url);
    const tsv = await tsvRes.text();
    const rows = parseSettlement(tsv);
    const settlementId = rows[0]?.['settlement-id'] || reportId;

    log(`    ${rows.length} rows, settlement ${settlementId}`);

    // Group fees by order (skip item_price — that's revenue, not a fee)
    const orderCache = {};
    let created = 0;
    for (const row of rows) {
        const orderNum = row['order-id'];
        if (!orderNum) continue;

        const feeType = mapFeeType(row['amount-type'], row['amount-description']);
        // Only import actual fees, not revenue/tax lines
        if (feeType === 'item_price' || feeType === 'shipping_price' || feeType === 'tax_collected' || feeType === 'tax_withheld') continue;

        const amount = Math.abs(parseFloat(row['amount']) || 0);
        if (amount === 0) continue;

        // Lookup order_id (cached)
        if (orderCache[orderNum] === undefined) {
            orderCache[orderNum] = await findOrderId(orderNum);
        }
        const orderId = orderCache[orderNum];
        if (!orderId) { stats.orders_unmatched++; continue; }
        stats.orders_matched++;

        const externalRef = `${settlementId}-${orderNum}-${row['order-item-code']}-${row['amount-description']}`;

        await upsertFee({
            order_id: orderId,
            channel_id: AMAZON_CHANNEL_ID,
            fee_type: feeType,
            description: row['amount-description'] || feeType,
            amount,
            currency_code: row['currency'] || 'USD',
            incurred_at: row['posted-date-time'] || row['posted-date'] || null,
            external_ref: externalRef,
            metadata: {
                settlement_id: settlementId,
                sku: row['sku'] || null,
                order_item_code: row['order-item-code'] || null,
                fulfillment_id: row['fulfillment-id'] || null
            }
        });
        created++;
    }

    const matched = new Set(Object.entries(orderCache).filter(([,v]) => v).map(([k]) => k)).size;
    log(`    Created ${created} fees, ${matched} orders matched`);
    stats.reports++;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Amazon settlement import starting');

    // List available reports
    const reportsData = await spApiGet(
        `/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&pageSize=${RECENT}`
    );
    const reports = reportsData.reports?.filter(r => r.processingStatus === 'DONE') || [];
    log(`Found ${reports.length} settlement reports`);

    // Filter to unprocessed
    const lastProcessed = !ALL && loadCursor();
    let toProcess = reports;
    if (lastProcessed) {
        const idx = reports.findIndex(r => r.reportId === lastProcessed);
        if (idx >= 0) {
            toProcess = reports.slice(0, idx);
            log(`  ${toProcess.length} new since last run`);
        }
    }

    if (toProcess.length === 0) {
        log('  No new reports to process');
        return;
    }

    // Process oldest first
    for (const report of toProcess.reverse()) {
        try {
            await processReport(report.reportId);
            await sleep(2000);
        } catch (e) {
            log(`  ⚠ Report ${report.reportId}: ${e.message}`);
            stats.errors++;
        }
    }

    // Save cursor
    if (reports.length > 0) {
        saveCursor(reports[0].reportId);
    }

    log('────────────────────────────────────');
    log(`Done! Reports: ${stats.reports}`);
    log(`  Fees created:     ${stats.fees_created + stats.fees_skipped}`);
    log(`  Fees deduplicated: ${stats.fees_skipped}`);
    log(`  Orders matched:   ${stats.orders_matched}`);
    log(`  Orders unmatched: ${stats.orders_unmatched}`);
    log(`  Errors:           ${stats.errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
