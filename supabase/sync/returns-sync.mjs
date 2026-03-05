#!/usr/bin/env node

/**
 * Returns Sync: Amazon SP-API Reports + Walmart Returns API → Supabase
 * Imports return requests, return items, and refund records.
 *
 * Usage:
 *   node returns-sync.mjs              # Incremental (new reports only)
 *   node returns-sync.mjs --all        # Process all available reports
 *   node returns-sync.mjs --walmart    # Walmart only
 *   node returns-sync.mjs --amazon     # Amazon only
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ALL = args.includes('--all');
const AMAZON_ONLY = args.includes('--amazon');
const WALMART_ONLY = args.includes('--walmart');

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
const SP_API_BASE = 'https://sellingpartnerapi-na.amazon.com';
const CURSOR_FILE = join(__dirname, '..', '.locks', 'returns-sync.cursor');

const stats = { amazon_returns: 0, walmart_returns: 0, refunds: 0, matched: 0, unmatched: 0, skipped: 0, errors: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Amazon auth ─────────────────────────────────────────────────────
const AMZ_LWA = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials"', { encoding: 'utf8' }).trim();
const AMZ_SECRET = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret"', { encoding: 'utf8' }).trim();
const AMZ_REFRESH = execSync('op read "op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken"', { encoding: 'utf8' }).trim();

let amzToken = null, amzExpiry = 0;
async function getAmzToken() {
    if (amzToken && Date.now() < amzExpiry) return amzToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${AMZ_REFRESH}&client_id=${AMZ_LWA}&client_secret=${AMZ_SECRET}`
    });
    const data = await res.json();
    amzToken = data.access_token;
    amzExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return amzToken;
}

async function spApiGet(path) {
    const token = await getAmzToken();
    const res = await fetch(`${SP_API_BASE}${path}`, { headers: { 'x-amz-access-token': token } });
    if (res.status === 429) { await sleep(10000); return spApiGet(path); }
    if (!res.ok) throw new Error(`SP-API ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Walmart auth ────────────────────────────────────────────────────
const WM_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/username"', { encoding: 'utf8' }).trim();
const WM_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/credential"', { encoding: 'utf8' }).trim();

let wmToken = null, wmExpiry = 0;
async function getWmToken() {
    if (wmToken && Date.now() < wmExpiry) return wmToken;
    const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `returns-${Date.now()}`,
            Authorization: 'Basic ' + Buffer.from(`${WM_CLIENT_ID}:${WM_CLIENT_SECRET}`).toString('base64'),
            Accept: 'application/json'
        },
        body: 'grant_type=client_credentials'
    });
    const data = await res.json();
    wmToken = data.access_token;
    wmExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return wmToken;
}

async function wmGet(path) {
    const token = await getWmToken();
    const res = await fetch(`https://marketplace.walmartapis.com/v3${path}`, {
        headers: {
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `returns-${Date.now()}`,
            Authorization: 'Basic ' + Buffer.from(`${WM_CLIENT_ID}:${WM_CLIENT_SECRET}`).toString('base64'),
            'WM_SEC.ACCESS_TOKEN': token,
            Accept: 'application/json'
        }
    });
    if (res.status === 429) { await sleep(10000); return wmGet(path); }
    if (!res.ok) throw new Error(`Walmart ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Supabase helpers ────────────────────────────────────────────────
const supaH = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

async function findOrderId(orderNum) {
    const res = await fetch(`${SUPA_URL}/rest/v1/orders?order_number=eq.${encodeURIComponent(orderNum)}&select=id`, { headers: supaH });
    const rows = await res.json();
    return rows?.[0]?.id || null;
}

async function findOrderItemBySku(orderId, sku) {
    const res = await fetch(`${SUPA_URL}/rest/v1/order_items?order_id=eq.${orderId}&sku=eq.${encodeURIComponent(sku)}&select=id,variant_id&limit=1`, { headers: supaH });
    const rows = await res.json();
    return rows?.[0] || null;
}

async function upsertReturn(data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/returns`, {
        method: 'POST',
        headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=representation' },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        if (body.includes('23505') || body.includes('duplicate')) return null; // Already exists
        throw new Error(`Upsert return: ${res.status} ${body}`);
    }
    return (await res.json())?.[0];
}

async function insertReturnItem(data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/return_items`, {
        method: 'POST',
        headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(data)
    });
    return res.ok;
}

async function insertRefund(data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/refunds`, {
        method: 'POST',
        headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: JSON.stringify(data)
    });
    return res.ok;
}

// ─── Reason mapping ──────────────────────────────────────────────────
function mapAmazonReason(reason) {
    const map = {
        'CR-DEFECTIVE': 'defective', 'CR-QUALITY_UNACCEPTABLE': 'defective',
        'CR-DAMAGED_BY_CARRIER': 'damaged_in_transit', 'CR-DAMAGED_BY_FC': 'damaged_in_transit',
        'CR-WRONG_ITEM': 'wrong_item', 'CR-NOT_AS_DESCRIBED': 'not_as_described',
        'CR-MISSED_ESTIMATED_DELIVERY': 'arrived_late', 'CR-SWITCHEROO': 'wrong_item',
        'CR-MISSING_PARTS': 'missing_parts', 'CR-BUYER_REMORSE': 'no_longer_needed',
        'CR-UNWANTED_ITEM': 'no_longer_needed', 'CR-NO_REASON': 'other',
        'LOST_IN_TRANSIT': 'damaged_in_transit'
    };
    return map[reason] || 'other';
}

function mapWalmartReason(reason) {
    const map = {
        'DAMAGED': 'damaged_in_transit', 'DEFECTIVE': 'defective',
        'WRONG_ITEM': 'wrong_item', 'NOT_AS_DESCRIBED': 'not_as_described',
        'LOST_IN_TRANSIT': 'damaged_in_transit', 'ARRIVED_LATE': 'arrived_late',
        'MISSING_PARTS': 'missing_parts', 'NO_LONGER_NEEDED': 'no_longer_needed',
        'CHANGED_MIND': 'no_longer_needed'
    };
    return map[reason] || 'other';
}

function mapAmazonStatus(status) {
    const map = {
        'Approved': 'approved', 'Completed': 'refunded',
        'Unit returned': 'received', 'Pending': 'requested', 'Denied': 'rejected'
    };
    return map[status] || 'requested';
}

// ─── Cursor ──────────────────────────────────────────────────────────
function loadCursor() { try { return JSON.parse(readFileSync(CURSOR_FILE, 'utf8')); } catch { return {}; } }
function saveCursor(data) { mkdirSync(dirname(CURSOR_FILE), { recursive: true }); writeFileSync(CURSOR_FILE, JSON.stringify(data)); }

// ─── Amazon returns ──────────────────────────────────────────────────
async function syncAmazonReturns() {
    log('Amazon returns: fetching reports...');

    const reportsData = await spApiGet('/reports/2021-06-30/reports?reportTypes=GET_FLAT_FILE_RETURNS_DATA_BY_RETURN_DATE&pageSize=50');
    const reports = reportsData.reports?.filter(r => r.processingStatus === 'DONE') || [];

    // Use only the big 60-day window reports + most recent daily to avoid heavy overlap
    const bigReports = reports.filter(r => {
        const start = new Date(r.dataStartTime);
        const end = new Date(r.dataEndTime);
        return (end - start) > 30 * 86400000; // > 30 day window
    });
    const latestDaily = reports.find(r => {
        const start = new Date(r.dataStartTime);
        const end = new Date(r.dataEndTime);
        return (end - start) <= 35 * 86400000;
    });

    const toProcess = [...bigReports];
    if (latestDaily && !bigReports.find(r => r.reportId === latestDaily.reportId)) {
        toProcess.unshift(latestDaily);
    }

    // Filter by cursor
    const cursor = loadCursor();
    const processedIds = new Set(cursor.amazon_report_ids || []);
    const filtered = ALL ? toProcess : toProcess.filter(r => !processedIds.has(r.reportId));

    log(`  ${reports.length} total reports, ${filtered.length} to process`);

    const seenRMAs = new Set();
    for (const report of filtered) {
        try {
            const doc = await spApiGet(`/reports/2021-06-30/reports/${report.reportId}`);
            const docUrl = (await spApiGet(`/reports/2021-06-30/documents/${doc.reportDocumentId}`)).url;
            const tsv = await (await fetch(docUrl)).text();

            const lines = tsv.split('\n').filter(l => l.trim());
            const headers = lines[0].split('\t');
            const rows = lines.slice(1).map(l => {
                const vals = l.split('\t');
                const row = {};
                headers.forEach((h, i) => row[h] = vals[i]?.trim() || '');
                return row;
            });

            log(`  Report ${report.reportId}: ${rows.length} returns (${report.dataStartTime?.slice(0, 10)} → ${report.dataEndTime?.slice(0, 10)})`);

            for (const row of rows) {
                const rma = row['Amazon RMA ID'];
                if (!rma || seenRMAs.has(rma)) { stats.skipped++; continue; }
                seenRMAs.add(rma);

                const orderNum = row['Order ID'];
                const orderId = await findOrderId(orderNum);
                if (!orderId) { stats.unmatched++; continue; }
                stats.matched++;

                const sku = row['Merchant SKU'];
                const orderItem = sku ? await findOrderItemBySku(orderId, sku) : null;

                // Parse dates (DD-Mon-YYYY format)
                function parseDate(d) {
                    if (!d || !d.trim()) return null;
                    const parsed = new Date(d);
                    return isNaN(parsed) ? null : parsed.toISOString();
                }

                const returnData = {
                    order_id: orderId,
                    status: mapAmazonStatus(row['Return request status']),
                    reason: mapAmazonReason(row['Return Reason']),
                    reason_detail: row['Return Reason'],
                    rma_number: rma,
                    return_label_tracking: row['Tracking ID'] || null,
                    return_carrier: row['Return carrier'] || null,
                    requested_at: parseDate(row['Return request date']),
                    received_at: parseDate(row['Return delivery date']),
                    return_shipping_cost: parseFloat(row['Label cost']) || 0,
                    paid_by: row['Label to be paid by'] === 'Amazon' ? 'channel' : 'seller',
                    external_ids: { amazon_rma: rma, amazon_order_item: row['Order Item ID'] },
                    metadata: {
                        label_type: row['Label type'],
                        return_type: row['Return type'],
                        resolution: row['Resolution'],
                        is_prime: row['Is prime'] === 'Y',
                        asin: row['ASIN'],
                        in_policy: row['In policy'] === 'Y',
                        safet_claim_id: row['SafeT claim id'] || null
                    }
                };

                if (row['Resolution'] === 'StandardRefund' || row['Resolution'] === 'RefundAtFirstScan') {
                    returnData.status = 'refunded';
                }

                try {
                    const ret = await upsertReturn(returnData);
                    if (!ret) { stats.skipped++; continue; }
                    stats.amazon_returns++;

                    // Return item
                    if (orderItem) {
                        await insertReturnItem({
                            return_id: ret.id,
                            order_item_id: orderItem.id,
                            variant_id: orderItem.variant_id || null,
                            quantity: parseInt(row['Return quantity']) || 1,
                            reason: mapAmazonReason(row['Return Reason'])
                        });
                    }

                    // Refund
                    const refundAmt = parseFloat(row['Refunded Amount']) || parseFloat(row['Order Amount']) || 0;
                    if (refundAmt > 0) {
                        await insertRefund({
                            order_id: orderId,
                            return_id: ret.id,
                            refund_type: row['Resolution'] === 'StandardRefund' ? 'full' : 'partial',
                            amount: refundAmt, total_refund: refundAmt,
                            status: 'completed',
                            channel_id: '7f84462f-86c8-4e09-abb6-285631db0d83',
                            external_ref: `amz-${rma}`,
                            metadata: { resolution: row['Resolution'] }
                        });
                        stats.refunds++;
                    }
                } catch (e) {
                    log(`    ⚠ ${orderNum} (${rma}): ${e.message}`);
                    stats.errors++;
                }
            }

            processedIds.add(report.reportId);
            await sleep(1000);
        } catch (e) {
            log(`  ⚠ Report ${report.reportId}: ${e.message}`);
            stats.errors++;
        }
    }

    saveCursor({ ...cursor, amazon_report_ids: [...processedIds] });
}

// ─── Walmart returns ─────────────────────────────────────────────────
async function syncWalmartReturns() {
    log('Walmart returns: fetching...');

    const cursor = loadCursor();
    const lastSync = cursor.walmart_last_sync || '2024-01-01T00:00:00Z';
    const since = ALL ? '2024-01-01T00:00:00Z' : lastSync;

    let offset = 0;
    let total = 0;

    while (true) {
        const endDate = new Date().toISOString();
        const data = await wmGet(`/returns?limit=200&returnCreationStartDate=${since}&returnCreationEndDate=${endDate}&offset=${offset}`);
        const returns = data?.returnOrders || [];
        if (!returns.length) break;
        total += returns.length;

        for (const ret of returns) {
            const orderNum = ret.customerOrderId;
            const orderId = await findOrderId(orderNum);
            if (!orderId) { stats.unmatched++; continue; }
            stats.matched++;

            const firstLine = ret.returnOrderLines?.[0];
            const reason = firstLine?.returnReason || 'other';
            const rma = `WM-${ret.returnOrderId}`;

            const returnData = {
                order_id: orderId,
                status: 'approved',
                reason: mapWalmartReason(reason),
                reason_detail: firstLine?.returnDescription || reason,
                rma_number: rma,
                requested_at: ret.returnOrderDate,
                return_shipping_cost: 0,
                paid_by: 'channel',
                external_ids: { walmart_return_id: ret.returnOrderId },
                metadata: {
                    refund_mode: ret.refundMode,
                    return_by_date: ret.returnByDate,
                    customer_email: ret.customerEmailId
                }
            };

            const totalRefund = ret.totalRefundAmount?.currencyAmount || 0;
            if (totalRefund > 0) returnData.status = 'refunded';

            try {
                const created = await upsertReturn(returnData);
                if (!created) { stats.skipped++; continue; }
                stats.walmart_returns++;

                // Return items
                for (const line of ret.returnOrderLines || []) {
                    const sku = line.item?.sku;
                    const orderItem = sku ? await findOrderItemBySku(orderId, sku) : null;

                    if (orderItem) {
                        await insertReturnItem({
                            return_id: created.id,
                            order_item_id: orderItem.id,
                            variant_id: orderItem.variant_id || null,
                            quantity: 1,
                            reason: mapWalmartReason(line.returnReason)
                        });
                    }
                }

                // Refund
                if (totalRefund > 0) {
                    await insertRefund({
                        order_id: orderId,
                        return_id: created.id,
                        refund_type: 'full',
                        amount: totalRefund, total_refund: totalRefund,
                        status: 'completed',
                        channel_id: '2da7e1e0-579e-4968-bdef-fa18492a6a86',
                        external_ref: `wm-${ret.returnOrderId}`,
                        metadata: { refund_mode: ret.refundMode }
                    });
                    stats.refunds++;
                }
            } catch (e) {
                log(`    ⚠ ${orderNum}: ${e.message}`);
                stats.errors++;
            }
        }

        log(`  Fetched ${total} Walmart returns...`);
        offset += returns.length;
        if (returns.length < 200) break;
        await sleep(1000);
    }

    saveCursor({ ...cursor, walmart_last_sync: new Date().toISOString() });
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Returns sync starting');

    if (!WALMART_ONLY) await syncAmazonReturns();
    if (!AMAZON_ONLY) await syncWalmartReturns();

    log('────────────────────────────────────');
    log(`Done!`);
    log(`  Amazon returns:  ${stats.amazon_returns}`);
    log(`  Walmart returns: ${stats.walmart_returns}`);
    log(`  Refunds:         ${stats.refunds}`);
    log(`  Orders matched:  ${stats.matched}`);
    log(`  Orders unmatched: ${stats.unmatched}`);
    log(`  Skipped (dupes): ${stats.skipped}`);
    log(`  Errors:          ${stats.errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
