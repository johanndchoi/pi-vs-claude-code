#!/usr/bin/env node

/**
 * Sync Cron Runner
 * Runs incremental syncs with per-API lock files to prevent concurrent access.
 *
 * Usage:
 *   node cron.mjs                    # Run all due syncs
 *   node cron.mjs --job veeqo-orders # Run specific job
 *   node cron.mjs --list             # Show job schedule
 *   node cron.mjs --status           # Show lock status
 *
 * Designed to be called from system cron every 15 minutes:
 *   (every 15 min) cd /path/to/supabase/sync && node cron.mjs >> /tmp/snatch-it-cron.log 2>&1
 */

import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { execSync, spawn } from 'child_process';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_DIR = join(__dirname, '..', '.locks');
const args = process.argv.slice(2);

// Ensure lock directory exists
mkdirSync(LOCK_DIR, { recursive: true });

// ─── Job definitions ─────────────────────────────────────────────────
// api_group: jobs in the same group will never run concurrently
// interval_min: minimum minutes between runs
const JOBS = {
    'veeqo-orders': {
        script: 'veeqo-orders.mjs',
        api_group: 'veeqo',
        interval_min: 60,        // Every hour
        description: 'Incremental Veeqo order sync (uses cursor)'
    },
    'veeqo-products': {
        script: 'veeqo-products.mjs',
        api_group: 'veeqo',
        interval_min: 360,       // Every 6 hours
        description: 'Full Veeqo product/inventory sync'
    },
    'veeqo-tracking': {
        script: 'veeqo-tracking.mjs',
        args: ['--recent', '500'],
        api_group: 'veeqo',
        interval_min: 120,       // Every 2 hours
        description: 'Update tracking events for recent shipments'
    },
    'shipstation-shipments': {
        script: 'shipstation-shipments.mjs',
        args: ['--since', 'auto'], // Will be replaced with last run date
        api_group: 'shipstation',
        interval_min: 360,       // Every 6 hours
        description: 'Incremental ShipStation label sync'
    },
    'walmart-enrich': {
        script: 'walmart-enrich.mjs',
        args: ['--since', 'auto'],
        api_group: 'walmart',
        interval_min: 360,       // Every 6 hours
        description: 'Enrich Walmart orders with API data'
    },
    'amazon-enrich': {
        script: 'amazon-enrich.mjs',
        api_group: 'amazon',
        interval_min: 360,       // Every 6 hours
        description: 'Enrich Amazon orders with tax/shipping from SP-API'
    },
    'returns-sync': {
        script: 'returns-sync.mjs',
        api_group: 'amazon',
        interval_min: 720,       // Every 12 hours
        description: 'Sync returns from Amazon reports + Walmart API'
    },
    'walmart-fees': {
        script: 'walmart-fees.mjs',
        api_group: 'walmart',
        interval_min: 720,       // Every 12 hours
        description: 'Import Walmart recon reports (commissions, fees)'
    },
    'amazon-settlements': {
        script: 'amazon-settlements.mjs',
        api_group: 'amazon',
        interval_min: 720,       // Every 12 hours
        description: 'Import Amazon settlement reports (fees, commissions)'
    },
    'sellersnap-costs': {
        script: 'sellersnap-costs.mjs',
        api_group: 'sellersnap',
        interval_min: 1440,      // Every 24 hours
        description: 'Sync product costs from SellerSnap'
    },
    'inventory-snapshot': {
        script: 'inventory-snapshot.mjs',
        api_group: 'veeqo',
        interval_min: 1440,      // Once per day (runs at 6am via cron)
        description: 'Daily inventory snapshot for sell-through analysis'
    },
    'amazon-ads': {
        script: 'amazon-ads.mjs',
        api_group: 'amazon',
        interval_min: 1440,      // Daily
        description: 'Import Amazon advertising spend (Ads API + settlement mining)'
    }
};

// ─── Lock management ─────────────────────────────────────────────────
function lockPath(group) { return join(LOCK_DIR, `${group}.lock`); }
function lastRunPath(job) { return join(LOCK_DIR, `${job}.lastrun`); }

function isLocked(group) {
    const lp = lockPath(group);
    if (!existsSync(lp)) return false;
    try {
        const data = JSON.parse(readFileSync(lp, 'utf8'));
        const pid = data.pid;
        // Check if process is still running
        try {
            process.kill(pid, 0);
            // Process exists — check if it's been running too long (2 hours max)
            const age = Date.now() - data.started;
            if (age > 2 * 60 * 60 * 1000) {
                log(`  ⚠ Stale lock for ${group} (PID ${pid}, ${Math.round(age / 60000)}min old) — removing`);
                unlinkSync(lp);
                return false;
            }
            return true;
        } catch {
            // Process doesn't exist — stale lock
            unlinkSync(lp);
            return false;
        }
    } catch {
        unlinkSync(lp);
        return false;
    }
}

function acquireLock(group, jobName) {
    if (isLocked(group)) return false;
    writeFileSync(lockPath(group), JSON.stringify({
        pid: process.pid,
        job: jobName,
        started: Date.now(),
        started_at: new Date().toISOString()
    }));
    return true;
}

function releaseLock(group) {
    try { unlinkSync(lockPath(group)); } catch {}
}

function getLastRun(job) {
    try {
        return readFileSync(lastRunPath(job), 'utf8').trim();
    } catch {
        return null;
    }
}

function setLastRun(job) {
    writeFileSync(lastRunPath(job), new Date().toISOString());
}

function isDue(job) {
    const config = JOBS[job];
    const lastRun = getLastRun(job);
    if (!lastRun) return true;
    const elapsed = (Date.now() - new Date(lastRun).getTime()) / 60000;
    return elapsed >= config.interval_min;
}

// ─── Logging ─────────────────────────────────────────────────────────
function log(msg) {
    console.log(`[${new Date().toISOString().replace('T', ' ').split('.')[0]}] ${msg}`);
}

// ─── Auto-date for --since args ──────────────────────────────────────
function resolveArgs(job, jobArgs) {
    if (!jobArgs) return [];
    return jobArgs.map(arg => {
        if (arg === 'auto') {
            const lastRun = getLastRun(job);
            if (lastRun) {
                // Go back 1 day from last run for safety overlap
                const d = new Date(lastRun);
                d.setDate(d.getDate() - 1);
                return d.toISOString().split('T')[0];
            }
            // First run — go back 30 days
            const d = new Date();
            d.setDate(d.getDate() - 30);
            return d.toISOString().split('T')[0];
        }
        return arg;
    });
}

// ─── Run a job ───────────────────────────────────────────────────────
function runJob(jobName) {
    return new Promise((resolve) => {
        const config = JOBS[jobName];
        if (!config) {
            log(`Unknown job: ${jobName}`);
            resolve(false);
            return;
        }

        // Check API group lock
        if (isLocked(config.api_group)) {
            log(`⏭ ${jobName}: skipped — ${config.api_group} API is busy`);
            resolve(false);
            return;
        }

        // Acquire lock
        if (!acquireLock(config.api_group, jobName)) {
            log(`⏭ ${jobName}: could not acquire ${config.api_group} lock`);
            resolve(false);
            return;
        }

        const resolvedArgs = resolveArgs(jobName, config.args);
        const scriptPath = join(__dirname, config.script);

        log(`▶ ${jobName}: starting (${config.description})`);
        if (resolvedArgs.length) log(`  Args: ${resolvedArgs.join(' ')}`);

        const child = spawn('node', [scriptPath, ...resolvedArgs], {
            cwd: __dirname,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        });

        let output = '';
        child.stdout.on('data', d => { output += d.toString(); });
        child.stderr.on('data', d => { output += d.toString(); });

        child.on('close', (code) => {
            releaseLock(config.api_group);

            if (code === 0) {
                setLastRun(jobName);
                // Extract summary line
                const lines = output.trim().split('\n');
                const summary = lines.filter(l => l.includes('complete') || l.includes('Sync') || l.includes('Enrichment')).pop();
                log(`✅ ${jobName}: done${summary ? ' — ' + summary.replace(/\[.*?\]\s*/, '') : ''}`);
            } else {
                const lastLines = output.trim().split('\n').slice(-3).join(' | ');
                log(`❌ ${jobName}: exit ${code} — ${lastLines.slice(0, 200)}`);
            }
            resolve(code === 0);
        });

        // Timeout: kill if running > 90 minutes
        setTimeout(() => {
            try { child.kill('SIGTERM'); } catch {}
            log(`⏰ ${jobName}: killed after 90 minute timeout`);
        }, 90 * 60 * 1000);
    });
}

// ─── Commands ────────────────────────────────────────────────────────
if (args.includes('--list')) {
    console.log('\nSync Job Schedule:');
    console.log('─'.repeat(70));
    for (const [name, config] of Object.entries(JOBS)) {
        const lastRun = getLastRun(name);
        const due = isDue(name);
        const locked = isLocked(config.api_group);
        const lastRunStr = lastRun ? new Date(lastRun).toLocaleString() : 'never';
        console.log(`  ${due ? '🟢' : '⚪'} ${name.padEnd(25)} every ${String(config.interval_min).padStart(3)}min  last: ${lastRunStr}${locked ? ' 🔒' : ''}`);
    }
    console.log('');
    process.exit(0);
}

if (args.includes('--status')) {
    console.log('\nAPI Lock Status:');
    const groups = [...new Set(Object.values(JOBS).map(j => j.api_group))];
    for (const group of groups) {
        const lp = lockPath(group);
        if (existsSync(lp)) {
            const data = JSON.parse(readFileSync(lp, 'utf8'));
            const age = Math.round((Date.now() - data.started) / 60000);
            console.log(`  🔒 ${group}: locked by ${data.job} (PID ${data.pid}, ${age}min ago)`);
        } else {
            console.log(`  🔓 ${group}: available`);
        }
    }
    console.log('');
    process.exit(0);
}

// ─── Main: run specific job or all due jobs ──────────────────────────
async function main() {
    const specificJob = args.find((_, i) => args[i - 1] === '--job');

    if (specificJob) {
        await runJob(specificJob);
        return;
    }

    log('Cron check — scanning for due jobs...');

    // Priority order: run jobs from different API groups first (can run in parallel)
    // Then queue remaining jobs for their API group
    const dueJobs = Object.keys(JOBS).filter(isDue);

    if (dueJobs.length === 0) {
        log('No jobs due. Next check in 15 minutes.');
        return;
    }

    log(`Due jobs: ${dueJobs.join(', ')}`);

    // Group by API
    const byGroup = {};
    for (const job of dueJobs) {
        const group = JOBS[job].api_group;
        if (!byGroup[group]) byGroup[group] = [];
        byGroup[group].push(job);
    }

    // Run one job per API group concurrently, then next in queue
    const running = {};
    for (const [group, jobs] of Object.entries(byGroup)) {
        // Run first job in each group
        const job = jobs.shift();
        running[group] = runJob(job);
    }

    // Wait for first round
    await Promise.all(Object.values(running));

    // Run remaining queued jobs sequentially per group
    for (const [group, jobs] of Object.entries(byGroup)) {
        for (const job of jobs) {
            await runJob(job);
        }
    }

    log('Cron check complete.');
}

main().catch(e => { console.error(e); process.exit(1); });
