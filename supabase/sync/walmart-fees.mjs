#!/usr/bin/env node

/**
 * Walmart Recon Reports → Supabase channel_fees
 * Downloads reconciliation reports and imports commission fees per order.
 *
 * Usage:
 *   node walmart-fees.mjs              # Process unimported reports
 *   node walmart-fees.mjs --all        # Re-process all available
 */

import { readFileSync, mkdirSync, writeFileSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { createWriteStream, unlinkSync } from 'fs';
import { createUnzip } from 'zlib';
import { pipeline } from 'stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const ALL = args.includes('--all');

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
const WM_CLIENT_ID = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/username"', { encoding: 'utf8' }).trim();
const WM_CLIENT_SECRET = execSync('op read "op://Agents Service Accounts/Walmart API Credentials/credential"', { encoding: 'utf8' }).trim();

const WALMART_CHANNEL_ID = '2da7e1e0-579e-4968-bdef-fa18492a6a86';
const CURSOR_FILE = join(__dirname, '..', '.locks', 'walmart-fees.cursor');

const stats = { reports: 0, fees_created: 0, skipped: 0, matched: 0, unmatched: 0, errors: 0, estimated_replaced: 0 };
function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Walmart auth ────────────────────────────────────────────────────
let wmToken = null, wmExpiry = 0;
async function getToken() {
    if (wmToken && Date.now() < wmExpiry) return wmToken;
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
    const data = await res.json();
    wmToken = data.access_token;
    wmExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return wmToken;
}

function wmHeaders() {
    return {
        'WM_SVC.NAME': 'Walmart Marketplace',
        'WM_QOS.CORRELATION_ID': `fees-${Date.now()}`,
        Authorization: 'Basic ' + Buffer.from(`${WM_CLIENT_ID}:${WM_CLIENT_SECRET}`).toString('base64'),
        'WM_SEC.ACCESS_TOKEN': wmToken,
        Accept: 'application/octet-stream'
    };
}

// ─── CSV parser ──────────────────────────────────────────────────────
function parseCSVLine(line) {
    const result = [];
    let current = '', inQuotes = false;
    for (const ch of line) {
        if (ch === '"') { inQuotes = !inQuotes; continue; }
        if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
        current += ch;
    }
    result.push(current.trim());
    return result;
}

function parseCSV(content) {
    const lines = content.split('\n').filter(l => l.trim());
    if (lines.length < 2) return [];
    const headers = parseCSVLine(lines[0]);
    return lines.slice(1).map(line => {
        const vals = parseCSVLine(line);
        const row = {};
        headers.forEach((h, i) => row[h] = vals[i] || '');
        return row;
    });
}

// ─── Supabase helpers ────────────────────────────────────────────────
const supaH = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };
const orderCache = {};
const estimatedCleaned = new Set();

async function findOrderId(orderNum) {
    if (orderCache[orderNum] !== undefined) return orderCache[orderNum];
    const res = await fetch(`${SUPA_URL}/rest/v1/orders?order_number=eq.${encodeURIComponent(orderNum)}&select=id`, { headers: supaH });
    const rows = await res.json();
    orderCache[orderNum] = rows?.[0]?.id || null;
    return orderCache[orderNum];
}

async function upsertFee(data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/channel_fees`, {
        method: 'POST',
        headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(data)
    });
    if (res.ok) return true;
    const body = await res.text();
    if (body.includes('23505') || body.includes('duplicate')) { stats.skipped++; return true; }
    stats.errors++;
    return false;
}

async function removeEstimatedFees(orderId) {
    // Remove placeholder fees (wm-estimated-*) when actual recon data arrives
    const res = await fetch(
        `${SUPA_URL}/rest/v1/channel_fees?order_id=eq.${orderId}&external_ref=like.wm-estimated-*`,
        { method: 'DELETE', headers: { ...supaH, Prefer: 'return=representation' } }
    );
    if (res.ok) {
        const removed = await res.json();
        if (removed.length) {
            log(`    ✓ Removed ${removed.length} estimated fee(s) for order ${orderId}`);
            stats.estimated_replaced += removed.length;
        }
    }
}

// ─── Fee type mapping ────────────────────────────────────────────────
function mapFeeType(amountType) {
    if (amountType.includes('Total Walmart Funded Savings')) return 'walmart_funded_incentive';
    if (amountType.includes('Commission')) return 'marketplace_commission';
    if (amountType.includes('Shipping')) return 'shipping_fee';
    if (amountType.includes('Return')) return 'return_fee';
    if (amountType.includes('Adjustment')) return 'adjustment';
    if (amountType.includes('WFS')) return 'fulfillment_fee';
    return 'other';
}

// ─── Cursor ──────────────────────────────────────────────────────────
function loadCursor() { try { return JSON.parse(readFileSync(CURSOR_FILE, 'utf8')); } catch { return { processed: [] }; } }
function saveCursor(data) { mkdirSync(dirname(CURSOR_FILE), { recursive: true }); writeFileSync(CURSOR_FILE, JSON.stringify(data)); }

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Walmart fees import starting');
    await getToken();

    // Get available report dates
    const listRes = await fetch(
        'https://marketplace.walmartapis.com/v3/report/reconreport/availableReconFiles?reportVersion=v1',
        { headers: { ...wmHeaders(), Accept: 'application/json' } }
    );
    const listData = await listRes.json();
    const dates = listData.availableApReportDates || [];
    log(`  ${dates.length} recon reports available`);

    const cursor = loadCursor();
    const processed = new Set(cursor.processed || []);
    const toProcess = ALL ? dates : dates.filter(d => !processed.has(d));
    log(`  ${toProcess.length} to process`);

    for (const reportDate of toProcess) {
        try {
            await getToken();
            const res = await fetch(
                `https://marketplace.walmartapis.com/v3/report/reconreport/reconFile?reportDate=${reportDate}&reportVersion=v1`,
                { headers: wmHeaders() }
            );

            if (!res.ok) {
                log(`  ⚠ Report ${reportDate}: ${res.status}`);
                stats.errors++;
                continue;
            }

            // Download ZIP and extract
            const zipPath = `/tmp/wm_recon_${reportDate}.zip`;
            const buffer = Buffer.from(await res.arrayBuffer());
            writeFileSync(zipPath, buffer);

            // Extract with unzip command
            const extractDir = `/tmp/wm_recon_${reportDate}`;
            execSync(`mkdir -p ${extractDir} && unzip -o ${zipPath} -d ${extractDir} 2>/dev/null`, { encoding: 'utf8' });
            const csvFiles = execSync(`ls ${extractDir}/*.csv 2>/dev/null`, { encoding: 'utf8' }).trim().split('\n').filter(f => f);

            if (!csvFiles.length) {
                log(`  ⚠ Report ${reportDate}: no CSV in ZIP`);
                continue;
            }

            const csvContent = readFileSync(csvFiles[0], 'utf8');
            const rows = parseCSV(csvContent);
            log(`  Report ${reportDate}: ${rows.length} rows`);

            // Extract payout info from PaymentSummary rows
            for (const row of rows) {
                if (row['Transaction Type'] === 'PaymentSummary' && row['Total Payable']) {
                    const payoutAmount = parseFloat(row['Total Payable']) || 0;
                    if (payoutAmount <= 0) continue;
                    function parseMDY(d) {
                        if (!d) return null;
                        const [m, dd, y] = d.split('/');
                        return `${y}-${m.padStart(2,'0')}-${dd.padStart(2,'0')}`;
                    }
                    const payoutData = {
                        channel_id: WALMART_CHANNEL_ID,
                        payout_date: parseMDY(row['Transaction Posted Timestamp']),
                        period_start: parseMDY(row['Period Start Date']),
                        period_end: parseMDY(row['Period End Date']),
                        gross_amount: payoutAmount,
                        fees_amount: 0,
                        refunds_amount: 0,
                        net_amount: payoutAmount,
                        currency_code: 'USD',
                        external_ref: `wm-payout-${reportDate}`,
                        status: 'deposited',
                        deposited_at: parseMDY(row['Transaction Posted Timestamp']),
                        raw_data: { report_date: reportDate, description: row['Transaction Description'] }
                    };
                    const payRes = await fetch(`${SUPA_URL}/rest/v1/payouts`, {
                        method: 'POST',
                        headers: { ...supaH, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates,return=minimal' },
                        body: JSON.stringify(payoutData)
                    });
                    if (payRes.ok) log(`    → Payout: $${payoutAmount.toFixed(2)} on ${payoutData.payout_date}`);
                }
            }

            let created = 0;
            for (const row of rows) {
                const orderNum = row['Customer Order #'];
                const amountType = row['Amount Type'] || '';
                const amount = parseFloat(row['Amount']) || 0;

                // Only import fee rows (commission, incentives, not product price/tax)
                if (!orderNum || !amountType.includes('Commission') && !amountType.includes('Return') && !amountType.includes('Adjustment') && !amountType.includes('Walmart Funded')) continue;

                const orderId = await findOrderId(orderNum);
                if (!orderId) { stats.unmatched++; continue; }
                stats.matched++;

                // Remove any estimated placeholder fees now that we have real recon data
                if (!estimatedCleaned.has(orderId)) {
                    await removeEstimatedFees(orderId);
                    estimatedCleaned.add(orderId);
                }

                const txKey = row['Transaction Key'] || `${reportDate}-${orderNum}-${row['Customer Order line #']}`;
                const externalRef = `wm-${txKey}-${amountType.replace(/\s+/g, '')}`;

                await upsertFee({
                    order_id: orderId,
                    channel_id: WALMART_CHANNEL_ID,
                    fee_type: mapFeeType(amountType),
                    description: amountType,
                    amount: Math.abs(amount),
                    currency_code: row['Currency'] || 'USD',
                    incurred_at: row['Transaction Posted Timestamp'] || null,
                    external_ref: externalRef,
                    metadata: {
                        report_date: reportDate,
                        sku: row['Partner Item Id'] || null,
                        commission_rate: row['Commission Rate'] || null,
                        transaction_type: row['Transaction Type'] || null,
                        transaction_key: txKey,
                        ...(row['Commission Saving'] ? { commission_saving: row['Commission Saving'] } : {}),
                        ...(row['Commission Incentive Program'] ? { commission_incentive_program: row['Commission Incentive Program'] } : {}),
                        ...(row['Customer Promo Type'] ? { customer_promo_type: row['Customer Promo Type'] } : {}),
                        ...(row['Total Walmart Funded Savings Program'] ? { walmart_funded_savings: row['Total Walmart Funded Savings Program'] } : {}),
                        ...(row['Incentive Program Name'] ? { incentive_program: row['Incentive Program Name'] } : {}),
                        ...(row['Original charge'] ? { original_charge: row['Original charge'] } : {}),
                        ...(row['Charge Savings'] ? { charge_savings: row['Charge Savings'] } : {})
                    }
                });
                created++;
            }

            stats.fees_created += created;
            stats.reports++;
            processed.add(reportDate);
            log(`    → ${created} fees imported`);

            // Cleanup
            try { unlinkSync(zipPath); execSync(`rm -rf ${extractDir}`); } catch {}
            await sleep(1000);
        } catch (e) {
            log(`  ⚠ Report ${reportDate}: ${e.message}`);
            stats.errors++;
        }
    }

    saveCursor({ processed: [...processed] });

    log('────────────────────────────────────');
    log(`Done! Reports: ${stats.reports}`);
    log(`  Fees created:  ${stats.fees_created}`);
    log(`  Skipped dupes: ${stats.skipped}`);
    log(`  Orders matched: ${stats.matched}`);
    log(`  Unmatched:     ${stats.unmatched}`);
    log(`  Est. replaced: ${stats.estimated_replaced}`);
    log(`  Errors:        ${stats.errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
