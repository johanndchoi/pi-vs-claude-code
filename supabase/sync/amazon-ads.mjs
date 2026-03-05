#!/usr/bin/env node

/**
 * Amazon Advertising → Supabase Ad Spend Sync
 *
 * Pulls Sponsored Products campaign data from the Amazon Advertising API
 * and stores daily ad spend in channel_fees with fee_type='advertising'.
 *
 * Prerequisites:
 *   - Amazon Advertising API access (see README-amazon-ads.md)
 *   - Advertising profile ID stored in 1Password
 *
 * Usage:
 *   node amazon-ads.mjs                      # Sync last 14 days
 *   node amazon-ads.mjs --since 2026-01-01   # Since specific date
 *   node amazon-ads.mjs --dry-run            # Preview only
 *   node amazon-ads.mjs --check-settlements  # Check settlement data for ad fees
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CHECK_SETTLEMENTS = args.includes('--check-settlements');
const sinceArg = args.find((_, i) => args[i - 1] === '--since');
const CURSOR_FILE = join(__dirname, '..', '.locks', 'amazon-ads.cursor');

// ─── Env & Credentials ──────────────────────────────────────────────
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

const AMAZON_CHANNEL_ID = '7f84462f-86c8-4e09-abb6-285631db0d83';

function log(msg) { console.log(`[${new Date().toLocaleTimeString()}] ${msg}`); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

function opRead(ref) {
    return execSync(`op read "${ref}"`, {
        encoding: 'utf8',
        env: { ...process.env }
    }).trim();
}

// ─── Supabase helpers ────────────────────────────────────────────────
async function supaRest(method, table, params = '', body = null) {
    const url = `${SUPA_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
    const opts = {
        method,
        headers: {
            'apikey': SUPA_KEY,
            'Authorization': `Bearer ${SUPA_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': method === 'POST' ? 'resolution=merge-duplicates,return=minimal' : 'return=minimal'
        }
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(url, opts);
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Supabase ${method} ${table}: ${resp.status} ${text}`);
    }
    if (resp.status === 204) return null;
    return resp.json();
}

// ─── Amazon LWA Auth ─────────────────────────────────────────────────
async function getAccessToken() {
    const clientId = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/LWACredentials');
    const clientSecret = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/ClientSecret');
    const refreshToken = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/SellerRefreshToken');

    const resp = await fetch('https://api.amazon.com/auth/o2/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
        })
    });

    if (!resp.ok) throw new Error(`LWA auth failed: ${resp.status}`);
    const data = await resp.json();
    return { accessToken: data.access_token, clientId };
}

// ─── Amazon Advertising API ──────────────────────────────────────────
const ADS_API_BASE = 'https://advertising-api.amazon.com';

async function getAdProfiles(accessToken, clientId) {
    let resp;
    try {
        resp = await fetch(`${ADS_API_BASE}/v2/profiles`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Amazon-Advertising-API-ClientId': clientId,
                'Content-Type': 'application/json',
            }
        });
    } catch (err) {
        return { error: 'network', message: `Cannot reach Advertising API: ${err.message}` };
    }

    if (resp.status === 401) {
        return { error: 'unauthorized', message: 'LWA credentials not authorized for Advertising API. See README-amazon-ads.md.' };
    }
    if (resp.status === 403) {
        return { error: 'forbidden', message: 'App not registered for Amazon Advertising API. See README-amazon-ads.md.' };
    }
    if (!resp.ok) {
        const text = await resp.text();
        return { error: 'api_error', message: `Advertising API returned ${resp.status}: ${text}` };
    }

    return { profiles: await resp.json() };
}

async function requestSpReport(accessToken, clientId, profileId, reportDate) {
    // Request a Sponsored Products campaign report for a specific date
    const resp = await fetch(`${ADS_API_BASE}/v2/sp/campaigns/report`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': profileId,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            reportDate,
            metrics: 'campaignName,campaignId,impressions,clicks,cost,campaignStatus',
        })
    });

    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`SP report request failed: ${resp.status} ${text}`);
    }
    return resp.json(); // { reportId, recordType, status, statusDetails }
}

async function pollReportStatus(accessToken, clientId, profileId, reportId) {
    for (let i = 0; i < 30; i++) {
        await sleep(10000); // 10s intervals
        const resp = await fetch(`${ADS_API_BASE}/v2/reports/${reportId}`, {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Amazon-Advertising-API-ClientId': clientId,
                'Amazon-Advertising-API-Scope': profileId,
            }
        });
        if (!resp.ok) throw new Error(`Report status check failed: ${resp.status}`);
        const data = await resp.json();
        if (data.status === 'SUCCESS') return data.location; // download URL
        if (data.status === 'FAILURE') throw new Error(`Report generation failed: ${data.statusDetails}`);
        log(`  Report ${reportId}: ${data.status}...`);
    }
    throw new Error('Report generation timed out (5 min)');
}

async function downloadReport(accessToken, clientId, profileId, downloadUrl) {
    const resp = await fetch(downloadUrl, {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Amazon-Advertising-API-ClientId': clientId,
            'Amazon-Advertising-API-Scope': profileId,
        }
    });
    if (!resp.ok) throw new Error(`Report download failed: ${resp.status}`);
    return resp.json(); // Array of campaign records
}

// ─── Settlement Fallback: Check for ad fees in existing data ─────────
async function checkSettlementsForAdFees() {
    log('Checking settlement data for advertising-related fees...');

    // Check all distinct descriptions in channel_fees
    const fees = await supaRest('GET', 'channel_fees',
        `select=description,fee_type,amount&channel_id=eq.${AMAZON_CHANNEL_ID}&limit=10000`);

    const descMap = {};
    for (const f of fees) {
        if (!descMap[f.description]) descMap[f.description] = { count: 0, total: 0, fee_type: f.fee_type };
        descMap[f.description].count++;
        descMap[f.description].total += f.amount;
    }

    log('Current fee descriptions in channel_fees:');
    for (const [desc, info] of Object.entries(descMap).sort((a, b) => a[0].localeCompare(b[0]))) {
        log(`  ${desc.padEnd(45)} type=${info.fee_type.padEnd(25)} count=${String(info.count).padStart(5)}  total=$${info.total.toFixed(2)}`);
    }

    // Check for any that might be ad-related
    const adKeywords = ['advertis', 'sponsor', 'campaign', 'ppc', 'cpc', 'cost-per-click'];
    const adRelated = Object.entries(descMap).filter(([desc]) =>
        adKeywords.some(kw => desc.toLowerCase().includes(kw))
    );

    if (adRelated.length > 0) {
        log('\n⚠️  Potentially advertising-related fees found:');
        for (const [desc, info] of adRelated) {
            log(`  ${desc}: ${info.count} records, $${info.total.toFixed(2)}`);
        }
    } else {
        log('\n📋 No advertising-related fees found in settlement data.');
        log('   Amazon bills ad spend separately (credit card), not through settlements.');
        log('   The Amazon Advertising API is needed. See README-amazon-ads.md.');
    }
}

// ─── SP-API Settlement Report Scan (deeper check) ───────────────────
async function scanSettlementReportsForAdData() {
    log('Scanning raw SP-API settlement reports for advertising line items...');

    const { accessToken, clientId } = await getAccessToken();
    const marketplaceId = opRead('op://Agents Service Accounts/Amazon SP-API Credentials/MarketplaceId');

    // Get recent settlement reports
    const reportsResp = await fetch(
        `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&pageSize=5`,
        { headers: { 'x-amz-access-token': accessToken } }
    );
    if (!reportsResp.ok) throw new Error(`SP-API reports list: ${reportsResp.status}`);
    const { reports } = await reportsResp.json();

    const allAmountTypes = new Set();

    for (const report of reports.slice(0, 3)) {
        log(`  Scanning report ${report.reportId} (${report.dataStartTime.slice(0, 10)} → ${report.dataEndTime.slice(0, 10)})...`);

        const docResp = await fetch(
            `https://sellingpartnerapi-na.amazon.com/reports/2021-06-30/documents/${report.reportDocumentId}`,
            { headers: { 'x-amz-access-token': accessToken } }
        );
        if (!docResp.ok) continue;
        const docData = await docResp.json();
        const dataResp = await fetch(docData.url);
        const text = await dataResp.text();

        const lines = text.split('\n');
        const headers = lines[0].split('\t');
        const amtTypeIdx = headers.indexOf('amount-type');
        const amtDescIdx = headers.indexOf('amount-description');
        const txnTypeIdx = headers.indexOf('transaction-type');

        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split('\t');
            if (cols[amtTypeIdx] || cols[amtDescIdx]) {
                const key = `${cols[txnTypeIdx] || '?'}|${cols[amtTypeIdx]}|${cols[amtDescIdx]}`;
                allAmountTypes.add(key);
            }
        }
        await sleep(1000);
    }

    log('\n  All transaction-type | amount-type | amount-description combos:');
    for (const t of [...allAmountTypes].sort()) {
        const lower = t.toLowerCase();
        const isAd = ['advertis', 'sponsor', 'campaign', 'ppc'].some(k => lower.includes(k));
        log(`    ${isAd ? '🎯 ' : '   '}${t}`);
    }

    const adTypes = [...allAmountTypes].filter(t => {
        const lower = t.toLowerCase();
        return ['advertis', 'sponsor', 'campaign', 'ppc'].some(k => lower.includes(k));
    });

    if (adTypes.length === 0) {
        log('\n❌ No advertising-related line items found in settlement reports.');
        log('   Amazon ad spend is billed to credit card, not deducted from settlements.');
    }
    return adTypes;
}

// ─── Main: Advertising API Sync ──────────────────────────────────────
async function syncAdSpend() {
    const stats = { days_processed: 0, campaigns_found: 0, fees_upserted: 0, errors: 0 };

    log('Amazon Advertising Spend Sync');
    log('─'.repeat(50));

    // Determine date range
    let sinceDate;
    if (sinceArg) {
        sinceDate = sinceArg;
    } else if (existsSync(CURSOR_FILE)) {
        sinceDate = readFileSync(CURSOR_FILE, 'utf8').trim();
    } else {
        // Default: 14 days back
        const d = new Date();
        d.setDate(d.getDate() - 14);
        sinceDate = d.toISOString().split('T')[0];
    }

    const endDate = new Date().toISOString().split('T')[0];
    log(`Date range: ${sinceDate} → ${endDate}`);

    // Step 1: Get access token
    let accessToken, clientId;
    try {
        ({ accessToken, clientId } = await getAccessToken());
        log('✅ LWA authentication successful');
    } catch (err) {
        log(`❌ LWA auth failed: ${err.message}`);
        process.exit(1);
    }

    // Step 2: Try to get advertising profiles
    log('Fetching advertising profiles...');
    const profileResult = await getAdProfiles(accessToken, clientId);

    if (profileResult.error) {
        log(`⚠️  Advertising API not available: ${profileResult.message}`);
        if (profileResult.error === 'network') {
            log('   (Could not reach advertising-api.amazon.com — network/DNS issue or API not enabled)');
        }
        log('');
        log('Falling back to settlement data analysis...');

        // Fallback 1: Check channel_fees for any miscategorized ad fees
        await checkSettlementsForAdFees();

        // Fallback 2: Scan raw settlement reports
        log('');
        await scanSettlementReportsForAdData();

        log('');
        log('════════════════════════════════════════════════');
        log('ACTION REQUIRED: Set up Amazon Advertising API access.');
        log('See README-amazon-ads.md for instructions.');
        log('════════════════════════════════════════════════');
        process.exit(0);
    }

    // Step 3: Find the seller profile for US marketplace
    const profiles = profileResult.profiles;
    log(`Found ${profiles.length} advertising profile(s)`);

    const usProfile = profiles.find(p =>
        p.countryCode === 'US' && p.accountInfo?.type === 'seller'
    ) || profiles[0];

    if (!usProfile) {
        log('❌ No advertising profiles found. You may need to create campaigns first.');
        process.exit(1);
    }

    const profileId = String(usProfile.profileId);
    log(`Using profile: ${usProfile.accountInfo?.name || 'Unknown'} (${profileId}, ${usProfile.countryCode})`);

    // Step 4: Request reports for each day in range
    const dates = [];
    const current = new Date(sinceDate);
    const end = new Date(endDate);
    while (current <= end) {
        dates.push(current.toISOString().split('T')[0].replace(/-/g, ''));
        current.setDate(current.getDate() + 1);
    }

    log(`Processing ${dates.length} days...`);

    for (const reportDate of dates) {
        try {
            log(`  📊 ${reportDate}...`);

            // Request report
            const reportReq = await requestSpReport(accessToken, clientId, profileId, reportDate);
            log(`    Report requested: ${reportReq.reportId}`);

            // Poll for completion
            const downloadUrl = await pollReportStatus(accessToken, clientId, profileId, reportReq.reportId);

            // Download report data
            const campaigns = await downloadReport(accessToken, clientId, profileId, downloadUrl);
            stats.campaigns_found += campaigns.length;

            if (campaigns.length === 0) {
                log(`    No campaign data for ${reportDate}`);
                stats.days_processed++;
                continue;
            }

            // Step 5: Upsert to channel_fees
            const feeRows = campaigns
                .filter(c => c.cost > 0)
                .map(c => ({
                    channel_id: AMAZON_CHANNEL_ID,
                    fee_type: 'advertising',
                    description: `SP: ${c.campaignName || 'Campaign ' + c.campaignId}`,
                    amount: parseFloat(c.cost.toFixed(2)),
                    currency_code: 'USD',
                    incurred_at: `${reportDate.slice(0, 4)}-${reportDate.slice(4, 6)}-${reportDate.slice(6, 8)}T00:00:00Z`,
                    external_ref: `ads-sp-${c.campaignId}-${reportDate}`,
                    metadata: {
                        campaign_id: c.campaignId,
                        campaign_name: c.campaignName,
                        campaign_status: c.campaignStatus,
                        impressions: c.impressions,
                        clicks: c.clicks,
                        cost: c.cost,
                        profile_id: profileId,
                        report_date: reportDate,
                    }
                }));

            if (feeRows.length > 0 && !DRY_RUN) {
                await supaRest('POST', 'channel_fees', 'on_conflict=external_ref', feeRows);
                stats.fees_upserted += feeRows.length;
                log(`    ✅ ${feeRows.length} campaign fee(s) upserted, total spend: $${feeRows.reduce((s, r) => s + r.amount, 0).toFixed(2)}`);
            } else if (feeRows.length > 0) {
                log(`    [DRY RUN] Would upsert ${feeRows.length} fee(s): $${feeRows.reduce((s, r) => s + r.amount, 0).toFixed(2)}`);
            }

            stats.days_processed++;
            await sleep(2000); // Rate limiting
        } catch (err) {
            log(`    ❌ Error for ${reportDate}: ${err.message}`);
            stats.errors++;
        }
    }

    // Update cursor
    if (!DRY_RUN && stats.days_processed > 0) {
        writeFileSync(CURSOR_FILE, endDate);
    }

    log('');
    log('═══ Sync complete ═══');
    log(`  Days processed: ${stats.days_processed}`);
    log(`  Campaigns found: ${stats.campaigns_found}`);
    log(`  Fees upserted: ${stats.fees_upserted}`);
    log(`  Errors: ${stats.errors}`);
}

// ─── Entry point ─────────────────────────────────────────────────────
async function main() {
    if (CHECK_SETTLEMENTS) {
        await checkSettlementsForAdFees();
        console.log('');
        await scanSettlementReportsForAdData();
        return;
    }
    await syncAdSpend();
}

main().catch(err => {
    console.error(`Fatal: ${err.message}`);
    process.exit(1);
});
