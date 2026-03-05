#!/usr/bin/env node

/**
 * Amazon Advertising Spend → Supabase channel_fees
 *
 * Strategy:
 *   1. Try Amazon Advertising API (advertising-api.amazon.com)
 *      - Uses same LWA credentials as SP-API but needs an advertising profile
 *      - GET /v2/profiles → find seller advertising profile
 *      - POST /reporting/reports → request Sponsored Products campaign report
 *      - GET /reporting/reports/{id} → download completed report
 *
 *   2. Fallback: Mine settlement reports via SP-API
 *      - GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2 contains ad fee rows
 *      - Look for amount-type = 'Advertising' or descriptions containing
 *        'Sponsored', 'Advertising', 'CPC'
 *      - Also scan "other-transaction" rows
 *
 * Stores ad spend in channel_fees with fee_type='advertising'.
 *
 * Usage:
 *   node amazon-ads.mjs                    # Normal run
 *   node amazon-ads.mjs --settlement-only  # Skip Ads API, only mine settlements
 *   node amazon-ads.mjs --days 30          # Look back N days (default: 14)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const SETTLEMENT_ONLY = args.includes('--settlement-only');
const DAYS_BACK = parseInt(args[args.indexOf('--days') + 1]) || 14;

// ─── Env & Secrets ───────────────────────────────────────────────────
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
const ADS_API_BASE = 'https://advertising-api.amazon.com';
const CURSOR_FILE = join(__dirname, '..', '.locks', 'amazon-ads.cursor');

const stats = {
    ads_api_available: false,
    profiles_found: 0,
    ad_reports_processed: 0,
    settlement_reports_scanned: 0,
    ad_fees_created: 0,
    ad_fees_skipped: 0,
    orders_matched: 0,
    orders_unmatched: 0,
    errors: 0
};

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Token management (same LWA as SP-API) ──────────────────────────
let accessToken = null, tokenExpiry = 0;
async function getToken() {
    if (accessToken && Date.now() < tokenExpiry) return accessToken;
    const res = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grant_type=refresh_token&refresh_token=${REFRESH_TOKEN}&client_id=${LWA_CLIENT_ID}&client_secret=${LWA_CLIENT_SECRET}`
    });
    const data = await res.json();
    if (!data.access_token) throw new Error(`LWA token error: ${JSON.stringify(data)}`);
    accessToken = data.access_token;
    tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
    return accessToken;
}

// ─── SP-API helpers ──────────────────────────────────────────────────
async function spApiGet(path) {
    const token = await getToken();
    const res = await fetch(`${SP_API_BASE}${path}`, {
        headers: { 'x-amz-access-token': token }
    });
    if (res.status === 429) { await sleep(10000); return spApiGet(path); }
    if (!res.ok) throw new Error(`SP-API ${res.status}: ${await res.text()}`);
    return res.json();
}

// ─── Amazon Ads API helpers ──────────────────────────────────────────
async function adsApiRequest(method, path, body = null, profileId = null) {
    const token = await getToken();
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Amazon-Advertising-API-ClientId': LWA_CLIENT_ID,
        'Content-Type': 'application/json'
    };
    if (profileId) headers['Amazon-Advertising-API-Scope'] = String(profileId);

    const opts = { method, headers };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${ADS_API_BASE}${path}`, opts);
    if (res.status === 429) { await sleep(5000); return adsApiRequest(method, path, body, profileId); }
    return { status: res.status, data: res.ok ? await res.json() : await res.text() };
}

// ─── Supabase helpers ────────────────────────────────────────────────
const supaHeaders = { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` };

async function findOrderId(orderNumber) {
    const res = await fetch(
        `${SUPA_URL}/rest/v1/orders?order_number=eq.${orderNumber}&select=id`,
        { headers: supaHeaders }
    );
    const rows = await res.json();
    return rows?.[0]?.id || null;
}

async function upsertAdFee(data) {
    const res = await fetch(`${SUPA_URL}/rest/v1/channel_fees`, {
        method: 'POST',
        headers: {
            ...supaHeaders,
            'Content-Type': 'application/json',
            Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(data)
    });
    if (res.ok) { stats.ad_fees_created++; return true; }
    const body = await res.text();
    if (body.includes('23505') || body.includes('duplicate')) { stats.ad_fees_skipped++; return true; }
    stats.errors++;
    log(`  ⚠ Upsert error: ${body.slice(0, 200)}`);
    return false;
}

// ─── Cursor management ──────────────────────────────────────────────
function loadCursor() {
    try { return JSON.parse(readFileSync(CURSOR_FILE, 'utf8')); }
    catch { return { last_settlement_id: null, last_ads_date: null }; }
}
function saveCursor(cursor) {
    mkdirSync(dirname(CURSOR_FILE), { recursive: true });
    writeFileSync(CURSOR_FILE, JSON.stringify(cursor, null, 2));
}

// ─── Strategy 1: Amazon Advertising API ─────────────────────────────
async function tryAdsApi() {
    log('Attempting Amazon Advertising API...');

    // Step 1: Get advertising profiles
    const profilesRes = await adsApiRequest('GET', '/v2/profiles');
    if (profilesRes.status === 401 || profilesRes.status === 403) {
        log(`  ❌ Ads API not authorized (HTTP ${profilesRes.status})`);
        log('  → The Amazon Advertising API requires separate registration.');
        log('  → See supabase/sync/README-amazon-ads.md for setup instructions.');
        return false;
    }
    if (profilesRes.status !== 200) {
        log(`  ❌ Ads API returned ${profilesRes.status}: ${typeof profilesRes.data === 'string' ? profilesRes.data.slice(0, 200) : JSON.stringify(profilesRes.data).slice(0, 200)}`);
        return false;
    }

    const profiles = profilesRes.data;
    if (!Array.isArray(profiles) || profiles.length === 0) {
        log('  ❌ No advertising profiles found');
        return false;
    }

    stats.ads_api_available = true;
    stats.profiles_found = profiles.length;
    log(`  ✅ Found ${profiles.length} advertising profile(s)`);

    // Find the seller profile (not vendor)
    const sellerProfile = profiles.find(p =>
        p.accountInfo?.type === 'seller' && p.countryCode === 'US'
    ) || profiles[0];

    const profileId = sellerProfile.profileId;
    log(`  Using profile ${profileId} (${sellerProfile.accountInfo?.name || 'unknown'})`);

    // Step 2: Request Sponsored Products campaign report
    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - DAYS_BACK * 86400000).toISOString().split('T')[0];

    log(`  Requesting SP campaign report: ${startDate} → ${endDate}`);

    const reportReq = await adsApiRequest('POST', '/reporting/reports', {
        reportDate: endDate,
        configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            groupBy: ['campaign'],
            columns: ['campaignName', 'campaignId', 'impressions', 'clicks', 'cost', 'date'],
            reportTypeId: 'spCampaigns',
            timeUnit: 'DAILY',
            format: 'GZIP_JSON'
        },
        startDate,
        endDate
    }, profileId);

    if (reportReq.status !== 200 && reportReq.status !== 202) {
        log(`  ⚠ Report request failed (${reportReq.status}): ${JSON.stringify(reportReq.data).slice(0, 300)}`);
        return false;
    }

    const reportId = reportReq.data?.reportId;
    if (!reportId) {
        log('  ⚠ No reportId in response');
        return false;
    }

    log(`  Report requested: ${reportId}, polling for completion...`);

    // Step 3: Poll for report completion (up to 5 minutes)
    let reportData = null;
    for (let i = 0; i < 30; i++) {
        await sleep(10000);
        const statusRes = await adsApiRequest('GET', `/reporting/reports/${reportId}`, null, profileId);
        if (statusRes.status !== 200) continue;

        const status = statusRes.data?.status;
        if (status === 'COMPLETED') {
            const downloadUrl = statusRes.data?.url;
            if (downloadUrl) {
                const dlRes = await fetch(downloadUrl);
                // Response is gzipped JSON
                const buffer = await dlRes.arrayBuffer();
                const { gunzipSync } = await import('zlib');
                const text = gunzipSync(Buffer.from(buffer)).toString('utf8');
                reportData = JSON.parse(text);
                break;
            }
        } else if (status === 'FAILURE') {
            log(`  ⚠ Report generation failed`);
            return false;
        }
        log(`    Status: ${status} (attempt ${i + 1}/30)`);
    }

    if (!reportData || !Array.isArray(reportData)) {
        log('  ⚠ Report timed out or no data');
        return false;
    }

    log(`  Got ${reportData.length} campaign report rows`);

    // Step 4: Store campaign-level ad spend as channel_fees
    for (const row of reportData) {
        const cost = parseFloat(row.cost) || 0;
        if (cost === 0) continue;

        const date = row.date || endDate;
        const externalRef = `ads-${profileId}-${row.campaignId}-${date}`;

        await upsertAdFee({
            channel_id: AMAZON_CHANNEL_ID,
            order_id: null,  // Campaign-level spend, not order-level
            fee_type: 'advertising',
            description: `Sponsored Products: ${row.campaignName || row.campaignId}`,
            amount: cost,
            currency_code: 'USD',
            incurred_at: date,
            external_ref: externalRef,
            metadata: {
                source: 'ads_api',
                campaign_id: row.campaignId,
                campaign_name: row.campaignName,
                impressions: row.impressions,
                clicks: row.clicks,
                profile_id: profileId
            }
        });
    }

    stats.ad_reports_processed++;
    return true;
}

// ─── Strategy 2: Mine settlement reports for ad fees ─────────────────
async function mineSettlements() {
    log('Mining settlement reports for advertising fees...');

    const reportsData = await spApiGet(
        `/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&pageSize=20`
    );
    const reports = reportsData.reports?.filter(r => r.processingStatus === 'DONE') || [];
    log(`  Found ${reports.length} settlement reports to scan`);

    const cursor = loadCursor();
    let foundAny = false;
    const orderCache = {};

    for (const report of reports.reverse()) {
        try {
            const reportObj = await spApiGet(`/reports/2021-06-30/reports/${report.reportId}`);
            const docId = reportObj.reportDocumentId;
            if (!docId) continue;

            const doc = await spApiGet(`/reports/2021-06-30/documents/${docId}`);
            const tsvRes = await fetch(doc.url);
            const tsv = await tsvRes.text();
            const lines = tsv.split('\n').filter(l => l.trim());
            if (lines.length < 2) continue;

            const headers = lines[0].split('\t');
            const rows = lines.slice(1).map(line => {
                const vals = line.split('\t');
                const row = {};
                headers.forEach((h, i) => row[h] = vals[i] || '');
                return row;
            });

            stats.settlement_reports_scanned++;
            const settlementId = rows[0]?.['settlement-id'] || report.reportId;
            let adRowCount = 0;

            for (const row of rows) {
                const amountType = (row['amount-type'] || '').toLowerCase();
                const amountDesc = (row['amount-description'] || '').toLowerCase();
                const transType = (row['transaction-type'] || '').toLowerCase();

                // Match advertising-related entries
                const isAdFee =
                    amountType.includes('advertising') ||
                    amountType.includes('sponsored') ||
                    amountDesc.includes('advertising') ||
                    amountDesc.includes('sponsored') ||
                    amountDesc.includes('cpc') ||
                    amountDesc.includes('cost per click') ||
                    (transType === 'other-transaction' && (
                        amountDesc.includes('advertis') ||
                        amountDesc.includes('sponsor')
                    ));

                if (!isAdFee) continue;

                const amount = Math.abs(parseFloat(row['amount']) || 0);
                if (amount === 0) continue;

                adRowCount++;
                foundAny = true;

                // Try to match to an order
                const orderNum = row['order-id'];
                let orderId = null;
                if (orderNum) {
                    if (orderCache[orderNum] === undefined) {
                        orderCache[orderNum] = await findOrderId(orderNum);
                    }
                    orderId = orderCache[orderNum];
                    if (orderId) stats.orders_matched++;
                    else stats.orders_unmatched++;
                }

                const externalRef = `ads-settlement-${settlementId}-${orderNum || 'none'}-${row['order-item-code'] || adRowCount}`;

                await upsertAdFee({
                    order_id: orderId,
                    channel_id: AMAZON_CHANNEL_ID,
                    fee_type: 'advertising',
                    description: row['amount-description'] || 'Advertising Fee',
                    amount,
                    currency_code: row['currency'] || 'USD',
                    incurred_at: row['posted-date-time'] || row['posted-date'] || null,
                    external_ref: externalRef,
                    metadata: {
                        source: 'settlement',
                        settlement_id: settlementId,
                        sku: row['sku'] || null,
                        amount_type: row['amount-type'],
                        amount_description: row['amount-description'],
                        transaction_type: row['transaction-type'],
                        order_item_code: row['order-item-code'] || null
                    }
                });
            }

            if (adRowCount > 0) {
                log(`    Settlement ${settlementId}: ${adRowCount} ad fee rows`);
            }

            await sleep(2000);
        } catch (e) {
            log(`  ⚠ Report ${report.reportId}: ${e.message}`);
            stats.errors++;
        }
    }

    if (!foundAny) {
        log('  ℹ No advertising fees found in settlement reports.');
        log('  → This is expected if you use Sponsored Products — those charges');
        log('    appear on your credit card, not in settlement reports.');
        log('  → Set up the Amazon Advertising API for campaign-level spend data.');
        log('  → See supabase/sync/README-amazon-ads.md');
    }

    // Save cursor
    if (reports.length > 0) {
        saveCursor({ ...cursor, last_settlement_id: reports[reports.length - 1].reportId });
    }
}

// ─── Main ────────────────────────────────────────────────────────────
async function main() {
    log('Amazon advertising spend import starting');
    log(`  Lookback: ${DAYS_BACK} days`);

    let adsApiWorked = false;

    if (!SETTLEMENT_ONLY) {
        try {
            adsApiWorked = await tryAdsApi();
        } catch (e) {
            log(`  ⚠ Ads API error: ${e.message}`);
        }
    }

    // Always scan settlements for ad fees (complementary data)
    await mineSettlements();

    log('────────────────────────────────────');
    log('Amazon Ads Import Complete');
    log(`  Ads API available:       ${stats.ads_api_available ? 'YES' : 'NO'}`);
    log(`  Ads API profiles:        ${stats.profiles_found}`);
    log(`  Campaign reports:        ${stats.ad_reports_processed}`);
    log(`  Settlement reports:      ${stats.settlement_reports_scanned}`);
    log(`  Ad fees created:         ${stats.ad_fees_created}`);
    log(`  Ad fees deduplicated:    ${stats.ad_fees_skipped}`);
    log(`  Orders matched:          ${stats.orders_matched}`);
    log(`  Orders unmatched:        ${stats.orders_unmatched}`);
    log(`  Errors:                  ${stats.errors}`);
}

main().catch(e => { console.error(e); process.exit(1); });
