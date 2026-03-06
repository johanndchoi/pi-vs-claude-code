#!/usr/bin/env node

/**
 * Walmart Channel Fees Sync → Supabase
 *
 * Imports commission fees from Walmart reconciliation reports into the
 * channel_fees table. For orders not yet in any recon report (too recent
 * or cancelled), estimates fees at the known 15% commission rate.
 *
 * Usage:
 *   node walmart-fees.mjs                        # Sync all available reports
 *   node walmart-fees.mjs --report 02242026      # Sync specific report date
 *   node walmart-fees.mjs --fill-gaps             # Estimate fees for orders with no recon data
 *   node walmart-fees.mjs --dry-run               # Preview changes
 */

import { readFileSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, mkdirSync, existsSync, unlinkSync } from 'fs';
import { createUnzip } from 'zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const FILL_GAPS = args.includes('--fill-gaps');
const reportArg = args.find((_, i) => args[i - 1] === '--report');

// ─── Config ──────────────────────────────────────────────────────────
const WM_CHANNEL_ID = '2da7e1e0-579e-4968-bdef-fa18492a6a86';
const DEFAULT_COMMISSION_RATE = 15.0; // All Walmart items are 15%

// ─── Env / Credentials ──────────────────────────────────────────────
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

const WM_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/username"',
    { encoding: 'utf8', env: { ...process.env } }).trim();
const WM_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/credential"',
    { encoding: 'utf8', env: { ...process.env } }).trim();

// ─── Stats ───────────────────────────────────────────────────────────
const stats = {
    reports_processed: 0,
    rows_parsed: 0,
    fees_inserted: 0,
    fees_skipped_existing: 0,
    fees_estimated: 0,
    orders_not_found: 0,
    errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Walmart Auth ────────────────────────────────────────────────────
let wmToken = null;
let wmTokenExpiry = 0;

async function wmAuth() {
    if (wmToken && Date.now() < wmTokenExpiry) return wmToken;
    const res = await fetch('https://marketplace.walmartapis.com/v3/token', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `fees-${Date.now()}`,
            Authorization: 'Basic ' + Buffer.from(`${WM_CLIENT_ID}:${WM_CLIENT_SECRET}`).toString('base64'),
            Accept: 'application/json'
        },
        body: 'grant_type=client_credentials'
    });
    if (!res.ok) throw new Error(`Walmart auth failed: ${res.status}`);
    const data = await res.json();
    wmToken = data.access_token;
    wmTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return wmToken;
}

// ─── Walmart Recon API ───────────────────────────────────────────────
async function getAvailableReports() {
    const token = await wmAuth();
    const res = await fetch('https://marketplace.walmartapis.com/v3/report/reconreport/availableReconFiles', {
        headers: {
            'WM_SEC.ACCESS_TOKEN': token,
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `fees-${Date.now()}`,
            Accept: 'application/json'
        }
    });
    if (!res.ok) throw new Error(`Failed to get report list: ${res.status}`);
    const data = await res.json();
    return data.availableApReportDates || [];
}

async function downloadReport(reportDate) {
    const token = await wmAuth();
    const res = await fetch(
        `https://marketplace.walmartapis.com/v3/report/reconreport/reconFile?reportDate=${reportDate}`, {
        headers: {
            'WM_SEC.ACCESS_TOKEN': token,
            'WM_SVC.NAME': 'Walmart Marketplace',
            'WM_QOS.CORRELATION_ID': `fees-${Date.now()}`,
            Accept: 'application/octet-stream'
        }
    });
    if (!res.ok) throw new Error(`Failed to download report ${reportDate}: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

function parseReconCSV(csvText, reportDate) {
    const lines = csvText.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]);
    const rows = [];

    for (let i = 1; i < lines.length; i++) {
        const values = parseCSVLine(lines[i]);
        if (values.length < 23) continue;

        const row = {};
        headers.forEach((h, idx) => { row[h] = values[idx] || ''; });

        const orderNum = row['Walmart.com Order #']?.trim();
        const poNum = row['Walmart.com PO #']?.trim();
        const txType = row['Transaction Type']?.trim();
        const sku = row['Partner Item ID']?.trim();
        const commission = parseFloat(row['Commission from Sale']) || 0;
        const commissionRate = row['Commission Rate']?.trim() || '';
        const txDate = row['Transaction Date Time']?.trim();

        if (!orderNum) continue;

        // Build a unique transaction key from PO + line
        const poLine = row['Walmart.com P.O. Line #']?.trim() || '1';
        const txKey = `${poNum}_${poLine}`;

        rows.push({
            order_number: orderNum,
            po_number: poNum,
            transaction_type: txType,
            transaction_date: txDate,
            sku,
            commission: Math.abs(commission),
            commission_rate: commissionRate,
            transaction_key: txKey,
            report_date: reportDate,
            gross_sales: parseFloat(row['Gross Sales Revenue']) || 0,
            description: `Commission on Product`
        });
    }

    return rows;
}

function parseCSVLine(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
            inQuotes = !inQuotes;
        } else if (c === ',' && !inQuotes) {
            result.push(current);
            current = '';
        } else {
            current += c;
        }
    }
    result.push(current);
    return result;
}

// ─── Supabase Helpers ────────────────────────────────────────────────
async function supaGet(path) {
    const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` }
    });
    if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
    return res.json();
}

async function supaPost(table, data) {
    if (DRY_RUN) return;
    const res = await fetch(`${SUPA_URL}/rest/v1/${table}`, {
        method: 'POST',
        headers: {
            apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            Prefer: 'return=representation,resolution=ignore-duplicates'
        },
        body: JSON.stringify(data)
    });
    if (!res.ok) {
        const body = await res.text();
        throw new Error(`POST ${table} ${res.status}: ${body.slice(0, 300)}`);
    }
    return res.json();
}

// ─── Build order lookup ──────────────────────────────────────────────
async function buildOrderLookup() {
    // Fetch all Walmart orders
    const orders = await supaGet(
        `orders?channel_id=eq.${WM_CHANNEL_ID}&select=id,order_number,status,subtotal,ordered_at,external_ids&limit=1000`
    );
    const lookup = {};
    for (const o of orders) {
        lookup[o.order_number] = o;
    }
    log(`Loaded ${orders.length} Walmart orders from DB`);
    return lookup;
}

async function getExistingFeeRefs() {
    // Get all existing external_refs for Walmart fees to avoid duplicates
    let all = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
        const batch = await supaGet(
            `channel_fees?channel_id=eq.${WM_CHANNEL_ID}&select=external_ref&limit=${pageSize}&offset=${offset}`
        );
        all.push(...batch);
        if (batch.length < pageSize) break;
        offset += pageSize;
    }
    return new Set(all.map(r => r.external_ref));
}

// ─── Process a single recon report ───────────────────────────────────
async function processReport(reportDate, orderLookup, existingRefs) {
    log(`Processing report: ${reportDate}`);

    const zipBuffer = await downloadReport(reportDate);

    // Extract ZIP - use child process since Node zlib doesn't handle ZIP format
    const tmpZip = `/tmp/wm-recon-${reportDate}.zip`;
    const tmpDir = `/tmp/wm-recon-${reportDate}`;
    writeFileSync(tmpZip, zipBuffer);
    execSync(`mkdir -p ${tmpDir} && cd ${tmpDir} && unzip -o ${tmpZip} 2>/dev/null`, { encoding: 'utf8' });

    // Find CSV
    const csvFiles = execSync(`ls ${tmpDir}/*.csv 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n');
    if (!csvFiles[0]) {
        log(`  ⚠ No CSV found in report ${reportDate}`);
        return;
    }

    const csvText = readFileSync(csvFiles[0], 'utf8');
    const rows = parseReconCSV(csvText, reportDate);
    log(`  Parsed ${rows.length} transaction rows`);
    stats.rows_parsed += rows.length;

    // Group by order_number to handle multi-line orders
    const byOrder = {};
    for (const row of rows) {
        if (!byOrder[row.order_number]) byOrder[row.order_number] = [];
        byOrder[row.order_number].push(row);
    }

    let inserted = 0;
    let skipped = 0;
    let notFound = 0;

    for (const [orderNum, txRows] of Object.entries(byOrder)) {
        const order = orderLookup[orderNum];
        if (!order) {
            notFound++;
            continue;
        }

        for (const tx of txRows) {
            // Build external_ref for dedup
            const extRef = `wm-${tx.transaction_key}-${tx.description.replace(/\s+/g, '')}`;

            if (existingRefs.has(extRef)) {
                skipped++;
                continue;
            }

            if (tx.commission === 0 && tx.transaction_type === 'SALE') continue;

            const fee = {
                order_id: order.id,
                channel_id: WM_CHANNEL_ID,
                fee_type: 'marketplace_commission',
                description: tx.description,
                amount: tx.commission,
                currency_code: 'USD',
                incurred_at: parseTxDate(tx.transaction_date),
                external_ref: extRef,
                metadata: {
                    sku: tx.sku,
                    report_date: reportDate,
                    commission_rate: tx.commission_rate,
                    transaction_key: tx.transaction_key,
                    transaction_type: tx.transaction_type
                }
            };

            try {
                await supaPost('channel_fees', fee);
                existingRefs.add(extRef);
                inserted++;
            } catch (e) {
                log(`  ⚠ Insert failed for ${orderNum}: ${e.message}`);
                stats.errors++;
            }
        }
    }

    log(`  Inserted: ${inserted}, Skipped (existing): ${skipped}, Orders not in DB: ${notFound}`);
    stats.fees_inserted += inserted;
    stats.fees_skipped_existing += skipped;
    stats.orders_not_found += notFound;
    stats.reports_processed++;

    // Cleanup
    try {
        execSync(`rm -rf ${tmpZip} ${tmpDir}`);
    } catch {}
}

function parseTxDate(dateStr) {
    if (!dateStr) return new Date().toISOString();
    // Format: MM/DD/YYYY
    const m = dateStr.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1]}-${m[2]}T00:00:00Z`;
    return new Date().toISOString();
}

// ─── Fill gaps: estimate fees for orders not in any recon report ─────
async function fillGaps(orderLookup, existingRefs) {
    log('Filling gaps: estimating fees for orders without recon data');

    // Get all order_ids that already have channel_fees
    let allFeeOrderIds = new Set();
    let offset = 0;
    while (true) {
        const batch = await supaGet(
            `channel_fees?channel_id=eq.${WM_CHANNEL_ID}&select=order_id&limit=1000&offset=${offset}`
        );
        for (const r of batch) allFeeOrderIds.add(r.order_id);
        if (batch.length < 1000) break;
        offset += 1000;
    }

    const ordersWithoutFees = Object.values(orderLookup).filter(o => !allFeeOrderIds.has(o.id));
    log(`  Found ${ordersWithoutFees.length} orders without channel_fees`);

    for (const order of ordersWithoutFees) {
        const isCancelled = ['cancelled', 'refunded'].includes(order.status);
        const extRef = `wm-estimated-${order.order_number}`;

        if (existingRefs.has(extRef)) {
            stats.fees_skipped_existing++;
            continue;
        }

        let commission = 0;
        let description = 'Commission on Product (estimated)';

        if (isCancelled) {
            commission = 0;
            description = 'No commission - order ' + order.status;
        } else {
            // Estimate at 15% of subtotal
            commission = +(order.subtotal * DEFAULT_COMMISSION_RATE / 100).toFixed(2);
        }

        const fee = {
            order_id: order.id,
            channel_id: WM_CHANNEL_ID,
            fee_type: 'marketplace_commission',
            description,
            amount: commission,
            currency_code: 'USD',
            incurred_at: order.ordered_at,
            external_ref: extRef,
            metadata: {
                estimated: true,
                commission_rate: isCancelled ? '0.00' : DEFAULT_COMMISSION_RATE.toFixed(2),
                order_status: order.status,
                subtotal: order.subtotal,
                reason: isCancelled
                    ? `Order ${order.status} — no commission charged`
                    : 'Not yet in recon report — estimated at 15% of subtotal'
            }
        };

        try {
            if (DRY_RUN) {
                log(`  [DRY] ${order.order_number}: $${commission} (${description})`);
            } else {
                await supaPost('channel_fees', fee);
                log(`  ✓ ${order.order_number}: $${commission} (${description})`);
            }
            existingRefs.add(extRef);
            stats.fees_estimated++;
        } catch (e) {
            log(`  ⚠ ${order.order_number}: ${e.message}`);
            stats.errors++;
        }
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Walmart Channel Fees Sync');
    if (DRY_RUN) log('*** DRY RUN ***');

    const orderLookup = await buildOrderLookup();
    const existingRefs = await getExistingFeeRefs();
    log(`Loaded ${existingRefs.size} existing fee references`);

    if (FILL_GAPS) {
        await fillGaps(orderLookup, existingRefs);
    } else {
        // Get available report dates
        const availableDates = await getAvailableReports();
        const reportDates = reportArg ? [reportArg] : availableDates;

        // Sort by date (MMDDYYYY → sortable)
        const sorted = reportDates
            .filter(d => d.match(/^\d{8}$/))
            .sort((a, b) => {
                const toSort = d => d.slice(4) + d.slice(0, 4); // YYYYMMDD
                return toSort(a).localeCompare(toSort(b));
            });

        log(`Processing ${sorted.length} report(s)`);

        for (const date of sorted) {
            try {
                await processReport(date, orderLookup, existingRefs);
                await sleep(2000); // Rate limit between reports
            } catch (e) {
                log(`  ⚠ Report ${date}: ${e.message}`);
                stats.errors++;
            }
        }
    }

    log('────────────────────────────────────');
    log('Summary:');
    log(`  Reports processed:     ${stats.reports_processed}`);
    log(`  Rows parsed:           ${stats.rows_parsed}`);
    log(`  Fees inserted:         ${stats.fees_inserted}`);
    log(`  Fees estimated:        ${stats.fees_estimated}`);
    log(`  Skipped (existing):    ${stats.fees_skipped_existing}`);
    log(`  Orders not in DB:      ${stats.orders_not_found}`);
    log(`  Errors:                ${stats.errors}`);

    if (stats.errors > 0) process.exit(1);
}

main().catch(e => { console.error(e); process.exit(1); });
