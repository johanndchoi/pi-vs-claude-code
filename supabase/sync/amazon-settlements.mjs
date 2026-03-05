#!/usr/bin/env node

/**
 * Amazon SP-API Settlement Reports → Supabase channel_fees
 *
 * Downloads settlement reports from Amazon SP-API, parses the flat file,
 * and upserts fee rows into channel_fees with order matching.
 *
 * Usage:
 *   node amazon-settlements.mjs                    # Fetch new settlement reports
 *   node amazon-settlements.mjs --backfill         # Re-download all available reports
 *   node amazon-settlements.mjs --rematch          # Re-match null order_id rows
 *   node amazon-settlements.mjs --report-id <id>   # Process specific report
 *   node amazon-settlements.mjs --dry-run           # Preview only
 *   node amazon-settlements.mjs --analyze           # Analyze gaps without fetching
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createGunzip } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const BACKFILL = args.includes('--backfill');
const REMATCH = args.includes('--rematch');
const ANALYZE = args.includes('--analyze');
const SPECIFIC_REPORT = args.find((_, i) => args[i - 1] === '--report-id');
const FILL_GAPS = args.includes('--fill-gaps');
const CURSOR_DIR = join(__dirname, '..', '.locks');

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

const CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';

// Amazon SP-API creds from 1Password
const AMZ_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials"',
    { encoding: 'utf8', env: { ...process.env } }).trim();
const AMZ_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret"',
    { encoding: 'utf8', env: { ...process.env } }).trim();
const AMZ_REFRESH_TOKEN = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken"',
    { encoding: 'utf8', env: { ...process.env } }).trim();
const AMZ_MARKETPLACE_ID = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/MarketplaceId"',
    { encoding: 'utf8', env: { ...process.env } }).trim();

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    reports_found: 0,
    reports_processed: 0,
    reports_skipped: 0,
    fee_rows_parsed: 0,
    fee_rows_inserted: 0,
    fee_rows_skipped_dup: 0,
    orders_matched: 0,
    orders_unmatched: 0,
    rematched: 0,
    errors: 0,
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Amazon SP-API Auth (LWA) ───────────────────────────────────────
let accessToken = null;
let tokenExpiry = 0;

async function getAccessToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;

    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: AMZ_REFRESH_TOKEN,
            client_id: AMZ_CLIENT_ID,
            client_secret: AMZ_CLIENT_SECRET,
        }),
    });
    if (!res.ok) throw new Error(`LWA auth failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

// ─── SP-API helpers ──────────────────────────────────────────────────
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';

async function spApiGet(path, retries = 5) {
    const url = `${SP_API_BASE}${path}`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        const token = await getAccessToken();
        const res = await fetch(url, {
            headers: {
                'x-amz-access-token': token,
                'Content-Type': 'application/json',
            },
        });

        if (res.status === 429) {
            // SP-API document endpoints have strict rate limits (1 req/sec burst)
            const wait = Math.min(5 * attempt, 60);
            log(`  ⏳ Rate limited (429), waiting ${wait}s (attempt ${attempt}/${retries})...`);
            await sleep(wait * 1000);
            continue;
        }
        if (res.status === 403) {
            // Token might be expired, refresh
            accessToken = null;
            continue;
        }
        if (!res.ok) {
            const body = await res.text();
            if (attempt < retries) {
                log(`  ⚠ SP-API ${res.status}, retrying in ${attempt * 3}s...`);
                await sleep(attempt * 3000);
                continue;
            }
            throw new Error(`SP-API ${res.status}: ${body.slice(0, 500)}`);
        }
        return res.json();
    }
    throw new Error(`SP-API: exhausted ${retries} retries for ${path}`);
}

// ─── List settlement reports ─────────────────────────────────────────
async function listSettlementReports() {
    const reports = [];
    let nextToken = null;

    // Use V2 if available, fall back to V1
    const reportTypes = [
        'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2',
        'GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE',
    ];

    for (const reportType of reportTypes) {
        nextToken = null;
        let page = 0;
        while (true) {
            page++;
            let path = `/reports/2021-06-30/reports?reportTypes=${reportType}&pageSize=100&marketplaceIds=${AMZ_MARKETPLACE_ID}`;
            if (nextToken) path += `&nextToken=${encodeURIComponent(nextToken)}`;

            try {
                const data = await spApiGet(path);
                const batch = data.reports || [];
                reports.push(...batch);
                log(`  ${reportType} page ${page}: ${batch.length} reports (total: ${reports.length})`);

                nextToken = data.nextToken;
                if (!nextToken || batch.length === 0) break;
                await sleep(2000); // Respect rate limits between pages
            } catch (e) {
                if (e.message.includes('404') || e.message.includes('InvalidInput')) {
                    log(`  ${reportType}: not available, trying next type`);
                    break;
                }
                // On rate limit / transient error during pagination, wait and retry
                log(`  ⚠ Pagination error on page ${page}: ${e.message.slice(0, 100)}`);
                if (page > 1) {
                    log(`  Got ${reports.length} reports so far, continuing with what we have`);
                    break;
                }
                throw e;
            }
        }
        if (reports.length > 0) {
            log(`Found ${reports.length} reports of type ${reportType}`);
            break; // Use whichever type returned results
        }
    }

    return reports;
}

// ─── Download and parse a settlement report ──────────────────────────
async function downloadReport(reportDocumentId) {
    const docData = await spApiGet(`/reports/2021-06-30/documents/${reportDocumentId}`);
    if (!docData || !docData.url) {
        throw new Error(`No download URL in document response: ${JSON.stringify(docData).slice(0, 200)}`);
    }
    const url = docData.url;
    const compressionAlgo = docData.compressionAlgorithm;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);

    let text;
    if (compressionAlgo === 'GZIP') {
        const buffer = Buffer.from(await res.arrayBuffer());
        text = await new Promise((resolve, reject) => {
            const chunks = [];
            const gunzip = createGunzip();
            gunzip.on('data', c => chunks.push(c));
            gunzip.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            gunzip.on('error', reject);
            gunzip.end(buffer);
        });
    } else {
        text = await res.text();
    }

    return text;
}

function parseSettlementTSV(text) {
    const lines = text.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = lines[0].split('\t').map(h => h.trim().toLowerCase().replace(/-/g, '_'));
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split('\t');
        const row = {};
        for (let j = 0; j < headers.length; j++) {
            row[headers[j]] = vals[j]?.trim() || '';
        }
        rows.push(row);
    }
    return rows;
}

// ─── Map settlement rows to channel_fee records ─────────────────────
// Fee types we care about (marketplace fees that come out of seller proceeds)
// fee_type enum only allows: marketplace_commission, other, promotion
const FEE_TYPE_MAP = {
    'Commission': 'marketplace_commission',
    'RefundCommission': 'marketplace_commission',
    'Promotion': 'promotion',
    'PromotionShipping': 'promotion',
    // Everything else → 'other'
};

function mapSettlementRow(row) {
    // Skip non-fee rows (deposits, transfers, etc.)
    const transType = row.transaction_type || '';
    const amountType = row.amount_type || '';
    const amountDesc = row.amount_description || '';
    const amount = parseFloat(row.amount || '0');

    // We want ItemFees, ItemWithheldTax, Promotion, and some ServiceFees
    if (!amountDesc || isNaN(amount) || amount === 0) return null;

    // Skip principal/price rows — we only want fees
    if (amountType === 'ItemPrice' && !amountDesc.includes('Tax')) return null;

    // Map fee type
    let feeType = FEE_TYPE_MAP[amountDesc] || null;
    if (!feeType) {
        if (amountType === 'ItemFees' || amountType === 'ItemWithheldTax') {
            feeType = 'other';
        } else if (amountType === 'Promotion') {
            feeType = 'promotion';
        } else if (amountType === 'OtherFees' || amountType === 'ServiceFee') {
            feeType = 'other';
        } else {
            return null; // Skip price/refund amounts
        }
    }

    const orderNumber = row.order_id || '';
    const settlementId = row.settlement_id || '';
    const orderItemCode = row.order_item_code || '';
    const sku = row.sku || '';
    const postedDate = row.posted_date || row.posted_date_time || '';
    const fulfillmentId = row.fulfillment_id || '';

    // Build unique external_ref for dedup
    const externalRef = `${settlementId}-${orderNumber}-${orderItemCode}-${amountDesc}`;

    return {
        channel_id: CHANNEL_ID,
        fee_type: feeType,
        description: amountDesc,
        amount: Math.abs(amount), // Store as positive (fees are costs)
        currency_code: row.currency || 'USD',
        incurred_at: postedDate ? new Date(postedDate).toISOString() : null,
        external_ref: externalRef,
        metadata: {
            settlement_id: settlementId,
            sku: sku || undefined,
            fulfillment_id: fulfillmentId || undefined,
            order_item_code: orderItemCode || undefined,
            transaction_type: transType || undefined,
            amount_type: amountType || undefined,
            original_amount: amount, // Keep sign for analysis
        },
        _order_number: orderNumber, // Used for matching, not inserted
    };
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaFetch(path, options = {}) {
    const { headers: extraHeaders, ...rest } = options;
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        ...rest,
        headers: {
            apikey: SUPA_KEY,
            Authorization: `Bearer ${SUPA_KEY}`,
            ...extraHeaders,
        },
    });
    return res;
}

async function supaGet(path) {
    const res = await supaFetch(path);
    return res.json();
}

// ─── Build order number → ID map ─────────────────────────────────────
async function buildOrderMap() {
    log('Building order number map...');
    const orderMap = {};
    let offset = 0;
    while (true) {
        const orders = await supaGet(
            `orders?channel_id=eq.${CHANNEL_ID}&select=id,order_number&limit=1000&offset=${offset}`
        );
        if (!orders.length) break;
        for (const o of orders) orderMap[o.order_number] = o.id;
        offset += 1000;
    }
    log(`  ${Object.keys(orderMap).length} Amazon orders loaded`);
    return orderMap;
}

// ─── Get already-imported settlement IDs ─────────────────────────────
async function getImportedSettlementIds() {
    const cursorFile = join(CURSOR_DIR, 'amazon-settlements.json');
    if (existsSync(cursorFile)) {
        try {
            return JSON.parse(readFileSync(cursorFile, 'utf8'));
        } catch {}
    }
    return { processedReportIds: [], lastRun: null };
}

function saveImportedSettlementIds(data) {
    mkdirSync(CURSOR_DIR, { recursive: true });
    writeFileSync(join(CURSOR_DIR, 'amazon-settlements.json'), JSON.stringify(data, null, 2));
}

// ─── Get existing external_refs for dedup ────────────────────────────
async function getExistingRefs(settlementId) {
    const refs = new Set();
    let offset = 0;
    while (true) {
        const rows = await supaGet(
            `channel_fees?channel_id=eq.${CHANNEL_ID}&metadata->>settlement_id=eq.${settlementId}&select=external_ref&limit=1000&offset=${offset}`
        );
        if (!rows.length) break;
        for (const r of rows) refs.add(r.external_ref);
        offset += 1000;
    }
    return refs;
}

// ─── Insert fee rows in batches ──────────────────────────────────────
async function insertFees(fees) {
    const BATCH_SIZE = 200;
    let inserted = 0;

    for (let i = 0; i < fees.length; i += BATCH_SIZE) {
        const batch = fees.slice(i, i + BATCH_SIZE);
        if (DRY_RUN) {
            inserted += batch.length;
            continue;
        }

        const res = await supaFetch('channel_fees', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Prefer: 'return=minimal',
            },
            body: JSON.stringify(batch),
        });

        if (!res.ok) {
            const body = await res.text();
            log(`  ⚠ Batch insert failed (${res.status}): ${body.slice(0, 200)}`);
            // Try individual inserts on batch failure
            for (const fee of batch) {
                try {
                    const r2 = await supaFetch('channel_fees', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            Prefer: 'return=minimal',
                        },
                        body: JSON.stringify(fee),
                    });
                    if (r2.ok) inserted++;
                    else {
                        const errBody = await r2.text();
                        // Skip duplicate external_ref errors silently
                        if (errBody.includes('duplicate') || errBody.includes('unique')) {
                            stats.fee_rows_skipped_dup++;
                        } else {
                            log(`    ⚠ Individual insert failed: ${errBody.slice(0, 150)}`);
                            stats.errors++;
                        }
                    }
                } catch {
                    stats.errors++;
                }
            }
        } else {
            inserted += batch.length;
        }
    }
    return inserted;
}

// ─── Process one settlement report ───────────────────────────────────
async function processReport(report, orderMap) {
    const reportId = report.reportId;
    const docId = report.reportDocumentId;
    const createdTime = report.createdTime;

    log(`Processing report ${reportId} (created: ${createdTime?.slice(0, 10) || 'unknown'})`);

    if (!docId) {
        log(`  ⚠ No document ID — report may still be processing`);
        stats.reports_skipped++;
        return;
    }

    // Download report
    let text;
    try {
        text = await downloadReport(docId);
    } catch (e) {
        log(`  ⚠ Download failed: ${e.message}`);
        stats.errors++;
        return;
    }

    // Parse TSV
    const rows = parseSettlementTSV(text);
    if (!rows.length) {
        log(`  ⚠ Empty report`);
        stats.reports_skipped++;
        return;
    }

    // Get settlement ID from first row
    const settlementId = rows[0].settlement_id;
    log(`  Settlement ${settlementId}: ${rows.length} rows, period ${rows[0].settlement_start_date?.slice(0, 10) || '?'} → ${rows[0].settlement_end_date?.slice(0, 10) || '?'}`);

    // Get existing refs for dedup
    const existingRefs = await getExistingRefs(settlementId);
    if (existingRefs.size > 0) {
        log(`  ${existingRefs.size} existing fee rows for this settlement`);
    }

    // Map rows to fee records
    const fees = [];
    let skippedDup = 0;
    let skippedNonFee = 0;
    const orderNumbers = new Set();

    for (const row of rows) {
        const fee = mapSettlementRow(row);
        if (!fee) { skippedNonFee++; continue; }

        stats.fee_rows_parsed++;

        // Dedup check
        if (existingRefs.has(fee.external_ref)) {
            skippedDup++;
            stats.fee_rows_skipped_dup++;
            continue;
        }

        // Match order
        const orderId = orderMap[fee._order_number];
        if (orderId) {
            fee.order_id = orderId;
            stats.orders_matched++;
            orderNumbers.add(fee._order_number);
        } else {
            fee.order_id = null;
            stats.orders_unmatched++;
        }

        // Remove internal field
        delete fee._order_number;
        // Clean metadata
        Object.keys(fee.metadata).forEach(k => fee.metadata[k] === undefined && delete fee.metadata[k]);

        fees.push(fee);
    }

    log(`  Parsed: ${fees.length} new fees, ${skippedDup} duplicates, ${skippedNonFee} non-fee rows`);
    log(`  Matched ${orderNumbers.size} distinct orders`);

    if (fees.length > 0) {
        const inserted = await insertFees(fees);
        stats.fee_rows_inserted += inserted;
        log(`  Inserted: ${inserted} fee rows${DRY_RUN ? ' (dry run)' : ''}`);
    }

    stats.reports_processed++;
}

// ─── Re-match existing null order_id fee rows ────────────────────────
async function rematchFees(orderMap) {
    log('Re-matching unmatched fee rows to orders...');

    let total = 0;
    let matched = 0;
    let offset = 0;

    while (true) {
        const fees = await supaGet(
            `channel_fees?channel_id=eq.${CHANNEL_ID}&order_id=is.null&select=id,external_ref&limit=1000&offset=${offset}`
        );
        if (!fees.length) break;
        total += fees.length;

        const updates = [];
        for (const f of fees) {
            // Extract order number from external_ref: settlementId-part1-part2-part3-itemCode-feeType
            const parts = f.external_ref.split('-');
            if (parts.length < 4) continue;
            const orderNum = parts.slice(1, 4).join('-');
            const orderId = orderMap[orderNum];
            if (orderId) {
                updates.push({ id: f.id, orderId });
            }
        }

        // Batch update
        for (const u of updates) {
            if (DRY_RUN) { matched++; continue; }
            const res = await supaFetch(`channel_fees?id=eq.${u.id}`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Prefer: 'return=minimal' },
                body: JSON.stringify({ order_id: u.orderId }),
            });
            if (res.ok) matched++;
        }

        if (updates.length > 0) {
            log(`  Batch at offset ${offset}: ${updates.length} matches out of ${fees.length}`);
        }

        offset += 1000;
    }

    stats.rematched = matched;
    log(`Re-matched ${matched} fee rows out of ${total} unmatched${DRY_RUN ? ' (dry run)' : ''}`);
}

// ─── Analyze gaps ────────────────────────────────────────────────────
async function analyzeGaps() {
    log('Analyzing Amazon fee coverage gaps...');

    // Get all orders with/without fees
    const orderMap = await buildOrderMap();
    const allOrderNums = Object.keys(orderMap);

    // Get orders that have fees
    const withFees = new Set();
    let offset = 0;
    while (true) {
        const fees = await supaGet(
            `channel_fees?channel_id=eq.${CHANNEL_ID}&order_id=not.is.null&select=order_id&limit=1000&offset=${offset}`
        );
        if (!fees.length) break;
        for (const f of fees) withFees.add(f.order_id);
        offset += 1000;
    }

    // Get all orders with dates/status
    const orders = [];
    offset = 0;
    while (true) {
        const batch = await supaGet(
            `orders?channel_id=eq.${CHANNEL_ID}&select=id,order_number,ordered_at,status&limit=1000&offset=${offset}`
        );
        if (!batch.length) break;
        orders.push(...batch);
        offset += 1000;
    }

    const now = new Date();
    const twoWeeksAgo = new Date(now - 14 * 86400000).toISOString();

    const missing = orders.filter(o => !withFees.has(o.id));
    const recent = missing.filter(o => o.ordered_at >= twoWeeksAgo);
    const cancelled = missing.filter(o => o.status === 'cancelled');
    const awaitingPayment = missing.filter(o => o.status === 'awaiting_payment');
    const awaitingFulfill = missing.filter(o => o.status === 'awaiting_fulfillment');
    const oldShipped = missing.filter(o => o.status === 'shipped' && o.ordered_at < twoWeeksAgo);

    log('');
    log('═══════════════════════════════════════════');
    log('  Amazon Channel Fee Gap Analysis');
    log('═══════════════════════════════════════════');
    log(`  Total Amazon orders:                ${orders.length}`);
    log(`  Orders WITH channel_fees:           ${withFees.size}`);
    log(`  Orders WITHOUT channel_fees:        ${missing.length}`);
    log('');
    log('  Breakdown of missing:');
    log(`    Recent (<14 days, awaiting settlement): ${recent.length}`);
    log(`    Cancelled (no settlement expected):     ${cancelled.length}`);
    log(`    Awaiting payment:                       ${awaitingPayment.length}`);
    log(`    Awaiting fulfillment:                   ${awaitingFulfill.length}`);
    log(`    Old shipped (should have settlement):   ${oldShipped.length}`);
    log('');

    // Monthly breakdown of old shipped
    if (oldShipped.length > 0) {
        const byMonth = {};
        for (const o of oldShipped) {
            const m = o.ordered_at.slice(0, 7);
            byMonth[m] = (byMonth[m] || 0) + 1;
        }
        log('  Old shipped by month:');
        for (const [m, c] of Object.entries(byMonth).sort()) {
            log(`    ${m}: ${c}`);
        }
    }

    log('═══════════════════════════════════════════');

    return { total: orders.length, withFees: withFees.size, missing: missing.length, recent: recent.length, cancelled: cancelled.length, awaitingPayment: awaitingPayment.length, awaitingFulfill: awaitingFulfill.length, oldShipped: oldShipped.length };
}

// ─── Fill gaps via Finances API (per-order) ──────────────────────────
async function fillGapsViaFinancesApi() {
    log('Filling fee gaps via Amazon Finances API (per-order)...');

    // Get orders without fees
    const orderMap = await buildOrderMap();
    const orderIdToNum = {};
    for (const [num, id] of Object.entries(orderMap)) orderIdToNum[id] = num;

    // Get all order_ids with fees
    const withFees = new Set();
    let offset = 0;
    while (true) {
        const fees = await supaGet(
            `channel_fees?channel_id=eq.${CHANNEL_ID}&order_id=not.is.null&select=order_id&limit=1000&offset=${offset}`
        );
        if (!fees.length) break;
        for (const f of fees) withFees.add(f.order_id);
        offset += 1000;
    }

    // Get shipped orders without fees, older than 14 days
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const allOrders = [];
    offset = 0;
    while (true) {
        const batch = await supaGet(
            `orders?channel_id=eq.${CHANNEL_ID}&status=eq.shipped&ordered_at=lt.${twoWeeksAgo}&select=id,order_number,ordered_at&limit=1000&offset=${offset}`
        );
        if (!batch.length) break;
        allOrders.push(...batch);
        offset += 1000;
    }

    const missing = allOrders.filter(o => !withFees.has(o.id));
    log(`Found ${missing.length} shipped orders without fees (older than 14 days)`);

    let fetched = 0, inserted = 0, noData = 0, errors = 0;

    for (let i = 0; i < missing.length; i++) {
        const order = missing[i];
        if (i % 50 === 0) log(`  [${i + 1}/${missing.length}] Processing ${order.order_number}...`);

        try {
            // Rate limit: Finances API allows 0.5 TPS
            if (i > 0) await sleep(2200);

            const data = await spApiGet(`/finances/v0/orders/${order.order_number}/financialEvents`);
            const events = data.payload?.FinancialEvents;
            const shipments = events?.ShipmentEventList || [];
            const refunds = events?.RefundEventList || [];

            if (!shipments.length && !refunds.length) {
                noData++;
                continue;
            }

            const fees = [];
            for (const event of [...shipments, ...refunds]) {
                const postedDate = event.PostedDate;
                const isRefund = refunds.includes(event);

                for (const item of event.ShipmentItemList || []) {
                    const sku = item.SellerSKU || '';
                    const orderItemCode = item.OrderItemId || '';

                    for (const fee of item.ItemFeeList || []) {
                        const amt = fee.FeeAmount?.CurrencyAmount || 0;
                        if (amt === 0) continue;

                        const feeType = fee.FeeType === 'Commission' || fee.FeeType === 'RefundCommission'
                            ? 'marketplace_commission'
                            : fee.FeeType === 'Promotion' || fee.FeeType === 'PromotionShipping'
                                ? 'promotion'
                                : 'other';

                        const externalRef = `finances-${order.order_number}-${orderItemCode}-${fee.FeeType}`;

                        fees.push({
                            channel_id: CHANNEL_ID,
                            order_id: order.id,
                            fee_type: feeType,
                            description: fee.FeeType + (isRefund ? ' (refund)' : ''),
                            amount: Math.abs(amt),
                            currency_code: fee.FeeAmount?.CurrencyCode || 'USD',
                            incurred_at: postedDate ? new Date(postedDate).toISOString() : null,
                            external_ref: externalRef,
                            metadata: {
                                source: 'finances_api',
                                sku: sku || undefined,
                                order_item_code: orderItemCode || undefined,
                                original_amount: amt,
                            },
                        });
                    }

                    // Also capture promotions
                    for (const promo of item.PromotionList || []) {
                        const amt = promo.PromotionAmount?.CurrencyAmount || 0;
                        if (amt === 0) continue;

                        fees.push({
                            channel_id: CHANNEL_ID,
                            order_id: order.id,
                            fee_type: 'promotion',
                            description: promo.PromotionType || 'Promotion',
                            amount: Math.abs(amt),
                            currency_code: promo.PromotionAmount?.CurrencyCode || 'USD',
                            incurred_at: postedDate ? new Date(postedDate).toISOString() : null,
                            external_ref: `finances-${order.order_number}-${item.OrderItemId}-promo-${promo.PromotionId || 'unknown'}`,
                            metadata: {
                                source: 'finances_api',
                                sku: sku || undefined,
                                promotion_id: promo.PromotionId || undefined,
                            },
                        });
                    }
                }
            }

            // Clean metadata
            for (const fee of fees) {
                Object.keys(fee.metadata).forEach(k => fee.metadata[k] === undefined && delete fee.metadata[k]);
            }

            if (fees.length > 0) {
                if (!DRY_RUN) {
                    const count = await insertFees(fees);
                    inserted += count;
                } else {
                    inserted += fees.length;
                }
                fetched++;
            } else {
                noData++;
            }
        } catch (e) {
            if (e.message.includes('429')) {
                log(`  ⏳ Rate limited, waiting 30s...`);
                await sleep(30000);
                i--; // Retry
            } else {
                errors++;
                if (errors < 5) log(`  ⚠ ${order.order_number}: ${e.message.slice(0, 100)}`);
            }
        }
    }

    log(`\nFinances API fill complete:`);
    log(`  Orders processed: ${missing.length}`);
    log(`  Orders with data: ${fetched}`);
    log(`  Fee rows inserted: ${inserted}${DRY_RUN ? ' (dry run)' : ''}`);
    log(`  No data: ${noData}`);
    log(`  Errors: ${errors}`);

    stats.fee_rows_inserted += inserted;
    stats.orders_matched += fetched;
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Amazon Settlement Sync');
    if (DRY_RUN) log('*** DRY RUN ***');

    if (ANALYZE) {
        await analyzeGaps();
        return;
    }

    if (FILL_GAPS) {
        await fillGapsViaFinancesApi();
        await analyzeGaps();
        return;
    }

    // Build order map for matching
    const orderMap = await buildOrderMap();

    // Re-match mode
    if (REMATCH) {
        await rematchFees(orderMap);
        await analyzeGaps();
        return;
    }

    // List available settlement reports from SP-API
    log('Fetching settlement report list from SP-API...');
    const reports = await listSettlementReports();
    stats.reports_found = reports.length;
    log(`Found ${reports.length} settlement reports`);

    if (!reports.length) {
        log('No settlement reports found.');
        return;
    }

    // Load cursor to skip already-processed reports
    const cursor = await getImportedSettlementIds();
    const processedSet = new Set(cursor.processedReportIds || []);

    // Filter to new reports (unless backfilling)
    const toProcess = SPECIFIC_REPORT
        ? reports.filter(r => r.reportId === SPECIFIC_REPORT)
        : BACKFILL
            ? reports
            : reports.filter(r => !processedSet.has(r.reportId));

    log(`Reports to process: ${toProcess.length} (${BACKFILL ? 'backfill' : 'incremental'})`);

    // Sort by created time (oldest first for backfill)
    toProcess.sort((a, b) => (a.createdTime || '').localeCompare(b.createdTime || ''));

    // Process each report
    for (let i = 0; i < toProcess.length; i++) {
        log(`\n[${i + 1}/${toProcess.length}]`);
        try {
            await processReport(toProcess[i], orderMap);
            processedSet.add(toProcess[i].reportId);
        } catch (e) {
            log(`  ❌ Error: ${e.message}`);
            stats.errors++;
        }
        // Rate limit: respect SP-API document download burst rate (~1 req/3s)
        if (i < toProcess.length - 1) await sleep(3000);
    }

    // Save cursor
    cursor.processedReportIds = [...processedSet];
    cursor.lastRun = new Date().toISOString();
    if (!DRY_RUN) {
        saveImportedSettlementIds(cursor);
    }

    // Re-match any previously unmatched fees
    log('\nRunning re-match pass...');
    await rematchFees(orderMap);

    // Print summary
    log('');
    log('────────────────────────────────────');
    log('Settlement sync complete!');
    log(`  Reports found:        ${stats.reports_found}`);
    log(`  Reports processed:    ${stats.reports_processed}`);
    log(`  Reports skipped:      ${stats.reports_skipped}`);
    log(`  Fee rows parsed:      ${stats.fee_rows_parsed}`);
    log(`  Fee rows inserted:    ${stats.fee_rows_inserted}`);
    log(`  Fee rows dup-skipped: ${stats.fee_rows_skipped_dup}`);
    log(`  Orders matched:       ${stats.orders_matched}`);
    log(`  Orders unmatched:     ${stats.orders_unmatched}`);
    log(`  Re-matched:           ${stats.rematched}`);
    log(`  Errors:               ${stats.errors}`);

    // Analyze remaining gaps
    log('');
    await analyzeGaps();

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
